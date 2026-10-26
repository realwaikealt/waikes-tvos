"""MCP server (stdio) for the living room TV. Every tool is a thin call to the bridge HTTP API,
so the bridge stays the only thing that talks to the TV.

Registered for the workspace in .mcp.json as "tv". /api/ask also starts it for each request.
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from mcp.server.fastmcp import FastMCP, Image

BRIDGE = os.environ.get("BRIDGE_URL", "http://127.0.0.1:5400")
ASK_ID = os.environ.get("ASK_ID")
TV_ID = os.environ.get("TV_ID")  # set by /api/ask: the TV the person asked from

mcp = FastMCP("tv", instructions=(
    "Controls the living room Google TV through the bridge. "
    "Use play to put a show or film on, find to see where it streams in this home's country, key/volume/"
    "launch for remote control, now to see what is on. Never power the TV off unless asked. "
    "There can be more than one TV (tvs); tools default to the TV the person asked from."))


def call(method, path, payload=None, raw=False, tv=None):
    tv = tv or TV_ID
    if tv:
        path += ("&" if "?" in path else "?") + urllib.parse.urlencode({"tv": tv})
    req = urllib.request.Request(BRIDGE + path, method=method)
    if ASK_ID:
        req.add_header("X-Ask-Id", ASK_ID)
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=60) as r:
            body = r.read()
    except urllib.error.HTTPError as e:
        body = e.read()
        if raw:
            raise RuntimeError(body.decode(errors="replace")[:200])
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"bridge not running ({e.reason})"}
    if raw:
        return body
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {"ok": False, "error": body.decode(errors="replace")[:200]}


@mcp.tool()
def now(tv: str | None = None) -> dict:
    """What is on the TV right now: power, the app in front, volume, and what is playing. tv: an id from config.json (the default if left out)."""
    return call("GET", "/api/now", tv=tv)


@mcp.tool()
def play(title: str, season: int | None = None, episode: int | None = None,
         service: str | None = None, tv: str | None = None) -> dict:
    """Find a show or film and start it on the TV in the right app (looks up where it streams in
    this home's country, then opens it by deep link, or opens the app's search). `service` forces an app id,
    e.g. netflix, stan, binge, abc-iview, sbs-on-demand, disney-plus, prime-video, youtube.
    Pass season and episode only when the person said them. The answer has started=true when
    the app was seen playing; only then say it is playing."""
    payload = {"title": title}
    if season:
        payload["season"] = season
    if episode:
        payload["episode"] = episode
    if service:
        payload["service"] = service
    return call("POST", "/api/play", payload, tv=tv)


@mcp.tool()
def find(title: str, type: str | None = None) -> dict:
    """Where a show or film streams in this home's country (free, subscription, rent, buy), without playing it.
    type is "tv" or "movie" to narrow it."""
    q = {"title": title}
    if type:
        q["type"] = type
    return call("GET", "/api/find?" + urllib.parse.urlencode(q))


@mcp.tool()
def key(key: str, hold: bool = False, tv: str | None = None) -> dict:
    """Press a remote button. Keys: up down left right ok back home play_pause play pause stop
    next previous rewind fast_forward volume_up volume_down mute power settings menu info guide
    input search captions channel_up channel_down 0-9. hold=true for a long press."""
    return call("POST", "/api/key", {"key": key, "hold": hold}, tv=tv)


@mcp.tool()
def type_text(text: str, tv: str | None = None) -> dict:
    """Type text into the text box that is open on the TV (a search box)."""
    return call("POST", "/api/text", {"text": text}, tv=tv)


@mcp.tool()
def launch(app: str, tv: str | None = None) -> dict:
    """Open an app on the TV by id (netflix, youtube, stan, binge, abc-iview, sbs-on-demand,
    disney-plus, prime-video, apple-tv, paramount-plus, kayo, foxtel-go, 9now, 7plus, 10play,
    hbo-max, spotify, home, settings), by Android package name, or by link."""
    return call("POST", "/api/launch", {"app": app}, tv=tv)


@mcp.tool()
def apps() -> dict:
    """The apps on the TV, with ids and whether each is installed."""
    return call("GET", "/api/apps")


@mcp.tool()
def volume(action: str = "up", steps: int = 1, tv: str | None = None) -> dict:
    """Change the volume: action is up, down or mute; steps repeats up or down (1 to 20)."""
    return call("POST", "/api/volume", {"action": action, "steps": steps}, tv=tv)


@mcp.tool()
def power(state: str, tv: str | None = None) -> dict:
    """Turn the TV on or off: state is on, off or toggle. Only turn it off when clearly asked."""
    return call("POST", "/api/power", {"state": state}, tv=tv)


@mcp.tool()
def tvs() -> dict:
    """The TVs the bridge knows (see config.json), whether each is paired, connected and on.
    Every other tool takes an optional tv id; leave it out for the TV the person is using."""
    return call("GET", "/api/tvs")


@mcp.tool()
def history() -> dict:
    """What has been played on the TV through the bridge, newest first."""
    r = call("GET", "/api/history")
    if r.get("ok"):
        r["items"] = r["items"][:50]
    return r


@mcp.tool()
def taste(who: str | None = None) -> dict:
    """What this household likes, from all watch history (TV plays plus imported Netflix and
    YouTube history): genres, shows finished, dropped and rewatched, films, YouTube channels,
    recent versus long term. who: a person id from config.json, or both. Use it before recommending."""
    path = "/api/taste" + (f"?who={urllib.parse.quote(who)}" if who else "")
    return call("GET", path)


@mcp.tool()
def recs() -> dict:
    """Claude's cached picks for this household, plus continue watching."""
    return call("GET", "/api/recs")


@mcp.tool()
def screens() -> dict:
    """The house screens that can be opened on the TV (see config.json). Nothing shows unless opened."""
    return call("GET", "/api/screens")


@mcp.tool()
def open_screen(id: str) -> dict:
    """Open a house screen on the TV, by its id from config.json. Only when someone asked for it."""
    return call("POST", "/api/screens/open", {"id": id})


@mcp.tool()
def screenshot(tv: str | None = None) -> Image:
    """A picture of what is on the TV screen right now (needs ADB on the TV)."""
    png = call("GET", "/api/screenshot", raw=True, tv=tv)
    return Image(data=png, format="png")


if __name__ == "__main__":
    mcp.run()
