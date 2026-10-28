"""One backup that holds everything a person set up, and a restore that puts it back.

A backup is one JSON file: the people, the safe parts of config.json, the bridge's data files
(history, taste, app order...) and what the TV keeps for itself (Settings, orders). Secrets
never go in: no pairing certificates or keys, no tokens, nothing from config.json outside the
short list below. See README of this file's handlers in server.py (/api/backup, /api/restore).
"""
import json
import os
import re
import tempfile
import time
from datetime import datetime

import config

FORMAT = "couch-tv-backup"
VERSION = 1
MAX_BYTES = 8 * 1024 * 1024

# Bridge data files that are safe to carry. Everything else in data/ (certs, keys, pairing
# results, the Claude work folder, caches) stays out.
DATA_FILES = re.compile(
    r"(people|who|taste|recs|keep-disabled|webapps)\.json|history\.jsonl|(app-order|home-apps|app-arrange)\.[A-Za-z0-9_-]+\.json")
# What the TV keeps for itself (the page's storage keys), kept on the bridge by /api/tv-state.
TV_KEYS = ("tvhome.settings", "tvhome.people.order", "tvhome.order.tv",
           "tvhome.apps.new", "tvhome.apps.seen")
# The only parts of config.json a backup carries or restores (no addresses, keys or tokens).
CONFIG_TOP = ("home", "weather", "country")
TV_FIELDS = ("name", "quick", "wake_on_lan")
SECRET = re.compile(r"key|token|secret|password|cert|pair|auth|cookie", re.I)

TV_STATE_FILE = os.path.join(config.DATA, "tv-state.json")


def backup_dir():
    given = config.CONFIG.get("backup_dir") or os.environ.get("COUCH_BACKUPS")
    return os.path.abspath(given or os.path.join(os.path.dirname(config.ROOT), "backups"))


def _read_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return None


def _write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    os.replace(tmp, path)


# ---------- what the TV keeps ----------
def tv_state():
    try:
        d = json.loads(_read_text(TV_STATE_FILE) or "{}")
    except ValueError:
        d = {}
    values = d.get("values") if isinstance(d.get("values"), dict) else {}
    return {"rev": int(d.get("rev") or 0), "values": {k: v for k, v in values.items() if k in TV_KEYS}}


def set_tv_state(values, replace=False):
    """values: {key: JSON text, or None to forget it}. Bumps the revision so every TV notices."""
    cur = tv_state()
    merged = {} if replace else dict(cur["values"])
    for k, v in (values or {}).items():
        if k not in TV_KEYS:
            continue
        if v is None:
            merged.pop(k, None)
        elif isinstance(v, str) and len(v) < 200_000:
            merged[k] = v
    rev = max(int(time.time() * 1000), cur["rev"] + 1)
    _write_text(TV_STATE_FILE, json.dumps({"rev": rev, "values": merged}))
    return {"rev": rev, "values": merged}


# ---------- make ----------
def _safe_config():
    out = {}
    for k in CONFIG_TOP:
        if k in config.CONFIG:
            out[k] = config.CONFIG[k]
    ask = config.CONFIG.get("ask")
    if isinstance(ask, dict) and "enabled" in ask:
        out["ask"] = {"enabled": bool(ask["enabled"])}
    tvs = {}
    for t in config.CONFIG.get("tvs") or []:
        if isinstance(t, dict) and t.get("id"):
            tvs[t["id"]] = {k: t[k] for k in TV_FIELDS if k in t}
    out["tvs"] = tvs
    return _strip_secrets(out)


def _strip_secrets(v):
    if isinstance(v, dict):
        return {k: _strip_secrets(x) for k, x in v.items() if not SECRET.search(k)}
    if isinstance(v, list):
        return [_strip_secrets(x) for x in v]
    return v


def make():
    files = {}
    try:
        names = sorted(os.listdir(config.DATA))
    except FileNotFoundError:
        names = []
    for name in names:
        path = os.path.join(config.DATA, name)
        if DATA_FILES.fullmatch(name) and os.path.isfile(path):
            text = _read_text(path)
            if text is not None:
                files[name] = text
    return {
        "format": FORMAT,
        "version": VERSION,
        "created": datetime.now().astimezone().isoformat(timespec="seconds"),
        "people": config.PEOPLE,
        "config": _safe_config(),
        "files": files,
        "tv": tv_state(),
    }


def save(prefix="backup"):
    """Write a backup into the backups folder. Returns {path, name, bytes}."""
    data = make()
    text = json.dumps(data, indent=1, ensure_ascii=False)
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    name = f"{prefix}-{stamp}.json"
    path = os.path.join(backup_dir(), name)
    n = 2
    while os.path.exists(path):
        name = f"{prefix}-{stamp}-{n}.json"
        path, n = os.path.join(backup_dir(), name), n + 1
    _write_text(path, text)
    return {"path": path, "name": name, "bytes": len(text.encode("utf-8")), "created": data["created"]}


