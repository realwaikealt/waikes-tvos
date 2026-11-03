"""Diagnostics for the hidden Debug page on the TV.

  GET  /api/diag/ping        tiny reply, the TV times it
  GET  /api/diag/system      TV model, Android, uptime, storage, memory, load (read-only ADB), plus the bridge's own facts
  POST /api/diag/report      the TV sends what its Debug page collected; saved as a timestamped JSON in the diag folder
  GET  /diag/latest          the newest report, readable on a phone
  GET  /diag/latest.json     the same, raw

Nothing here changes the TV: only read-only shell commands (getprop, uptime, df, /proc).
"""
import html
import json
import os
import platform
import re
import sys
import time
from datetime import datetime

from aiohttp import web

import claude
import config

START = time.time()
MAX_REPORT = 1_000_000
KEEP = 60
_latest = {"name": None, "data": None}


def diag_dir():
    given = config.CONFIG.get("diag_dir") or os.environ.get("COUCH_DIAG")
    return os.path.abspath(given or os.path.join(os.path.dirname(config.ROOT), "diag"))


def _newest_on_disk():
    d = diag_dir()
    try:
        names = sorted(n for n in os.listdir(d) if n.startswith("diag-") and n.endswith(".json"))
    except OSError:
        return None, None
    if not names:
        return None, None
    try:
        with open(os.path.join(d, names[-1]), encoding="utf-8") as f:
            return names[-1], json.load(f)
    except (OSError, ValueError):
        return None, None


SYSTEM_CMD = (
    "echo model=$(getprop ro.product.model); echo maker=$(getprop ro.product.manufacturer);"
    " echo android=$(getprop ro.build.version.release); echo sdk=$(getprop ro.build.version.sdk);"
    " echo build=$(getprop ro.build.display.id); echo uptime=$(cat /proc/uptime);"
    " echo load=$(cat /proc/loadavg); echo ---mem; head -3 /proc/meminfo; echo ---df; df /data | tail -1;"
    " echo ---cpu; grep -c ^processor /proc/cpuinfo"
)


def _parse_system(text):
    out, section = {}, None
    for line in (text or "").splitlines():
        line = line.strip()
        if line.startswith("---"):
            section = line[3:]
            continue
        if section is None:
            k, _, v = line.partition("=")
            out[k] = v.strip()
        elif section == "mem":
            m = re.match(r"(\w+):\s+(\d+) kB", line)
            if m:
                out["mem_" + m.group(1).lower() + "_kb"] = int(m.group(2))
        elif section == "df":
            parts = line.split()
            if len(parts) >= 5:
                out["storage"] = {"size_kb": parts[1], "used_kb": parts[2], "free_kb": parts[3], "use": parts[4]}
        elif section == "cpu" and line.isdigit():
            out["cpu_cores"] = int(line)
    try:
        out["uptime_s"] = int(float(out.get("uptime", "0").split()[0]))
    except (ValueError, IndexError):
        pass
    try:
        out["load"] = [float(x) for x in out.get("load", "").split()[:3]]
    except ValueError:
        pass
    out.pop("uptime", None)
    return out


