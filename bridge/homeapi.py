"""GET /api/home: everything the TV home needs at start, in one answer (instead of 7-9 separate calls).

It runs the same handlers the separate endpoints use (so the answers are identical), at the same time,
and replies with an ETag so an unchanged home costs one tiny 304. A part that fails is null; the TV then
asks that one endpoint on its own.
"""
import asyncio
import hashlib
import json
from aiohttp import web
from aiohttp.test_utils import make_mocked_request

_h = {}


def register(app, handlers):
    """handlers: {'people': h_people_get, 'continue': h_continue, ...}"""
    _h.update(handlers)
    app.router.add_get("/api/home", h_home)


async def _call(request, name, path):
    fn = _h.get(name)
    if fn is None:
        return None
    try:
        fake = make_mocked_request("GET", path, app=request.app, headers=request.headers)
        resp = await fn(fake)
        return json.loads(resp.body) if getattr(resp, "body", None) else None
    except Exception:
        return None


async def h_home(request):
    tvq = request.query.get("tv")
    suffix = ("&tv=" + tvq) if tvq else ""

    async def people_and_shows():
        people = await _call(request, "people", "/api/people" + ("?tv=" + tvq if tvq else ""))
        shows = {}
        if people and people.get("people"):
            got = await asyncio.gather(*[
                _call(request, "continue", f"/api/continue?who={p['id']}{suffix}") for p in people["people"]])
            shows = {p["id"]: (g or {}).get("items") for p, g in zip(people["people"], got)}
        return people, shows

    q = "?tv=" + tvq if tvq else ""
    (people, shows), screens, webapps, who, apps, order, arrange, weather = await asyncio.gather(
        people_and_shows(),
        _call(request, "screens", "/api/screens" + q), _call(request, "webapps", "/api/webapps" + q),
        _call(request, "who", "/api/who" + q), _call(request, "apps", "/api/apps" + q),
        _call(request, "app-order", "/api/app-order" + q), _call(request, "arrange", "/api/arrange" + q),
        _call(request, "weather", "/api/weather" + q))
    out = {"ok": True, "people": people, "continue": shows, "screens": screens, "webapps": webapps,
           "who": who, "apps": apps, "order": order, "arrange": arrange, "weather": weather}
    body = json.dumps(out, separators=(",", ":")).encode()
    etag = '"' + hashlib.sha1(body).hexdigest()[:20] + '"'
    if etag == request.headers.get("If-None-Match"):
        return web.Response(status=304, headers={"ETag": etag, "Cache-Control": "no-cache"})
    return web.Response(body=body, content_type="application/json", headers={"ETag": etag, "Cache-Control": "no-cache"})


# ---- startup timing reports from the TV page (perf.js), kept in memory and in the log ----
_perf = []


async def h_perf_post(request):
    try:
        j = await request.json()
    except Exception:
        j = {}
    j["at"] = __import__("time").strftime("%H:%M:%S")
    _perf.append(j)
    del _perf[:-30]
    __import__("logging").getLogger("bridge").info("tv perf: %s", json.dumps(j.get("marks")))
    return web.json_response({"ok": True})


async def h_perf_get(request):
    return web.json_response({"ok": True, "reports": _perf})


def register_perf(app):
    app.router.add_post("/api/perf", h_perf_post)
    app.router.add_get("/api/perf", h_perf_get)
