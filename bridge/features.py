"""Feature switches: one place to turn parts of Asher's tvOS on or off, on the TV and the phone.

  GET  /api/features              the list: [{id, label, note, on}]
  POST /api/features {id, on}     switch one

The choice is kept in bridge/data/features.json (missing = the default below). The rest of the bridge asks
is_on(id); the phone and the TV read the same list (also inside /api/config as "features") and hide what is off.
To add a feature: add a row to REGISTRY, ask is_on("id") where it should stop, and hide its UI when
features["id"] is false. Nothing is deleted when a feature is off.
"""
import json
import os

from aiohttp import web

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "features.json")

# id, label, note, default
REGISTRY = [
    ("wallpaper", "Wallpaper Engine backgrounds", "Video wallpapers on the TV, and the phone's Wallpaper block.", True),
    ("messages", "TV messages", "The popups when work finishes, the Messages list and the message banner.", True),
    ("devlog", "Dev log", "The history and the Status page on the TV and the phone.", True),
    ("startup", "Startup animation", "The animation when the TV starts up or wakes.", True),
    ("screensaver", "Screensaver", "The big clock over your wallpaper when the TV is idle, and the phone's Start button.", True),
    ("ask", "Ask Claude", "The Ask button on the TV and the Ask tab on the phone.", True),
    ("webapps", "Web apps", "Websites as TV tiles, and the phone's Web apps block.", True),
    ("streaming", "PC streaming (parked)", "Vidbox streaming from the PC. Needs Sunshine and Moonlight.", False),
]
_IDS = [r[0] for r in REGISTRY]


def _load():
    try:
        with open(DATA, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def is_on(fid):
    d = _load()
    if fid in d:
        return bool(d[fid])
    for r in REGISTRY:
        if r[0] == fid:
            return r[3]
    return True


def states():
    return {fid: is_on(fid) for fid in _IDS}


def listing():
    return [{"id": r[0], "label": r[1], "note": r[2], "on": is_on(r[0])} for r in REGISTRY]


def set_on(fid, on):
    if fid not in _IDS:
        raise KeyError(fid)
    d = _load()
    d[fid] = bool(on)
    os.makedirs(os.path.dirname(DATA), exist_ok=True)
    tmp = DATA + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=1)
    os.replace(tmp, DATA)


def apply(pub):
    """Shape the public config (what the TV and the phone see) to match the switches."""
    st = states()
    pub["features"] = st
    if not st["ask"]:
        pub["ask"] = {"enabled": False}
    if not st["webapps"]:
        pub["webapps"] = []
    return pub


def routes(r, S=None):
    async def h_get(request):
        return web.json_response({"ok": True, "features": listing()})

    async def h_set(request):
        try:
            data = await request.json()
        except ValueError:
            return web.json_response({"ok": False, "error": "Send JSON like {\"id\": \"devlog\", \"on\": false}."}, status=400)
        fid = data.get("id")
        if fid not in _IDS:
            return web.json_response({"ok": False, "error": "Unknown feature."}, status=404)
        set_on(fid, bool(data.get("on")))
        return web.json_response({"ok": True, "features": listing()})

    r.add_get("/api/features", h_get)
    r.add_post("/api/features", h_set)