def listing():
    d = backup_dir()
    out = []
    try:
        names = os.listdir(d)
    except FileNotFoundError:
        return out
    for name in names:
        if re.fullmatch(r"[A-Za-z0-9_-]+\.json", name):
            p = os.path.join(d, name)
            out.append({"name": name, "path": p, "bytes": os.path.getsize(p), "mtime": os.path.getmtime(p),
                        "auto": name.startswith("before-restore")})
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out


def latest(include_auto=False):
    for item in listing():
        if include_auto or not item["auto"]:
            return item
    return None


def load_named(name):
    if not re.fullmatch(r"[A-Za-z0-9_-]+\.json", name or ""):
        raise ValueError("that isn't a backup name")
    text = _read_text(os.path.join(backup_dir(), name))
    if text is None:
        raise ValueError("no such backup")
    try:
        return json.loads(text)
    except ValueError:
        raise ValueError("that backup file is damaged")


# ---------- check and apply ----------
def validate(b):
    """Returns the clean backup, or raises ValueError with a plain reason."""
    if not isinstance(b, dict) or b.get("format") != FORMAT:
        raise ValueError("this isn't a Couch TV backup")
    if not isinstance(b.get("version"), int) or b["version"] > VERSION:
        raise ValueError("this backup is from a newer version")
    if len(json.dumps(b)) > MAX_BYTES:
        raise ValueError("this backup is too big")
    files = b.get("files") or {}
    if not isinstance(files, dict):
        raise ValueError("backup files are malformed")
    clean_files = {}
    for name, text in files.items():
        if not isinstance(name, str) or not DATA_FILES.fullmatch(name):
            raise ValueError(f"unexpected file in backup: {name}")
        if not isinstance(text, str):
            raise ValueError(f"{name} is malformed")
        if name.endswith(".jsonl"):
            for line in text.splitlines():
                if line.strip():
                    json.loads(line)
        else:
            json.loads(text)
        clean_files[name] = text
    people = config.clean_people(b.get("people")) if b.get("people") is not None else None
    if b.get("people") and not people:
        raise ValueError("the people in this backup are not valid")
    tv = b.get("tv") or {}
    tvv = tv.get("values") if isinstance(tv, dict) else {}
    tvv = {k: v for k, v in (tvv or {}).items() if k in TV_KEYS and isinstance(v, str)}
    for v in tvv.values():
        json.loads(v)
    cfg = b.get("config") or {}
    if not isinstance(cfg, dict):
        raise ValueError("backup settings are malformed")
    return {"people": people, "files": clean_files, "tv": tvv, "config": _strip_secrets(cfg)}


def _merge_config(cfg):
    """Put the safe parts back into config.json. Returns True if the file changed."""
    if not cfg:
        return False
    path = config.CONFIG_FILE
    try:
        cur = json.loads(_read_text(path) or "{}")
    except ValueError:
        return False
    new = json.loads(json.dumps(cur))
    for k in CONFIG_TOP:
        if k in cfg:
            new[k] = cfg[k]
    if isinstance(cfg.get("ask"), dict) and "enabled" in cfg["ask"]:
        new.setdefault("ask", {})["enabled"] = bool(cfg["ask"]["enabled"])
    for t in new.get("tvs") or []:
        saved = (cfg.get("tvs") or {}).get(t.get("id"))
        if isinstance(saved, dict):
            for k in TV_FIELDS:
                if k in saved:
                    t[k] = saved[k]
    if new == cur:
        return False
    _write_text(path + ".before-restore", json.dumps(cur, indent=1))
    _write_text(path, json.dumps(new, indent=1))
    return True


def apply(b):
    """Put a validated backup back. Saves the current state first. Returns a summary."""
    clean = validate(b)
    before = save("before-restore")
    done = []
    if clean["people"]:
        config.set_people(clean["people"])
        done.append(f"{len(clean['people'])} people")
    for name, text in clean["files"].items():
        if name == "people.json":
            continue   # set_people wrote it
        _write_text(os.path.join(config.DATA, name), text)
    if clean["files"]:
        done.append(f"{len(clean['files'])} data files")
    if clean["tv"] or (b.get("tv") is not None):
        set_tv_state(clean["tv"], replace=True)
        done.append("TV settings")
    changed = _merge_config(clean["config"])
    if changed:
        done.append("config (restart the bridge to use it)")
    return {"restored": done, "before": before, "restart_needed": changed}
