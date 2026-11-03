"""GET /img?u=<https url>&w=<px>: poster/backdrop art, shrunk on the PC so the TV decodes a small picture.

Pictures are downloaded once, resized with Pillow (in a worker thread), saved as JPEG in bridge/data/imgcache/
and served with a long cache time. Only public http(s) addresses are fetched (no LAN/localhost).
"""
import asyncio
import hashlib
import io
import ipaddress
import os
import socket
from urllib.parse import urlparse

import aiohttp
from aiohttp import web

_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "imgcache")
_WIDTHS = (160, 240, 320, 480, 640, 960, 1280)
_inflight = {}


def _public(host):
    try:
        for fam, _, _, _, sa in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(sa[0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return False
        return True
    except Exception:
        return False


def _shrink(raw, w):
    from PIL import Image
    im = Image.open(io.BytesIO(raw))
    im.draft("RGB", (w * 2, w * 2))
    im = im.convert("RGB")
    if im.width > w:
        im = im.resize((w, max(1, round(im.height * w / im.width))), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, "JPEG", quality=80, optimize=True, progressive=False)
    return out.getvalue()


async def _build(url, w, path):
    u = urlparse(url)
    loop = asyncio.get_running_loop()
    if u.scheme not in ("http", "https") or not u.hostname or not await loop.run_in_executor(None, _public, u.hostname):
        raise web.HTTPForbidden(text="not a public picture address")
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as s:
        async with s.get(url, max_redirects=3) as r:
            if r.status != 200:
                raise web.HTTPBadGateway(text=f"picture host said {r.status}")
            raw = await r.content.read(12_000_000)
    data = await loop.run_in_executor(None, _shrink, raw, w)
    os.makedirs(_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    return data


async def h_img(request):
    url = request.query.get("u", "")
    try:
        w = int(request.query.get("w", "480"))
    except ValueError:
        w = 480
    w = min(_WIDTHS, key=lambda x: abs(x - w))
    key = hashlib.sha1(f"{w}|{url}".encode()).hexdigest()
    path = os.path.join(_DIR, key + ".jpg")
    hdr = {"Content-Type": "image/jpeg", "Cache-Control": "public, max-age=604800", "ETag": f'"{key[:16]}"'}
    if request.headers.get("If-None-Match") == hdr["ETag"] and os.path.isfile(path):
        return web.Response(status=304, headers={"ETag": hdr["ETag"], "Cache-Control": hdr["Cache-Control"]})
    if os.path.isfile(path):
        return web.FileResponse(path, headers=hdr)
    t = _inflight.get(key)
    if t is None:
        t = _inflight[key] = asyncio.ensure_future(_build(url, w, path))
        t.add_done_callback(lambda _t: _inflight.pop(key, None))
    return web.Response(body=await asyncio.shield(t), headers=hdr)
