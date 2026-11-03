"""Fast static serving for the TV home page (/tv/...).

The TV is slow and the PC is not, so the PC does the work once and the TV just downloads small files:
- app.js / app.css are minified on the PC (esbuild, if bridge/data/tools/esbuild(.exe) or $ESBUILD exists; else served as they are)
- everything text is gzip-compressed once and kept in memory
- ETag + 304, so a reload downloads nothing; fonts and pictures may also be cached for a long time
- add ?dev to a URL to get the plain, unminified file
No other file imports this; server.py registers it for /tv/{path}.
"""
import gzip
import hashlib
import mimetypes
import os
import shutil
import subprocess
from aiohttp import web

_HERE = os.path.dirname(os.path.abspath(__file__))
_MINIFY = (".js", ".css")
_TEXT = (".js", ".css", ".html", ".json", ".svg", ".txt", ".md")
_cache = {}   # abs path -> (key, raw_bytes, gz_bytes_or_None, etag, ctype)


def _esbuild():
    for c in (os.environ.get("ESBUILD"), os.path.join(_HERE, "data", "tools", "esbuild.exe"),
              os.path.join(_HERE, "data", "tools", "esbuild"), shutil.which("esbuild")):
        if c and os.path.isfile(c):
            return c
    return None


def _minify(path, data):
    exe = _esbuild()
    if not exe:
        return data
    loader = "js" if path.endswith(".js") else "css"
    try:
        p = subprocess.run([exe, "--minify", f"--loader={loader}", "--legal-comments=none", "--log-level=error"],
                           input=data, capture_output=True, timeout=30)
        if p.returncode == 0 and p.stdout:
            return p.stdout
    except Exception:
        pass
    return data


def _ctype(path):
    ct = mimetypes.guess_type(path)[0] or "application/octet-stream"
    if path.endswith(".js"):
        ct = "application/javascript"
    if ct.startswith("text/") or ct in ("application/javascript", "application/json"):
        ct += "; charset=utf-8"
    return ct


def _load(path, dev):
    st = os.stat(path)
    key = (st.st_mtime_ns, st.st_size, dev)
    hit = _cache.get((path, dev))
    if hit and hit[0] == key:
        return hit
    with open(path, "rb") as f:
        raw = f.read()
    if not dev and path.endswith(_MINIFY):
        raw = _minify(path, raw)
    gz = gzip.compress(raw, 9) if path.endswith(_TEXT) and len(raw) > 600 else None
    etag = '"' + hashlib.sha1(raw).hexdigest()[:20] + ('d' if dev else '') + '"'
    hit = (key, raw, gz, etag, _ctype(path))
    _cache[(path, dev)] = hit
    return hit


def _cache_control(path):
    if path.endswith((".woff2", ".woff")):
        return "public, max-age=31536000, immutable"
    if path.endswith((".jpg", ".jpeg", ".png", ".webp")):
        return "public, max-age=3600"
    return "no-cache"   # html/js/css: always ask, the answer is a tiny 304


def serve(folder, request, rel):
    """Returns a response, or None when the caller should fall back (missing file etc.)."""
    if os.path.exists(os.path.join(_HERE, "data", "tvassets.off")):   # A/B switch for measuring
        return None
    target = os.path.normpath(os.path.join(folder, rel))
    if not target.startswith(os.path.normpath(folder)) or not os.path.isfile(target):
        return None
    dev = "dev" in request.query
    _, raw, gz, etag, ctype = _load(target, dev)
    h = {"ETag": etag, "Cache-Control": _cache_control(target), "Content-Type": ctype, "Vary": "Accept-Encoding"}
    if etag in (request.headers.get("If-None-Match") or ""):
        return web.Response(status=304, headers={k: v for k, v in h.items() if k != "Content-Type"})
    if gz is not None and "gzip" in request.headers.get("Accept-Encoding", ""):
        h["Content-Encoding"] = "gzip"
        return web.Response(body=gz, headers=h)
    return web.Response(body=raw, headers=h)


def warm(folder):
    """Compress/minify every text file once, so the first TV request is already fast."""
    n = 0
    for dp, _, names in os.walk(folder):
        for name in names:
            if name.endswith(_TEXT) and not name.startswith("mock"):
                try:
                    _load(os.path.join(dp, name), False)
                    n += 1
                except Exception:
                    pass
    return n
