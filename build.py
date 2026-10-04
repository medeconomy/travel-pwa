#!/usr/bin/env python3
"""
build.py — turn AIObsi/Travel/ into app/data/ for the Travel PWA.

Usage:
    python3 build.py                # uses default vault path
    python3 build.py --vault /path/to/AIObsi/Travel
    python3 build.py --max-attach-mb 8

No third-party dependencies (stdlib only).
"""
import argparse, fnmatch, json, os, re, shutil, sys, time, hashlib
from pathlib import Path

DEFAULT_VAULT = Path.home() / "Obsidian" / "AIObsi" / "60_Travel"
ROOT = Path(__file__).resolve().parent
APP = ROOT / "app"
DATA = APP / "data"
ATT = DATA / "att"

CONFIG = ROOT / "publish.json"   # which trips go online + what stays private (see README)
TRIP_DIR_RE = re.compile(r"^(\d{4})(\d{2})_(.+)$")
SKIP_NAMES = {".DS_Store", "Template - Packing List.md"}
ATTACH_LINK_RE = re.compile(r"!?\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")
IMG_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".svg"}
DOC_EXT = {".pdf"}


# ---------- frontmatter (tiny YAML subset: scalars, inline lists, block lists) ----------
def parse_frontmatter(text):
    if not text.startswith("---"):
        return {}, text
    lines = text.split("\n")
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return {}, text
    fm, key = {}, None
    for raw in lines[1:end]:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if re.match(r"^\s+-\s+", raw) and key:
            fm.setdefault(key, [])
            if not isinstance(fm[key], list):
                fm[key] = []
            fm[key].append(_scalar(raw.split("-", 1)[1]))
            continue
        m = re.match(r"^([A-Za-z0-9_\-一-鿿 ]+?)\s*:\s*(.*)$", raw)
        if m:
            key, val = m.group(1).strip(), m.group(2).strip()
            if val == "":
                fm[key] = None
            elif val.startswith("[") and val.endswith("]"):
                fm[key] = [_scalar(v) for v in val[1:-1].split(",") if v.strip()]
            else:
                fm[key] = _scalar(val)
    return fm, "\n".join(lines[end + 1:])