def routes(r, S):
    """Add the diag routes. S is the server module (its tv, ok, ApiError, body)."""

    async def h_ping(request):
        return S.ok(t=time.time())

    async def h_system(request):
        tv = S.tv
        info = {"bridge": {
            "uptime_s": int(time.time() - START), "python": platform.python_version(),
            "platform": platform.platform(), "port": S.PORT,
            "claude_cli": bool(claude.available()), "diag_dir": diag_dir(),
        }, "tv": {"adb_ok": bool(getattr(tv, "adb_ok", False)), "ip": getattr(tv, "ip", None),
                  "is_on": getattr(tv, "is_on", None), "last_wake": getattr(tv, "last_wake", None)}}
        if getattr(tv, "adb_ok", False) or await tv.adb_ready():
            try:
                text = await tv.adb("shell", SYSTEM_CMD, timeout=10)
                info["tv"].update(_parse_system(text))
                info["tv"]["adb_ok"] = True
            except Exception as e:  # report it, the page shows the reason
                info["tv"]["adb_error"] = str(e)[:200]
        else:
            info["tv"]["adb_error"] = "ADB is not on"
        return S.ok(**info)

    async def h_report(request):
        if request.content_length and request.content_length > MAX_REPORT:
            raise S.ApiError(413, "report too big")
        data = await S.body(request)
        if not data:
            raise S.ApiError(400, "empty report")
        data["received"] = S.now_iso()
        data["from"] = request.remote
        d = diag_dir()
        os.makedirs(d, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        name, n = f"diag-{stamp}.json", 2
        while os.path.exists(os.path.join(d, name)):
            name, n = f"diag-{stamp}-{n}.json", n + 1
        text = json.dumps(data, indent=1, ensure_ascii=False)
        with open(os.path.join(d, name), "w", encoding="utf-8") as f:
            f.write(text)
        _latest.update(name=name, data=data)
        old = sorted(x for x in os.listdir(d) if x.startswith("diag-") and x.endswith(".json"))[:-KEEP]
        for x in old:
            try:
                os.remove(os.path.join(d, x))
            except OSError:
                pass
        return S.ok(name=name, path=os.path.join(d, name), url="/diag/latest", bytes=len(text.encode("utf-8")))

    def newest():
        if _latest["data"] is not None:
            return _latest["name"], _latest["data"]
        name, data = _newest_on_disk()
        if data is not None:
            _latest.update(name=name, data=data)
        return name, data

    async def h_latest_json(request):
        name, data = newest()
        if data is None:
            raise S.ApiError(404, "no diagnostics sent yet")
        return web.json_response(data, headers={"Cache-Control": "no-store"})

    async def h_latest(request):
        name, data = newest()
        if data is None:
            body_html = "<p>No diagnostics have been sent yet. On the TV, open the Debug page and choose Send diagnostics.</p>"
        else:
            text = json.dumps(data, indent=1, ensure_ascii=False)
            fps = (data.get("page") or {}).get("fps") or {}
            summary = [("Report", name), ("Received", data.get("received")),
                       ("Model", (data.get("system") or {}).get("tv", {}).get("model")),
                       ("Android", (data.get("system") or {}).get("tv", {}).get("android")),
                       ("FPS now", fps.get("now")), ("Long frames", fps.get("long")),
                       ("Bridge ping", (data.get("timing") or {}).get("ping_ms"))]
            rows = "".join(f"<tr><th>{html.escape(k)}</th><td>{html.escape(str(v))}</td></tr>"
                           for k, v in summary if v is not None)
            body_html = (f"<table>{rows}</table><button onclick=\"navigator.clipboard&&navigator.clipboard"
                         f".writeText(document.getElementById('j').textContent).then(()=>this.textContent='Copied')\">Copy all</button>"
                         f"<pre id=j>{html.escape(text)}</pre>")
        page = ("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1,viewport-fit=cover'>"
                "<meta name=theme-color content='#120d13'><title>Diagnostics</title><style>"
                ":root{color-scheme:dark;--ink:#f5f5f7;--ink2:rgba(245,245,247,.64);--panel:#221820;--rim:rgba(255,255,255,.1)}"
                "*{box-sizing:border-box}body{margin:0 auto;max-width:640px;padding:max(24px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) 40px max(20px,env(safe-area-inset-left));"
                "background:#120d13;color:var(--ink);font:400 17px/1.45 -apple-system,'SF Pro Text',system-ui,sans-serif;-webkit-font-smoothing:antialiased}"
                ".brand{font:700 17px/1 -apple-system,system-ui,sans-serif;letter-spacing:-.01em;margin:0 0 22px}"
                "h1{font:700 30px/1.12 -apple-system,'SF Pro Display',system-ui,sans-serif;letter-spacing:-.02em;margin:0 0 14px}"
                "p{color:var(--ink2)}table{border-collapse:collapse;margin-bottom:16px}th{text-align:left;color:var(--ink2);font-weight:500;padding:4px 16px 4px 0}"
                "td{padding:4px 0}button{font:600 16px -apple-system,system-ui,sans-serif;border:0;border-radius:24px;padding:0 22px;min-height:48px;background:#fff;color:#111;"
                "transition:transform .32s cubic-bezier(.34,1.4,.64,1)}button:active{transform:scale(.94);transition-duration:.07s}"
                "pre{white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,Menlo,monospace;background:var(--panel);border-radius:20px;padding:16px;margin-top:16px;box-shadow:inset 0 0 0 1px var(--rim)}"
                "</style><div class=brand>Asher’s tvOS</div><h1>Diagnostics from the TV</h1>" + body_html)
        return web.Response(text=page, content_type="text/html", headers={"Cache-Control": "no-store"})

    r.add_get("/api/diag/ping", h_ping)
    r.add_get("/api/diag/system", h_system)
    r.add_post("/api/diag/report", h_report)
    r.add_get("/diag/latest", h_latest)
    r.add_get("/diag/latest.json", h_latest_json)
