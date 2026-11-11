"""TV messages: "work finished" notes that wait on the PC until someone presses OK on the TV.

Anyone on this computer (tools/tvnotify.py, Claude, a script) POSTs /api/notify. The note is saved in
data/inbox.json and pushed to every open events stream, so the TV home screen and the phone remote learn at once.
The TV shows unread notes as a popup that needs OK. The bridge never wakes the TV for a message: if the TV is off
the note simply waits and shows when the home screen is next on screen.
"""
import asyncio
import json
import logging
import os
import tempfile
import time
from datetime import datetime

log = logging.getLogger("notify")
LEVELS = ("done", "info", "warn", "error")
KEEP = 200


def _path(S):
    import config
    d = config.DATA
    os.makedirs(d, exist_ok=True)
    tv = config.CURRENT_TV.get()
    if not tv or tv == config.DEFAULT_TV or not all(c.isalnum() or c == "-" for c in tv):
        return os.path.join(d, "inbox.json")
    return os.path.join(d, "inbox.%s.json" % tv)


def _load(S):
    try:
        with open(_path(S), encoding="utf-8") as f:
            j = json.load(f)
        return j if isinstance(j, list) else []
    except (OSError, ValueError):
        return []


def _save(S, items):
    p = _path(S)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(items[-KEEP:], f, ensure_ascii=False, indent=1)
    os.replace(tmp, p)


def _view(items):
    """Newest first, plus the unread count."""
    out = sorted(items, key=lambda m: m.get("ts", 0), reverse=True)
    return {"messages": out, "unread": sum(1 for m in out if not m.get("read"))}


def _text(v, n):
    return str(v or "").strip()[:n]


def routes(r, S):
    def broadcast():
        view = _view(_load(S))
        payload = "event: inbox\ndata: " + json.dumps({"ok": True, "unread": view["unread"],
                  "latest": view["messages"][0]["id"] if view["messages"] else None}) + "\n\n"
        import config
        mine = config.CURRENT_TV.get()
        for q, _tv in list(S.events_clients):
            if (_tv or config.DEFAULT_TV) == mine and q.qsize() < 20:
                q.put_nowait(payload)

    async def h_notify(request):
        if not S._from_this_computer(request):
            raise S.ApiError(403, "Messages can only be sent from the computer the bridge runs on.")
        d = await S.body(request)
        title, summary = _text(d.get("title"), 120), _text(d.get("summary"), 4000)
        if not title and not summary:
            raise S.ApiError(400, "title or summary is required")
        level = d.get("level") if d.get("level") in LEVELS else "done"
        items = d.get("items")
        items = [_text(i, 300) for i in items if _text(i, 300)][:12] if isinstance(items, list) else []
        now = time.time()
        msg = {"id": "m%d%s" % (int(now * 1000), os.urandom(2).hex()), "ts": now,
               "time": datetime.now().astimezone().isoformat(timespec="seconds"),
               "title": title or "Update", "summary": summary, "items": items, "level": level,
               "source": _text(d.get("source"), 60), "read": False}
        all_ = _load(S)
        all_.append(msg)
        _save(S, all_)
        broadcast()
        log.info("message queued: %s", msg["title"])
        return S.ok(id=msg["id"], **{"unread": _view(all_)["unread"]})

    async def h_inbox(request):
        return S.ok(**_view(_load(S)))

    async def h_ack(request):
        d = await S.body(request)
        which = d.get("id")
        if not which:
            raise S.ApiError(400, "id (a message id or \"all\") is required")
        items, changed = _load(S), 0
        stamp = datetime.now().astimezone().isoformat(timespec="seconds")
        for m in items:
            if (which == "all" or m.get("id") == which) and not m.get("read"):
                m["read"], m["read_at"] = True, stamp
                changed += 1
        if changed:
            _save(S, items)
            broadcast()
        return S.ok(changed=changed, unread=_view(items)["unread"])

    async def h_unread(request):
        """Mark a message unread again (the TV's Messages list uses this to replay one)."""
        d = await S.body(request)
        items, changed = _load(S), 0
        for m in items:
            if m.get("id") == d.get("id") and m.get("read"):
                m["read"] = False
                m.pop("read_at", None)
                changed += 1
        if changed:
            _save(S, items)
            broadcast()
        return S.ok(changed=changed, unread=_view(items)["unread"])

    r.add_post("/api/notify", h_notify)
    r.add_get("/api/inbox", h_inbox)
    r.add_post("/api/inbox/ack", h_ack)
    r.add_post("/api/inbox/unread", h_unread)