def _scalar(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    return v


# ---------- helpers ----------
def norm_date(v):
    """Return YYYY-MM-DD or None."""
    if not v:
        return None
    s = str(v).strip()
    m = re.match(r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", s)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return None


def first_heading(body):
    for line in body.split("\n"):
        m = re.match(r"^\s*\\?#\s+(.+?)\s*$", line)
        if m:
            return m.group(1).strip()
    return None


def rel_path_for(name, trip_dir):
    """Resolve an Obsidian [[link]] target to a real file inside the trip dir (or vault root)."""
    name = name.strip()
    cands = [trip_dir / name, trip_dir / "Attachments" / name]
    # Obsidian also matches by bare filename anywhere in the trip folder
    if "/" not in name:
        for p in trip_dir.rglob(name):
            cands.append(p)
    # try with common extensions if none given
    if not Path(name).suffix:
        for ext in IMG_EXT | DOC_EXT:
            cands += [trip_dir / (name + ext), trip_dir / "Attachments" / (name + ext)]
    for c in cands:
        if c.is_file():
            return c
    return None


DATE_RE = re.compile(r"(?<!\d)(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})(?!\d)")
COMPACT_RANGE_RE = re.compile(r"(?<!\d)(\d{4})(\d{2})(\d{2})[-–~](\d{2})(\d{2})(?!\d)")


def infer_dates(yyyy, mm, notes):
    """Fallback for trips without frontmatter dates: collect dates in the trip's month (±1)
    from note filenames + bodies; start = earliest, end = latest within 30 days after start."""
    import datetime as dt
    y, m = int(yyyy), int(mm)
    anchor = dt.date(y, m, 1)
    lo = anchor - dt.timedelta(days=15)
    hi = (anchor + dt.timedelta(days=45))
    found = set()
    # pass 1: explicit range on one line, in itinerary-like notes first
    RANGE_RE = re.compile(
        r"(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?\s*(?:\([^)]*\)|（[^）]*）)?\s*[~～–—\-到至→]+\s*(?:(\d{4})[/.\-年])?(\d{1,2})[/.\-月](\d{1,2})")
    ordered = sorted(notes, key=lambda n: (0 if re.search(r"行程|總表|Plan|itinerary|index", n["file"], re.I) else 1, n["file"]))
    for n in ordered:
        for line in (n["file"] + "\n" + n["body"]).split("\n")[:80]:
            for a, b, c, a2, b2, c2 in RANGE_RE.findall(line):
                try:
                    s = dt.date(int(a), int(b), int(c))
                    e_ = dt.date(int(a2 or a), int(b2), int(c2))
                except ValueError:
                    continue
                if lo <= s <= hi and s <= e_ <= s + dt.timedelta(days=45):
                    return s.isoformat(), e_.isoformat()
    for n in notes:
        text = n["file"] + "\n" + n["body"]
        for a, b, c, d, e in COMPACT_RANGE_RE.findall(text):
            try:
                s = dt.date(int(a), int(b), int(c)); e_ = dt.date(int(a), int(d), int(e))
                if lo <= s <= hi:
                    return s.isoformat(), e_.isoformat()
            except ValueError:
                pass
        for a, b, c in DATE_RE.findall(text):
            try:
                d = dt.date(int(a), int(b), int(c))
            except ValueError:
                continue
            if lo <= d <= hi:
                found.add(d)
    if not found:
        return None, None
    start = min(found)
    end = max(d for d in found if d <= start + dt.timedelta(days=30))
    return start.isoformat(), (end.isoformat() if end != start else None)


def sha_short(p: Path):
    h = hashlib.sha1()
    h.update(str(p.stat().st_size).encode())
    h.update(str(int(p.stat().st_mtime)).encode())
    h.update(p.name.encode("utf-8"))
    return h.hexdigest()[:8]


# ---------- privacy ----------
LOCAL_CONFIG = ROOT / "publish.local.json"   # gitignored: secret strings to redact (never pushed)


def ensure_salt():
    """Create a fixed salt once (kept in publish.local.json) so phones that already
    unlocked keep working after every rebuild."""
    import base64
    local = json.loads(LOCAL_CONFIG.read_text(encoding="utf-8")) if LOCAL_CONFIG.exists() else {}
    salt = os.urandom(16)
    local["salt"] = base64.b64encode(salt).decode()
    LOCAL_CONFIG.write_text(json.dumps(local, ensure_ascii=False, indent=2), encoding="utf-8")
    return salt


def load_config():
    cfg = json.loads(CONFIG.read_text(encoding="utf-8")) if CONFIG.exists() else {}
    if LOCAL_CONFIG.exists():
        local = json.loads(LOCAL_CONFIG.read_text(encoding="utf-8"))
        for k in ("redact", "exclude"):
            cfg[k] = cfg.get(k, []) + local.get(k, [])
        for k in ("password", "salt", "trips"):
            if local.get(k):
                cfg[k] = local[k]
    return cfg


TRUE = ("true", "yes", "1")
FALSE = ("false", "no", "0")


def is_private(md_path: Path, fm: dict, patterns, opt_in=True):
    """Decide whether a note stays off the public site.
    The note's own mark wins:  pwa: true → published,  pwa: false (or private: true) → private.
    Unmarked notes: private when opt_in (default), otherwise private only if the filename
    matches an exclude pattern."""
    if str(fm.get("private", "")).lower() in TRUE:
        return True
    flag = str(fm.get("pwa", fm.get("publish", ""))).lower()
    if flag in TRUE:
        return False
    if flag in FALSE:
        return True
    if any(fnmatch.fnmatch(md_path.name, pat) or fnmatch.fnmatch(md_path.stem, pat) for pat in patterns):
        return True
    return opt_in


WIKILINK_RE = re.compile(r"!?\[\[([^\]|#]+?)(#[^\]|]*)?(?:\|([^\]]*))?\]\]")


def unlink_private(body, hidden_stems):
    """Turn [[links]] to private notes into plain text so nothing points at them."""
    def sub(m):
        target = Path(m.group(1).strip().rstrip("\\")).name   # "\|" inside tables
        stem = target[:-3] if target.lower().endswith(".md") else target
        if stem in hidden_stems:
            return (m.group(3) or stem) + " 🔒"
        return m.group(0)
    return WIKILINK_RE.sub(sub, body)


# ---------- main ----------
def build(vault: Path, max_attach_mb: float, only=None):
    if not vault.is_dir():
        sys.exit(f"Vault travel dir not found: {vault}")
    cfg = load_config()
    patterns = cfg.get("exclude", [])
    opt_in = cfg.get("mode", "opt-in") != "opt-out"
    redact = [re.compile(r) for r in cfg.get("redact", [])]
    hidden = []   # (trip_id or "_general", filename)

    if ATT.exists():
        shutil.rmtree(ATT)
    ATT.mkdir(parents=True, exist_ok=True)

    trips, general = [], []
    skipped = []
    precache = []

    def load_note(md_path: Path, trip_dir: Path | None, trip_id: str | None):
        text = md_path.read_text(encoding="utf-8", errors="replace")
        fm, body = parse_frontmatter(text)
        if is_private(md_path, fm, patterns, opt_in):
            hidden.append((trip_id or "_general", md_path.name))
            return None
        for rx in redact:
            body = rx.sub("‹已隱藏›", body)
        title = fm.get("title") or first_heading(body) or md_path.stem
        attachments = {}
        if trip_dir is not None:
            for m in ATTACH_LINK_RE.finditer(body):
                target = m.group(1)
                if target.lower().endswith(".md") or Path(target).suffix == "":
                    # note link (or maybe extension-less attachment) — try resolve only if it's a file
                    real = rel_path_for(target, trip_dir)
                    if real is None or real.suffix.lower() == ".md":
                        continue
                else:
                    real = rel_path_for(target, trip_dir)
                if real is None:
                    continue
                size_mb = real.stat().st_size / 1e6
                key = target
                if size_mb > max_attach_mb:
                    skipped.append((trip_id, real.name, f"{size_mb:.1f}MB"))
                    attachments[key] = None
                    continue
                dest_dir = ATT / trip_id
                dest_dir.mkdir(parents=True, exist_ok=True)
                dest_name = f"{sha_short(real)}_{real.name}"
                dest = dest_dir / dest_name
                if not dest.exists():
                    shutil.copy2(real, dest)
                rel = f"data/att/{trip_id}/{dest_name}"
                attachments[key] = rel
                precache.append(rel)
        return {
            "file": md_path.name,
            "stem": md_path.stem,
            "title": str(title),
            "type": fm.get("type"),
            "status": fm.get("status"),
            "fm": {k: v for k, v in fm.items() if v is not None},
            "body": body.strip("\n"),
            "attachments": attachments,
            "mtime": int(md_path.stat().st_mtime),
        }

    for entry in sorted(vault.iterdir()):
        if entry.name in SKIP_NAMES or entry.name.startswith("."):
            continue
        if entry.is_file() and entry.suffix == ".md":
            n = load_note(entry, None, None)
            if n:
                general.append(n)
            continue
        if not entry.is_dir():
            continue
        m = TRIP_DIR_RE.match(entry.name)
        if not m:
            continue
        if only and entry.name not in only:
            continue
        yyyy, mm, name = m.groups()
        trip_id = entry.name
        notes = []
        for md in sorted(entry.glob("*.md")):
            if md.name in SKIP_NAMES:
                continue
            n = load_note(md, entry, trip_id)
            if n:
                notes.append(n)
        # trip-level dates: from any note's frontmatter
        start = end = status = None
        for n in notes:
            fm = n["fm"]
            start = start or norm_date(fm.get("depart") or fm.get("start_date") or fm.get("start"))
            end = end or norm_date(fm.get("return") or fm.get("end_date") or fm.get("end"))
            if n.get("type") == "itinerary" and fm.get("status"):
                status = fm.get("status")
        inferred = False
        if not start:
            start, end = infer_dates(yyyy, mm, notes)
            inferred = bool(start)
        trips.append({
            "id": trip_id,
            "name": name.strip(),
            "ym": f"{yyyy}-{mm}",
            "start": start,
            "end": end,
            "inferred": inferred,
            "status": status,
            "notes": notes,
        })

    # strip links that point at private notes
    hidden_stems = {Path(f).stem for _, f in hidden}
    for n in general + [n for t in trips for n in t["notes"]]:
        n["body"] = unlink_private(n["body"], hidden_stems)

    trips.sort(key=lambda t: (t["start"] or t["ym"] + "-01"))
    version = time.strftime("%Y%m%d-%H%M%S")
    out = {"generated": version, "trips": trips, "general": general}
    DATA.mkdir(parents=True, exist_ok=True)
    password = cfg.get("password")
    if password:
        # Password mode: attachments travel inside the encrypted payload (as data: URIs),
        # so nothing readable is left on the public site.
        import base64, mimetypes
        for n in general + [n for t in trips for n in t["notes"]]:
            for k, rel in list(n["attachments"].items()):
                if rel:
                    f = APP / rel
                    mime = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
                    n["attachments"][k] = f"data:{mime};base64," + base64.b64encode(f.read_bytes()).decode()
        shutil.rmtree(ATT); ATT.mkdir(parents=True, exist_ok=True)
        precache = []
        import seal
        salt = base64.b64decode(cfg["salt"]) if cfg.get("salt") else ensure_salt()
        env = seal.seal(json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), password, salt)
        (DATA / "trips.json").write_text(json.dumps(env), encoding="utf-8")
        print("🔐 data encrypted with the password in publish.local.json")
    else:
        print("! no password in publish.local.json — data is NOT encrypted")
        (DATA / "trips.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (DATA / "version.json").write_text(json.dumps({"version": version}), encoding="utf-8")
    (APP / "precache.json").write_text(json.dumps(sorted(set(precache)), ensure_ascii=False), encoding="utf-8")

    # bump the service-worker cache name so clients pick up the new build
    sw = APP / "sw.js"
    if sw.exists():
        s = sw.read_text(encoding="utf-8")
        s = re.sub(r"const VERSION = '[^']*';", f"const VERSION = '{version}';", s)
        sw.write_text(s, encoding="utf-8")

    total_att = sum(p.stat().st_size for p in ATT.rglob("*") if p.is_file()) / 1e6
    print(f"✓ {len(trips)} trips, {sum(len(t['notes']) for t in trips)} notes, {len(general)} general notes")
    print(f"✓ attachments copied: {len(precache)} files, {total_att:.1f} MB")
    print(f"✓ version {version}")
    if hidden:
        print(f"🔒 kept private ({len(hidden)}): " + ", ".join(f for _, f in hidden))
    if skipped:
        print(f"! skipped {len(skipped)} attachments over {max_attach_mb} MB:")
        for t, n, s in skipped:
            print(f"    {t}/{n} ({s})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("trips", nargs="*", help="trip folders to package (default: the \"trips\" list in publish.json)")
    ap.add_argument("--all", action="store_true", help="package every trip (ignores publish.json trips list)")
    ap.add_argument("--vault", type=Path, default=DEFAULT_VAULT)
    ap.add_argument("--max-attach-mb", type=float, default=8.0)
    a = ap.parse_args()
    only = set(a.trips) or (None if a.all else set(load_config().get("trips", [])) or None)
    build(a.vault, a.max_attach_mb, only)
