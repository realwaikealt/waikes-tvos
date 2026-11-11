"""Health of every TV, in one place: is it connected, how fast is the link, which home screen is the default.

  GET /api/health/all   JSON for all TVs (the phone remote's Health sheet and the TV read this)
  GET /health           a plain page that works in any phone browser, refreshes itself

Nothing here changes anything on a TV. "Speed" is the round trip from this computer to the TV (three quick
connections to its remote port), plus how long the bridge took to answer. The default home comes from adb
(`cmd package resolve-activity` for the HOME category); a TV with a "home_switch" block in config.json is
asked through the real adb program, the others through the bridge's own adb link. Answers are cached for
45 seconds so refreshing the page never hammers a TV.
"""
import asyncio
import os
import re
import time

from aiohttp import web

import config

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PAGE_PATH = os.path.join(ROOT, "remote", "public", "health.html")
STARTED = time.time()
CACHE_FOR = 45
_home_cache = {}      # tv id -> (time, result)

HOMES = {
    "app.couchtv.launcher": ("ours", "Asher's tvOS"),
    "com.google.android.apps.tv.launcherx": ("google", "Google TV home"),
    "com.google.android.tvlauncher": ("google", "Android TV home"),
}


def _label_home(pkg):
    if pkg in HOMES:
        return {"id": HOMES[pkg][0], "name": HOMES[pkg][1], "package": pkg}
    return {"id": "other", "name": "The TV's own home", "package": pkg}


async def _latency(ip, port=6466, tries=3):
    """Three quick TCP connections: average and worst time in ms, and how many failed."""
    times, lost = [], 0
    for _ in range(tries):
        t0 = time.perf_counter()
        try:
            _r, w = await asyncio.wait_for(asyncio.open_connection(ip, port), 1.5)
            times.append((time.perf_counter() - t0) * 1000)
            w.close()
        except (OSError, asyncio.TimeoutError):
            lost += 1
        await asyncio.sleep(0.05)
    if not times:
        return {"ok": False, "lost": lost}
    return {"ok": True, "avg_ms": round(sum(times) / len(times), 1), "max_ms": round(max(times), 1), "lost": lost}


def _rating(lat):
    if not lat.get("ok"):
        return "none"
    avg, lost = lat["avg_ms"], lat["lost"]
    if lost or avg > 120:
        return "slow"
    if avg > 40:
        return "ok"
    return "fast"


async def _home_via_bridge(t):
    out = await t.adb("shell", "cmd package resolve-activity --brief -a android.intent.action.MAIN "
                               "-c android.intent.category.HOME", timeout=8)
    return _pkg_from(out)


def _pkg_from(out):
    for line in reversed((out or "").strip().splitlines()):
        m = re.match(r"\s*([\w.]+)/", line)
        if m:
            return m.group(1)
    return None


async def _home(t):
    now = time.time()
    hit = _home_cache.get(t.id)
    if hit and now - hit[0] < CACHE_FOR:
        return hit[1]
    res = {"known": False}
    try:
        cfg = next((c for c in config.TVS if c["id"] == t.id), {})
        if isinstance(cfg.get("home_switch"), dict):
            import homebutton
            if homebutton.available(t.id):
                st = await homebutton.state(t.id)
                if st.get("mode"):
                    pkg = cfg["home_switch"]["ours"].split("/")[0] if st["mode"] == "ours" else \
                        cfg["home_switch"]["google_home"].split("/")[0]
                    res = {"known": True, **_label_home(pkg), "can_switch": True}
        if not res["known"] and t.adb_ok:
            pkg = await _home_via_bridge(t)
            if pkg:
                res = {"known": True, **_label_home(pkg), "can_switch": False}
    except Exception as e:  # noqa: BLE001
        res = {"known": False, "error": str(e)[:120]}
    _home_cache[t.id] = (now, res)
    return res


async def _one(t, ui_clients):
    ip = t.ip or t.fallback_ip
    on = t.is_on
    lat = await _latency(ip) if ip else {"ok": False, "lost": 0}
    home = await _home(t) if (t.adb_ok or t.id in _adb_tvs()) else {"known": False}
    return {
        "id": t.id, "name": t.name, "ip": ip,
        "paired": t.paired,
        "connected": bool(t.connected),
        "adb": bool(t.adb_ok),
        "power": "unknown" if on is None else ("on" if on else "off"),
        "app": (t.current_package or None),
        "screen_open": ui_clients.get(t.id, 0) > 0,     # our home screen is open and talking to the bridge
        "link": {**lat, "rating": _rating(lat)},
        "home": home,
    }


def _adb_tvs():
    return {c["id"] for c in config.TVS if isinstance(c.get("home_switch"), dict)}


async def snapshot(TVS, events_clients):
    ui = {}
    for _q, tv_id in list(events_clients):
        ui[tv_id] = ui.get(tv_id, 0) + 1
    t0 = time.perf_counter()
    tvs = await asyncio.gather(*[_one(t, ui) for t in TVS.values()])
    return {"ok": True, "now": time.time(), "bridge": {
        "uptime_s": int(time.time() - STARTED), "took_ms": round((time.perf_counter() - t0) * 1000),
        "default": config.DEFAULT_TV, "claude": _claude()}, "tvs": tvs}


def _claude():
    try:
        import claude
        return bool(claude.available())
    except Exception:  # noqa: BLE001
        return False


def routes(r, S):
    async def h_all(request):
        return web.json_response(await snapshot(S.TVS, S.events_clients), headers={"Cache-Control": "no-store"})

    async def h_page(request):
        if not os.path.isfile(PAGE_PATH):
            raise web.HTTPNotFound()
        return web.FileResponse(PAGE_PATH, headers={"Cache-Control": "no-cache", "Content-Type": "text/html; charset=utf-8"})

    r.add_get("/api/health/all", h_all)
    r.add_get("/health", h_page)
