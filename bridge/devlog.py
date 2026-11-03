"""Dev log: the dated list of what changed (tv-home/web/devlog.json).

  GET /api/devlog   the list as JSON (the phone remote's Dev log sheet reads this)
  GET /devlog       a plain page that works without the app (phone browser)

The same file is shown on the TV in Settings > Dev log. Add entries with tools/devlog.py.
"""
import os

from aiohttp import web

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
JSON_PATH = os.path.join(ROOT, "tv-home", "web", "devlog.json")
PAGE_PATH = os.path.join(ROOT, "remote", "public", "devlog.html")


def routes(r, S=None):
    async def h_json(request):
        try:
            return web.FileResponse(JSON_PATH, headers={"Cache-Control": "no-cache", "Content-Type": "application/json; charset=utf-8"})
        except OSError:
            raise web.HTTPNotFound()

    async def h_page(request):
        if not os.path.isfile(PAGE_PATH):
            raise web.HTTPNotFound()
        return web.FileResponse(PAGE_PATH, headers={"Cache-Control": "no-cache", "Content-Type": "text/html; charset=utf-8"})

    r.add_get("/api/devlog", h_json)
    r.add_get("/devlog", h_page)
