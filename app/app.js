/* app.js — Travel PWA */
(function () {
  const $ = s => document.querySelector(s);
  const view = $('#view'), tabs = $('#tabs'), titleEl = $('#title'), backBtn = $('#back'), tocBtn = $('#tocbtn');
  let DB = null;

  // ---------- data ----------
  // trips.json is either plain data or a password-encrypted envelope {enc:1,...} (see seal.py).
  // The derived key (not the password) is kept on this phone so the app works offline after one unlock.
  const KEY_STORE = 'trips-key';
  const ls = {
    get: k => { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { } },
    del: k => { try { localStorage.removeItem(k); } catch (_) { } },
  };
  const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const b64e = u => btoa(String.fromCharCode(...u));

  async function deriveKey(password, env) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64d(env.salt), iterations: env.iter }, base, 512);
    return new Uint8Array(bits);
  }
  async function openEnvelope(env, raw) {
    const iv = b64d(env.iv), ct = b64d(env.ct), mac = b64d(env.mac);
    const macKey = await crypto.subtle.importKey('raw', raw.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signed = new Uint8Array(iv.length + ct.length); signed.set(iv); signed.set(ct, iv.length);
    if (!await crypto.subtle.verify('HMAC', macKey, mac, signed)) throw new Error('wrong-key');
    const encKey = await crypto.subtle.importKey('raw', raw.slice(0, 32), { name: 'AES-CTR' }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: iv, length: 64 }, encKey, ct);
    return JSON.parse(new TextDecoder().decode(pt));
  }
  // data: URIs (attachments inside the encrypted payload) → blob: URLs so PDFs/images open normally
  function blobify(db) {
    const notes = db.general.concat(...db.trips.map(t => t.notes));
    for (const n of notes) for (const k in (n.attachments || {})) {
      const v = n.attachments[k];
      if (typeof v === 'string' && v.startsWith('data:')) {
        const [head, b64] = v.split(',');
        n.attachments[k] = URL.createObjectURL(new Blob([b64d(b64)], { type: head.slice(5, head.indexOf(';')) }));
      }
    }
    return db;
  }
  function askPassword(env, wrong) {
    return new Promise(resolve => {
      titleEl.textContent = 'Travel'; tabs.hidden = true; backBtn.hidden = true; tocBtn.hidden = true; $('#searchbtn').hidden = true;
      view.innerHTML = `<form class="lock" autocomplete="off">
        <div class="lockicon">🔒</div>
        <p>請輸入密碼開啟旅程資料<br><small>每支手機只需輸入一次，之後可離線使用</small></p>
        <input type="password" id="pw" placeholder="密碼" autocomplete="current-password" required>
        <button type="submit">解鎖</button>
        <p class="err" ${wrong ? '' : 'hidden'}>密碼不正確</p></form>`;
      const form = view.querySelector('form'), input = view.querySelector('#pw'), err = view.querySelector('.err');
      input.focus();
      form.onsubmit = async ev => {
        ev.preventDefault();
        const btn = form.querySelector('button'); btn.disabled = true; btn.textContent = '解鎖中…';
        try {
          const raw = await deriveKey(input.value, env);
          const db = await openEnvelope(env, raw);
          ls.set(KEY_STORE, JSON.stringify({ salt: env.salt, iter: env.iter, key: b64e(raw) }));
          resolve(db);
        } catch (e) {
          err.hidden = false; btn.disabled = false; btn.textContent = '解鎖'; input.select();
        }
      };
    });
  }
  async function decode(payload) {
    if (!payload || !payload.enc) return payload;              // not encrypted
    if (!(window.crypto && crypto.subtle)) throw new Error('此瀏覽器不支援解密（需 HTTPS）');
    let saved = null; try { saved = JSON.parse(ls.get(KEY_STORE) || 'null'); } catch (_) { }
    if (saved && saved.salt === payload.salt && saved.iter === payload.iter) {
      try { return await openEnvelope(payload, b64d(saved.key)); } catch (_) { ls.del(KEY_STORE); return askPassword(payload, true); }
    }
    return askPassword(payload, false);
  }

  async function loadData() {
    let raw = null;
    try {
      const r = await fetch('data/trips.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      raw = await r.text();
      ls.set('trips-cache', raw);                              // cached as received (still encrypted)
    } catch (e) {
      raw = ls.get('trips-cache');
      if (!raw) { view.innerHTML = `<div class="empty">無法載入資料（離線且尚無快取）<br><small>${e}</small></div>`; return false; }
    }
    try { DB = blobify(await decode(JSON.parse(raw))); $('#searchbtn').hidden = false; }
    catch (e) { view.innerHTML = `<div class="empty">無法開啟資料<br><small>${e.message || e}</small></div>`; return false; }
    return true;
  }
  let lockArmed = false;
  function confirmLock() {
    if (lockArmed) return true;
    lockArmed = true; toast('再按一次「鎖定此裝置」確認（需重新輸入密碼）'); setTimeout(() => { lockArmed = false; }, 4000);
    return false;
  }
  function lockDevice() { ls.del(KEY_STORE); ls.del('trips-cache'); location.hash = ''; location.reload(); }

  // ---------- date helpers ----------
  const DAY = 86400000;
  const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
  const parseD = s => { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtD = s => { const d = parseD(s); if (!d) return ''; return `${d.getMonth() + 1}/${d.getDate()}`; };
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  const fmtLong = s => { const d = parseD(s); if (!d) return ''; return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };
  function tripPhase(t) {
    const now = today();
    const s = parseD(t.start) || parseD(t.ym + '-01');
    const e = parseD(t.end) || (parseD(t.start) ? new Date(s.getTime() + 10 * DAY) : new Date(s.getFullYear(), s.getMonth() + 1, 0));
    const ds = Math.round((s - now) / DAY);
    if (now < s) return { phase: 'upcoming', days: ds, label: t.start ? `D-${ds}` : `${t.ym.replace('-', '/')} 待定` };
    if (now <= e) return { phase: 'live', days: Math.round((now - s) / DAY) + 1, label: `進行中 D${Math.round((now - s) / DAY) + 1}` };
    return { phase: 'past', days: Math.round((now - e) / DAY), label: '已結束' };
  }

  // ---------- routing ----------
  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, qs] = h.split('?');
    const p = path.split('/').filter(Boolean);
    closeToc();
    if (!DB) return;
    if (p[0] === 't' && p[1]) return renderTrip(decodeURIComponent(p[1]), p[2] != null ? +p[2] : null);
    if (p[0] === 'g' && p[1] != null) return renderGeneral(+p[1]);
    if (p[0] === 's') return renderSearch(new URLSearchParams(qs || '').get('q') || '');
    renderHome();
  }
  window.addEventListener('hashchange', route);
  backBtn.onclick = () => { if (history.length > 1) history.back(); else location.hash = '#/'; };
  $('#searchbtn').onclick = () => { location.hash = '#/s'; };

  function setChrome({ title, back, tabsHtml, toc }) {
    titleEl.textContent = title;
    backBtn.hidden = !back;
    tabs.hidden = !tabsHtml; tabs.innerHTML = tabsHtml || '';
    tocBtn.hidden = !toc;
    document.title = title === 'Travel' ? 'Travel' : `${title} · Travel`;
  }

  // ---------- home ----------
  function renderHome() {
    setChrome({ title: 'Travel', back: false });
    const groups = { live: [], upcoming: [], past: [] };
    for (const t of DB.trips) groups[tripPhase(t).phase].push(t);
    groups.past.reverse();
    let h = '';
    const card = (t, cls = '') => {
      const ph = tripPhase(t);
      const dates = (t.start ? `${fmtLong(t.start)} → ${t.end ? fmtLong(t.end) : '?'}` : `${t.ym.replace('-', '/')}`) + (t.inferred ? ' <span class="small">(推定)</span>' : '');
      const n = t.notes.length;
      return `<a class="card ${cls} ${ph.phase}" href="#/t/${encodeURIComponent(t.id)}">
        <div class="row"><div class="name">${esc(t.name.replace(/_/g, ' '))}</div><div class="count ${ph.phase === 'live' ? 'live' : ''}">${ph.label}</div></div>
        <div class="meta"><span>${dates}</span>${t.status ? `<span class="status">${esc(t.status)}</span>` : ''}<span>${n} 則筆記</span></div>
      </a>`;
    };
    if (groups.live.length) { h += '<div class="section-title">進行中</div>' + groups.live.map(t => card(t, 'hero')).join(''); }
    if (groups.upcoming.length) {
      h += '<div class="section-title">即將出發</div>';
      h += groups.upcoming.map((t, i) => card(t, i === 0 && !groups.live.length ? 'hero' : '')).join('');
    }
    if (!groups.live.length && !groups.upcoming.length) h += '<div class="empty">目前沒有即將出發的旅程</div>';
    if (DB.general.length) {
      h += '<div class="section-title">通用資訊</div>';
      h += DB.general.map((n, i) => `<a class="card" href="#/g/${i}"><div class="row"><div class="name" style="font-size:15px;font-weight:600">${esc(n.title)}</div></div></a>`).join('');
    }
    if (groups.past.length) {
      h += `<details class="past-list"><summary>過去的旅程（${groups.past.length}）</summary>` + groups.past.map(t => card(t)).join('') + '</details>';
    }
    h += `<div class="updated">資料版本 ${DB.generated}${navigator.onLine ? '' : ' · 離線'}${ls.get(KEY_STORE) ? ' · <a href="#" id="lockbtn">🔒 鎖定此裝置</a>' : ''}</div>`;
    view.innerHTML = h;
    const lb = $('#lockbtn'); if (lb) lb.onclick = e => { e.preventDefault(); if (confirmLock()) lockDevice(); };
    window.scrollTo(0, 0);
  }

  // ---------- trip ----------
  function renderTrip(id, noteIdx) {
    const t = DB.trips.find(x => x.id === id);
    if (!t) { view.innerHTML = '<div class="empty">找不到這趟旅程</div>'; return; }
    if (noteIdx == null) {
      // default: itinerary note, else first
      let i = t.notes.findIndex(n => n.type === 'itinerary'); if (i < 0) i = t.notes.findIndex(n => /行程/.test(n.file)); if (i < 0) i = 0;
      const remembered = +sessionStorage.getItem('tab:' + id);
      if (!isNaN(remembered) && sessionStorage.getItem('tab:' + id) !== null) i = remembered;
      return location.replace(`#/t/${encodeURIComponent(id)}/${i}`);
    }
    sessionStorage.setItem('tab:' + id, noteIdx);
    const ph = tripPhase(t);
    const tabsHtml = t.notes.map((n, i) => `<button data-i="${i}" class="${i === noteIdx ? 'active' : ''}">${esc(shortTitle(n))}</button>`).join('');
    setChrome({ title: `${t.name.replace(/_/g, ' ')} · ${ph.label}`, back: true, tabsHtml, toc: true });
    tabs.querySelectorAll('button').forEach(b => b.onclick = () => { location.hash = `#/t/${encodeURIComponent(id)}/${b.dataset.i}`; });
    const active = tabs.querySelector('button.active'); if (active) active.scrollIntoView({ inline: 'center', block: 'nearest' });
    const note = t.notes[noteIdx];
    if (!note) { view.innerHTML = '<div class="empty">沒有這則筆記</div>'; return; }
    renderNote(note, t, ph);
  }

  function shortTitle(n) {
    // strip leading numbering "01.1 " and trailing " - xxx"; prefer filename stem for tab (concise)
    return n.stem.replace(/^\d+(\.\d+)?\s*[_\-．.]?\s*/, '').replace(/^行程規劃[．.]/, '行程．').slice(0, 22);
  }

  function taskKey(t, note) { return `task:${t ? t.id : '_general'}/${note.file}`; }
  function loadTaskState(t, note) {
    try {
      const raw = JSON.parse(localStorage.getItem(taskKey(t, note)) || 'null');
      if (raw && raw.mtime === note.mtime) return raw.state;
    } catch (e) { }
    return {};
  }
  function saveTaskState(t, note, state) {
    try { localStorage.setItem(taskKey(t, note), JSON.stringify({ mtime: note.mtime, state })); } catch (_) { }
  }

  function renderNote(note, trip, ph) {
    const noteLinks = {};
    if (trip) trip.notes.forEach((n, i) => { noteLinks[n.stem] = `#/t/${encodeURIComponent(trip.id)}/${i}`; });
    DB.general.forEach((n, i) => { noteLinks[n.stem] = noteLinks[n.stem] || `#/g/${i}`; });
    const taskState = loadTaskState(trip, note);
    const ctx = { attachments: note.attachments || {}, noteLinks, taskState };
    let html = MD.render(note.body, ctx);
    // frontmatter chips (only useful keys)
    const fmKeys = ['status', 'depart', 'return', 'start_date', 'end_date', 'price', 'party', 'tour', 'destination'];
    const chips = fmKeys.filter(k => note.fm[k] != null && note.fm[k] !== '').map(k => `<span><b>${k}</b> ${esc(String(note.fm[k]))}</span>`);
    const localCount = Object.keys(taskState).length;
    view.innerHTML = `<article class="note">${chips.length ? `<div class="fm">${chips.join('')}</div>` : ''}${html}
      ${localCount ? `<p class="small">本機勾選 ${localCount} 項（僅存在此裝置；筆記在 Obsidian 更新後會重設） <button class="iconbtn" style="font-size:13px;width:auto;height:auto;padding:2px 8px;border:1px solid var(--line)" id="cleartasks">清除</button></p>` : ''}
    </article>
    <div class="updated">${note.file} · 更新 ${new Date(note.mtime * 1000).toLocaleDateString('zh-TW')}</div>`;
    // task checkboxes
    view.querySelectorAll('input[data-task]').forEach(cb => {
      cb.addEventListener('change', () => {
        const st = loadTaskState(trip, note);
        st[cb.dataset.task] = cb.checked;
        saveTaskState(trip, note, st);
        cb.closest('li').classList.toggle('done', cb.checked);
      });
    });
    const clr = $('#cleartasks'); if (clr) clr.onclick = () => { try { localStorage.removeItem(taskKey(trip, note)); } catch (_) { } route(); };
    // TOC
    buildToc(ctx.headings);
    // "today" jump for itinerary
    window.scrollTo(0, 0);
    if (trip && ph && ph.phase === 'live' && trip.start) {
      const dayN = ph.days;
      const re = new RegExp(`^(D|Day\\s*)${dayN}(?!\\d)`, 'i');
      const target = ctx.headings.find(h => re.test(h.text));
      if (target) {
        const el = document.getElementById(target.id);
        if (el) { el.classList.add('today'); setTimeout(() => el.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60); }
      }
    }
  }

  function renderGeneral(i) {
    const n = DB.general[i];
    if (!n) { view.innerHTML = '<div class="empty">找不到筆記</div>'; return; }
    setChrome({ title: n.title, back: true, toc: true });
    renderNote(n, null, null);
  }

  // ---------- TOC ----------
  function buildToc(headings) {
    const list = $('#toclist');
    const hs = headings.filter(h => h.level >= 2 && h.level <= 4);
    list.innerHTML = hs.length ? hs.map(h => `<a class="l${h.level}" href="javascript:void 0" data-id="${h.id}">${esc(h.text)}</a>`).join('') : '<div class="empty small">沒有標題</div>';
    list.querySelectorAll('a').forEach(a => a.onclick = () => {
      closeToc();
      const el = document.getElementById(a.dataset.id);
      if (el) { const y = el.getBoundingClientRect().top + window.scrollY - 110; window.scrollTo({ top: y, behavior: 'smooth' }); }
    });
    tocBtn.hidden = false;
  }
  tocBtn.onclick = () => { $('#tocpanel').hidden = false; };
  $('#tocclose').onclick = closeToc;
  $('#tocpanel').addEventListener('click', e => { if (e.target.id === 'tocpanel') closeToc(); });
  function closeToc() { $('#tocpanel').hidden = true; }

  // ---------- search ----------
  function renderSearch(q) {
    setChrome({ title: '搜尋', back: true });
    view.innerHTML = `<div class="searchbox"><input id="q" type="search" placeholder="搜尋所有旅程筆記…" value="${esc(q)}" autocomplete="off"></div><div id="hits"></div>`;
    const input = $('#q'), hits = $('#hits');
    const run = () => {
      const s = input.value.trim(); const lower = s.toLowerCase();
      if (s.length < 2) { hits.innerHTML = '<div class="empty small">輸入至少 2 個字</div>'; return; }
      const res = [];
      const scan = (note, where, href) => {
        const body = note.body.replace(/^---[\s\S]*?\n---\n/, '').replace(/[*_=~`#>|]+/g, ' ').replace(/!?\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (m, a, b, c) => c || a).replace(/\s+/g, ' ');
        let idx = body.toLowerCase().indexOf(lower); let n = 0;
        while (idx >= 0 && n < 3) {
          const a = Math.max(0, idx - 40), b = Math.min(body.length, idx + s.length + 60);
          let snip = body.slice(a, b).replace(/\n+/g, ' ');
          snip = esc(snip).replace(new RegExp(escRe(esc(s)), 'ig'), m => `<mark>${m}</mark>`);
          res.push({ where, title: note.title, snip, href });
          idx = body.toLowerCase().indexOf(lower, idx + s.length); n++;
        }
      };
      [...DB.trips].reverse().forEach(t => t.notes.forEach((n, i) => scan(n, t.name, `#/t/${encodeURIComponent(t.id)}/${i}`)));
      DB.general.forEach((n, i) => scan(n, '通用', `#/g/${i}`));
      hits.innerHTML = res.length ? res.slice(0, 80).map(r => `<a class="hit" href="${r.href}"><div class="where">${esc(r.where)} › ${esc(r.title)}</div><div class="snip">…${r.snip}…</div></a>`).join('')
        : '<div class="empty small">沒有結果</div>';
      history.replaceState(null, '', `#/s?q=${encodeURIComponent(s)}`);
    };
    input.addEventListener('input', debounce(run, 200));
    if (q) run(); else input.focus();
  }

  // ---------- utils ----------
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function debounce(f, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; }
  function toast(msg, action, fn) {
    const el = $('#toast'); el.innerHTML = esc(msg) + (action ? `<button>${esc(action)}</button>` : ''); el.hidden = false;
    if (action) el.querySelector('button').onclick = fn;
    if (!action) setTimeout(() => { el.hidden = true; }, 3000);
  }

  // ---------- service worker ----------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw && nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('有新版本', '更新', () => { nw.postMessage('skipWaiting'); });
          }
        });
      });
      // check for updates when app comes to foreground
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update(); });
    }).catch(() => { });
    // reload only when an update takes over — not on the very first install (would wipe the password box)
    const hadController = !!navigator.serviceWorker.controller;
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !refreshing) { refreshing = true; location.reload(); } });
  }
  window.addEventListener('online', () => loadData().then(route));

  // ---------- boot ----------
  loadData().then(ok => { if (ok) route(); });
})();
