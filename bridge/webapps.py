"""Web apps: websites that open full screen on the TV in the home app's own browser (no popups).

The list lives in data/webapps.json (so it is backed up with everything else). Until the owner
changes it, config.json's "webapps" is used, and failing that the one built-in entry below.
Each entry: id, name, url, allowed_hosts (extra sites a page may move to), colour, letter.
"""
import os
import re
from urllib.parse import urlparse

import config
import store

DEFAULT = [{"id": "vidbox", "name": "Vidbox", "url": "https://vidbox.wtf/home",
            "allowed_hosts": [], "colour": "#6d3df2", "letter": "V"}]
MAX_APPS = 24
FILE = "webapps.json"


def _path():
    return os.path.join(store.DATA, FILE)


def _slug(text):
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")[:32]


def clean_one(raw, taken=()):
    """One entry from the phone or a file -> a safe entry, or a ValueError saying what is wrong."""
    if not isinstance(raw, dict):
        raise ValueError("a web app needs a name and an address")
    name = str(raw.get("name") or "").strip()[:40]
    if not name:
        raise ValueError("give it a name")
    url = str(raw.get("url") or "").strip()
    if "://" not in url:
        url = "https://" + url
    parts = urlparse(url)
    if parts.scheme not in ("http", "https") or not parts.hostname or "." not in parts.hostname:
        raise ValueError("the address must be a web address like https://example.com")
    hosts = raw.get("allowed_hosts") or []
    if isinstance(hosts, str):
        hosts = [h for h in re.split(r"[,\s]+", hosts) if h]
    hosts = [str(h).strip().lower().lstrip(".")[:100] for h in hosts if str(h).strip()][:12]
    colour = str(raw.get("colour") or "")
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", colour):
        colour = "#2a2a30"
    letter = str(raw.get("letter") or name[:1]).strip()[:2].upper() or "?"
    wid = _slug(raw.get("id") or name) or "web"
    if wid in taken and not raw.get("_keep_id"):
        n = 2
        while f"{wid}-{n}" in taken:
            n += 1
        wid = f"{wid}-{n}"
    return {"id": wid, "name": name, "url": url, "allowed_hosts": hosts, "colour": colour, "letter": letter}


def get():
    raw = store._read(_path(), None)
    if isinstance(raw, dict) and isinstance(raw.get("webapps"), list):
        src = raw["webapps"]
    else:
        src = config.CONFIG.get("webapps") if isinstance(config.CONFIG.get("webapps"), list) else DEFAULT
    out = []
    for item in src:
        try:
            out.append(clean_one(dict(item, _keep_id=True), [a["id"] for a in out]))
        except ValueError:
            continue
    return out[:MAX_APPS]


def save(apps):
    store._write(_path(), {"webapps": apps[:MAX_APPS]})
    return apps[:MAX_APPS]


def add(raw):
    apps = get()
    if len(apps) >= MAX_APPS:
        raise ValueError(f"that is the most web apps ({MAX_APPS})")
    apps.append(clean_one(raw, [a["id"] for a in apps]))
    return save(apps)


def remove(wid):
    apps = get()
    kept = [a for a in apps if a["id"] != wid]
    if len(kept) == len(apps):
        raise KeyError(wid)
    return save(kept)


def update(wid, raw):
    apps = get()
    for i, a in enumerate(apps):
        if a["id"] == wid:
            apps[i] = clean_one(dict(a, **{k: v for k, v in raw.items() if k != "id"}, id=wid, _keep_id=True), [])
            return save(apps)
    raise KeyError(wid)
