/* md.js — small Obsidian-flavoured Markdown → HTML renderer.
   Supports: headings, paragraphs, hard line breaks, bold/italic/strike/highlight/code,
   links, autolinks, wikilinks, embeds (images/pdf), lists (nested, ordered, tasks),
   blockquotes + Obsidian callouts, tables, fenced code, horizontal rules.
   ctx = { attachments: {name -> url|null}, noteLinks: {stem -> href}, taskState: {idx -> bool} }
*/
(function (global) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const CALLOUT_ICON = {
    note: '✎', info: 'ⓘ', tip: '💡', hint: '💡', important: '❗', warning: '⚠️', caution: '⚠️',
    danger: '🚫', error: '🚫', bug: '🐞', success: '✅', check: '✅', done: '✅', question: '❓',
    help: '❓', faq: '❓', example: '📎', quote: '❝', cite: '❝', abstract: '📄', summary: '📄', tldr: '📄',
    todo: '☑︎', failure: '✗', fail: '✗', missing: '✗'
  };

  function render(src, ctx) {
    ctx = ctx || {};
    ctx.attachments = ctx.attachments || {};
    ctx.taskState = ctx.taskState || {};
    ctx._task = 0;
    ctx.headings = [];
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    return blocks(lines, ctx);
  }

  function blocks(lines, ctx) {
    let out = [], i = 0;
    while (i < lines.length) {
      let line = lines[i];
      // blank
      if (!line.trim()) { i++; continue; }
      // fenced code
      let m = line.match(/^\s*(```|~~~)\s*(\w+)?/);
      if (m) {
        const fence = m[1]; let j = i + 1, buf = [];
        while (j < lines.length && !lines[j].trim().startsWith(fence)) { buf.push(lines[j]); j++; }
        out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
        i = j + 1; continue;
      }
      // hr
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*⸻\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      // heading (allow escaped \#)
      m = line.match(/^\s*\\?(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (m) {
        const lvl = m[1].length, txt = m[2];
        const id = 'h' + ctx.headings.length;
        ctx.headings.push({ level: lvl, text: stripInline(txt), id });
        out.push(`<h${lvl} id="${id}">${inline(txt, ctx)}</h${lvl}>`);
        i++; continue;
      }
      // table
      if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        let j = i, rows = [];
        while (j < lines.length && /^\s*\|/.test(lines[j])) { rows.push(lines[j]); j++; }
        out.push(table(rows, ctx)); i = j; continue;
      }
      // blockquote / callout
      if (/^\s*>/.test(line)) {
        let j = i, buf = [];
        while (j < lines.length && (/^\s*>/.test(lines[j]) )) { buf.push(lines[j].replace(/^\s*>\s?/, '')); j++; }
        out.push(quote(buf, ctx)); i = j; continue;
      }
      // list
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        let j = i, buf = [];
        while (j < lines.length) {
          const l = lines[j];
          if (!l.trim()) { // blank: continue list only if next non-blank is indented or list item
            let k = j + 1; while (k < lines.length && !lines[k].trim()) k++;
            if (k < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[k]) || /^\s{2,}/.test(lines[k]))) { buf.push(''); j++; continue; }
            break;
          }
          if (/^\s*([-*+]|\d+[.)])\s+/.test(l) || /^\s{2,}\S/.test(l) || /^\t/.test(l)) { buf.push(l); j++; continue; }
          break;
        }
        out.push(list(buf, ctx)); i = j; continue;
      }
      // paragraph
      let j = i, buf = [];
      while (j < lines.length && lines[j].trim() &&
        !/^\s*(#{1,6}\s|\\#|>|```|~~~|\|)/.test(lines[j]) &&
        !/^\s*([-*+]|\d+[.)])\s+/.test(lines[j]) &&
        !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[j])) { buf.push(lines[j]); j++; }
      if (!buf.length) { buf.push(lines[i]); j = i + 1; }
      // standalone embed → figure
      const single = buf.length === 1 && buf[0].trim().match(/^!\[\[([^\]]+)\]\]$/);
      if (single) { out.push(embed(single[1], ctx)); i = j; continue; }
      out.push('<p>' + buf.map(l => inline(l.replace(/\s+$/, ''), ctx)).join('<br>') + '</p>');
      i = j;
    }
    return out.join('\n');
  }

  function table(rows, ctx) {
    const cells = r => {
      let s = r.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|')) s = s.slice(0, -1);
      // split on | not escaped
      return s.split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim());
    };
    const head = cells(rows[0]);
    const align = cells(rows[1]).map(a => /^:-+:$/.test(a) ? 'center' : /-+:$/.test(a) ? 'right' : '');
    let h = '<div class="tbl"><table><thead><tr>' + head.map((c, k) => `<th${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c, ctx)}</th>`).join('') + '</tr></thead><tbody>';
    for (let r = 2; r < rows.length; r++) {
      const cs = cells(rows[r]); if (cs.every(c => !c)) continue;
      h += '<tr>' + cs.map((c, k) => `<td${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c, ctx)}</td>`).join('') + '</tr>';
    }
    return h + '</tbody></table></div>';
  }

  function quote(buf, ctx) {
    const m = buf[0].match(/^\[!([\w-]+)\]([+-]?)\s*(.*)$/i);
    if (m) {
      const type = m[1].toLowerCase(), fold = m[2], title = m[3] || (type[0].toUpperCase() + type.slice(1));
      const body = blocks(buf.slice(1), ctx);
      const icon = CALLOUT_ICON[type] || 'ⓘ';
      if (fold) {
        return `<details class="callout callout-${type}"${fold === '+' ? ' open' : ''}><summary><span class="ci">${icon}</span>${inline(title, ctx)}</summary><div class="cb">${body}</div></details>`;
      }
      return `<div class="callout callout-${type}"><div class="ct"><span class="ci">${icon}</span>${inline(title, ctx)}</div>${body ? `<div class="cb">${body}</div>` : ''}</div>`;
    }
    return `<blockquote>${blocks(buf, ctx)}</blockquote>`;
  }

  function list(buf, ctx) {
    // build tree by indentation
    const items = []; // {indent, ordered, text, children:[]}
    const stack = [{ indent: -1, children: items }];
    let last = null;
    for (const raw of buf) {
      if (!raw.trim()) { if (last) last.text += '\n'; continue; }
      const m = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (m) {
        const indent = m[1].replace(/\t/g, '    ').length;
        const it = { indent, ordered: /\d/.test(m[2]), text: m[3], children: [] };
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
        stack[stack.length - 1].children.push(it);
        stack.push(it); last = it;
      } else if (last) {
        last.text += '\n' + raw.trim();
      }
    }
    return renderList(items, ctx);
  }

  function renderList(items, ctx) {
    if (!items.length) return '';
    const ordered = items[0].ordered;
    let h = ordered ? '<ol>' : '<ul>';
    for (const it of items) {
      const tm = it.text.match(/^\[( |x|X|-|\/)\]\s*(.*)$/s);
      const lines = (tm ? tm[2] : it.text).split('\n');
      const first = lines.shift();
      let inner = inline(first, ctx);
      // continuation lines: might contain nested block content (rare) → treat as <br>
      const rest = lines.filter(l => l.trim()).map(l => inline(l, ctx)).join('<br>');
      if (rest) inner += '<br>' + rest;
      if (tm) {
        const idx = ctx._task++;
        const srcChecked = tm[1] !== ' ';
        const checked = (idx in ctx.taskState) ? ctx.taskState[idx] : srcChecked;
        h += `<li class="task${checked ? ' done' : ''}"><label><input type="checkbox" data-task="${idx}"${checked ? ' checked' : ''}><span>${inner}</span></label>${renderList(it.children, ctx)}</li>`;
      } else {
        h += `<li>${inner}${renderList(it.children, ctx)}</li>`;
      }
    }
    return h + (ordered ? '</ol>' : '</ul>');
  }

  function embed(target, ctx) {
    const [nameRaw, alias] = target.split('|');
    const name = nameRaw.split('#')[0].trim();
    const url = ctx.attachments[name] !== undefined ? ctx.attachments[name] : ctx.attachments[nameRaw];
    const ext = (name.match(/\.(\w+)$/) || [, ''])[1].toLowerCase();
    if (url === null) return `<div class="att missing">📎 ${esc(name)} <small>（檔案過大，未打包）</small></div>`;
    if (!url) return `<div class="att missing">📎 ${esc(name)} <small>（找不到附件）</small></div>`;
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
      return `<figure><img loading="lazy" src="${esc(url)}" alt="${esc(alias || name)}"><figcaption>${esc(alias || name)}</figcaption></figure>`;
    }
    if (ext === 'heic') return `<div class="att">📷 <a href="${esc(url)}" target="_blank" rel="noopener">${esc(alias || name)}</a> <small>(HEIC)</small></div>`;
    return `<div class="att"><a href="${esc(url)}" target="_blank" rel="noopener">📄 ${esc(alias || name)}</a></div>`;
  }

  function stripInline(s) {
    return s.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (m, a, b, c) => c || a)
      .replace(/[*_~=`]+/g, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
  }

  function inline(s, ctx) {
    // protect code spans
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
    s = esc(s);
    // embeds ![[x]]
    s = s.replace(/!\[\[([^\]]+)\]\]/g, (m, t) => embed(t.replace(/&quot;/g, '"'), ctx));
    // wikilinks [[x|alias]]
    s = s.replace(/\[\[([^\]|#]+)(#[^\]|]*)?(\|([^\]]+))?\]\]/g, (m, target, hash, _, alias) => {
      const t = target.trim(); const label = alias || t;
      const att = ctx.attachments[t] ?? ctx.attachments[t + (hash || '')];
      if (att) return `<a class="att-link" href="${esc(att)}" target="_blank" rel="noopener">📎 ${label}</a>`;
      if (att === null) return `<span class="wl missing" title="檔案過大，未打包">📎 ${label}</span>`;
      const stem = t.replace(/\.md$/, '').split('/').pop();
      const href = ctx.noteLinks && ctx.noteLinks[stem];
      if (href) return `<a class="wl" href="${href}">${label}</a>`;
      return `<span class="wl">${label}</span>`;
    });
    // images ![alt](url)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<img loading="lazy" src="$2" alt="$1">');
    // links [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, t, u) => `<a href="${u}" ${/^https?:/.test(u) ? 'target="_blank" rel="noopener"' : ''}>${t}</a>`);
    // autolinks
    s = s.replace(/(^|[^"'>=\]\w])(https?:\/\/[^\s<]+[^\s<.,;:)。，、）」])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    // bold / italic / strike / highlight
    s = s.replace(/\*\*\*\*(.+?)\*\*\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
    s = s.replace(/==(.+?)==/g, '<mark>$1</mark>');
    // escaped chars
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, '$1');
    // restore code
    s = s.replace(/\u0000(\d+)\u0000/g, (m, k) => codes[+k]);
    return s;
  }

  global.MD = { render, stripInline };
})(window);
