"""PC mode: drive this computer's mouse and keyboard from the phone, and start/stop the Sunshine stream to the TV.

The TV remote can't point at things inside a Moonlight stream, so the phone remote becomes a touchpad and keyboard for
the PC the bridge runs on (Windows SendInput through ctypes, no extra packages).

  GET  /api/pc/status   {sunshine, streaming, app, mode, can_input, dry_run}
  POST /api/pc/mode     {on: bool, minutes: 1..120}      manual PC mode (when no stream is running, e.g. to use the desktop)
  POST /api/pc/input    one event or {events: [...]}      see EVENT TYPES below
  POST /api/pc/stream   {app: "Vidbox"|"Desktop", action: "start"|"stop"}

Safety: only from the home network (private addresses), only while a Sunshine stream is running or PC mode was switched on
(it switches itself off after the minutes you gave, 30 by default), rate limited, text length limited, and a short list
of keys (no Windows key, no Alt+F4, no Ctrl+Alt+Delete). If Windows refuses the input (the secure desktop is up) the call
answers ok:false and nothing else happens.

EVENT TYPES
  {"t":"move","dx":5,"dy":-3}          move the pointer by a few pixels
  {"t":"click","b":"left|right|middle","n":1|2}
  {"t":"down","b":"left"} / {"t":"up","b":"left"}     for dragging
  {"t":"scroll","dy":-120,"dx":0}      wheel clicks in 1/120 units, negative = scroll down like a finger swipe up
  {"t":"key","k":"enter"}              one key (names below)
  {"t":"text","s":"hello"}             type text
  {"t":"hotkey","k":["ctrl","l"]}      a shortcut

PCINPUT_DRYRUN=1 logs the events instead of sending them (tests); GET /api/pc/status shows the last ones.
"""
import asyncio
import ipaddress
import json
import logging
import os
import re
import subprocess
import sys
import time
import urllib.request

log = logging.getLogger("pcinput")

SUNSHINE_INFO = "http://127.0.0.1:47989/serverinfo"
MOONLIGHT = "com.limelight"
APPS = ("Vidbox", "Desktop")


def enabled():
    """Parked feature: off unless config.json has "pc_streaming": true (or PC_STREAMING=1). Off hides the TV tiles, the phone
    Computer block and every /api/pc route. See archive/streaming-2026-11/README.md in the workspace."""
    if os.environ.get("PC_STREAMING") == "1":
        return True
    try:
        import config
        return bool(config.CONFIG.get("pc_streaming"))
    except Exception:  # noqa: BLE001
        return False
DRY = bool(os.environ.get("PCINPUT_DRYRUN"))
MODE_MAX_MIN = 120
EVENTS_MAX = 40
TEXT_MAX = 300

# --------------------------------------------------------------------------- state
_state = {"mode_until": 0.0, "sun": None, "sun_at": 0.0, "app": None, "tokens": 120.0, "tok_at": time.monotonic()}
_dry_log = []


# --------------------------------------------------------------------------- Windows input
if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    _u32 = ctypes.windll.user32
    try:
        _u32.SetProcessDPIAware()   # so pixels mean pixels on a scaled display
    except Exception:  # noqa: BLE001
        pass
    _ULONG_PTR = ctypes.c_size_t

    class _MOUSEINPUT(ctypes.Structure):
        _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                    ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", _ULONG_PTR)]

    class _KEYBDINPUT(ctypes.Structure):
        _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                    ("time", wintypes.DWORD), ("dwExtraInfo", _ULONG_PTR)]

    class _HARDWAREINPUT(ctypes.Structure):
        _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD)]

    class _INPUTUNION(ctypes.Union):
        _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT), ("hi", _HARDWAREINPUT)]

    class _INPUT(ctypes.Structure):
        _anonymous_ = ("u",)
        _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]

    class _POINT(ctypes.Structure):
        _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]

    INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
    MOUSEEVENTF = {"left": (0x0002, 0x0004), "right": (0x0008, 0x0010), "middle": (0x0020, 0x0040)}
    MOUSEEVENTF_WHEEL, MOUSEEVENTF_HWHEEL = 0x0800, 0x1000
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE = 0x0001, 0x0002, 0x0004
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 76, 77, 78, 79

    def _send(inputs):
        arr = (_INPUT * len(inputs))(*inputs)
        return _u32.SendInput(len(inputs), arr, ctypes.sizeof(_INPUT))

    def _mouse(flags, data=0):
        i = _INPUT(type=INPUT_MOUSE)
        i.mi = _MOUSEINPUT(0, 0, data & 0xFFFFFFFF, flags, 0, 0)
        return i

    def _key(vk=0, scan=0, flags=0):
        i = _INPUT(type=INPUT_KEYBOARD)
        i.ki = _KEYBDINPUT(vk, scan, flags, 0, 0)
        return i

    def os_move(dx, dy):
        p = _POINT()
        if not _u32.GetCursorPos(ctypes.byref(p)):
            return False
        x0, y0 = _u32.GetSystemMetrics(SM_XVIRTUALSCREEN), _u32.GetSystemMetrics(SM_YVIRTUALSCREEN)
        w, h = _u32.GetSystemMetrics(SM_CXVIRTUALSCREEN), _u32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
        nx = min(max(p.x + int(dx), x0), x0 + w - 1)
        ny = min(max(p.y + int(dy), y0), y0 + h - 1)
        return bool(_u32.SetCursorPos(nx, ny))

    def os_button(b, down=None, up=None):
        d, u = MOUSEEVENTF[b]
        seq = []
        if down is None and up is None:
            seq = [_mouse(d), _mouse(u)]
        elif down:
            seq = [_mouse(d)]
        else:
            seq = [_mouse(u)]
        return _send(seq) == len(seq)

    def os_scroll(dy, dx):
        seq = []
        if dy:
            seq.append(_mouse(MOUSEEVENTF_WHEEL, int(dy)))
        if dx:
            seq.append(_mouse(MOUSEEVENTF_HWHEEL, int(dx)))
        return bool(seq) and _send(seq) == len(seq)

    def os_vk(vk, extended=False, down=True, up=True):
        fl = KEYEVENTF_EXTENDEDKEY if extended else 0
        seq = []
        if down:
            seq.append(_key(vk, 0, fl))
        if up:
            seq.append(_key(vk, 0, fl | KEYEVENTF_KEYUP))
        return _send(seq) == len(seq)

    def os_text(s):
        seq = []
        for ch in s:
            code = ord(ch)
            units = [code] if code < 0x10000 else [0xD800 + ((code - 0x10000) >> 10), 0xDC00 + ((code - 0x10000) & 0x3FF)]
            for u in units:
                seq.append(_key(0, u, KEYEVENTF_UNICODE))
                seq.append(_key(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
        return bool(seq) and _send(seq) == len(seq)
else:  # not Windows: only the dry run works
    def _no(*a, **k):
        return False
    os_move = os_button = os_scroll = os_vk = os_text = _no


# --------------------------------------------------------------------------- keys
# name -> (virtual key code, extended)
KEYS = {"enter": (0x0D, False), "backspace": (0x08, False), "tab": (0x09, False), "esc": (0x1B, False),
        "space": (0x20, False), "left": (0x25, True), "up": (0x26, True), "right": (0x27, True), "down": (0x28, True),
        "home": (0x24, True), "end": (0x23, True), "pageup": (0x21, True), "pagedown": (0x22, True),
        "delete": (0x2E, True), "f4": (0x73, False), "f5": (0x74, False), "f11": (0x7A, False),
        "volumeup": (0xAF, False), "volumedown": (0xAE, False), "mute": (0xAD, False),
        "playpause": (0xB3, False), "next": (0xB0, False), "prev": (0xB1, False)}
for _c in "abcdefghijklmnopqrstuvwxyz":
    KEYS[_c] = (ord(_c.upper()), False)
for _c in "0123456789":
    KEYS[_c] = (ord(_c), False)
MODS = {"ctrl": 0xA2, "shift": 0xA0, "alt": 0xA4}


def _hotkey_ok(keys):
    """A short list of shortcuts; nothing that closes windows wholesale, switches users or reaches the secure screen."""
    ks = [str(k).lower() for k in keys]
    if not ks or len(ks) > 4 or any(k not in KEYS and k not in MODS for k in ks):
        return False
    mods = [k for k in ks if k in MODS]
    rest = [k for k in ks if k not in MODS]
    if len(rest) != 1:
        return False
    if "alt" in mods and rest[0] in ("f4", "tab", "esc"):
        return False
    if "ctrl" in mods and "alt" in mods:
        return False
    if "ctrl" in mods and "shift" in mods and rest[0] in ("esc", "delete"):
        return False
    return True


# --------------------------------------------------------------------------- doing one event
def _do(ev):
    """Run one event. Returns True when it was carried out (or logged, in a dry run)."""
    t = ev.get("t")
    if t == "key" and str(ev.get("k") or "").lower() not in KEYS:
        return False
    if t == "hotkey" and not _hotkey_ok(ev.get("k") or []):
        return False
    if DRY:   # same checks as the real thing, but only logged
        _dry_log.append(ev)
        del _dry_log[:-60]
        return t in ("move", "click", "down", "up", "scroll", "key", "text", "hotkey")
    if t == "move":
        return os_move(_num(ev.get("dx"), 400), _num(ev.get("dy"), 400))
    if t == "click":
        b = ev.get("b") if ev.get("b") in MOUSEEVENTF else "left"
        ok = os_button(b)
        if ok and ev.get("n") == 2:
            ok = os_button(b)
        return ok
    if t in ("down", "up"):
        b = ev.get("b") if ev.get("b") in MOUSEEVENTF else "left"
        return os_button(b, down=(t == "down"), up=(t == "up"))
    if t == "scroll":
        return os_scroll(_num(ev.get("dy"), 1200), _num(ev.get("dx"), 1200))
    if t == "key":
        k = str(ev.get("k") or "").lower()
        if k not in KEYS:
            return False
        vk, ext = KEYS[k]
        return os_vk(vk, ext)
    if t == "text":
        s = str(ev.get("s") or "")[:TEXT_MAX]
        ok = True
        for part in re.split(r"(\r\n|\n|\r)", s):
            if part in ("\n", "\r", "\r\n"):
                ok = os_vk(0x0D) and ok
            else:
                part = "".join(c for c in part if c >= " " and c != "\x7f")
                if part:
                    ok = os_text(part) and ok
        return ok
    if t == "hotkey":
        ks = [str(k).lower() for k in (ev.get("k") or [])]
        if not _hotkey_ok(ks):
            return False
        mods = [MODS[k] for k in ks if k in MODS]
        vk, ext = KEYS[[k for k in ks if k not in MODS][0]]
        ok = True
        for m in mods:
            ok = os_vk(m, down=True, up=False) and ok
        ok = os_vk(vk, ext) and ok
        for m in reversed(mods):
            os_vk(m, down=False, up=True)   # always release, even if the key press failed
        return ok
    return False


def _num(v, limit):
    try:
        return max(-limit, min(limit, float(v)))
    except (TypeError, ValueError):
        return 0


# --------------------------------------------------------------------------- Sunshine
def _sunshine_blocking():
    """What Sunshine says about itself without a login: running? is a stream on? Cached for a moment by the caller."""
    try:
        with urllib.request.urlopen(SUNSHINE_INFO, timeout=1.5) as r:
            x = r.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return {"up": False, "busy": False, "uuid": None, "name": None}
    g = lambda tag: (re.search(r"<%s>([^<]*)</%s>" % (tag, tag), x) or [None, None])[1]  # noqa: E731
    busy = (g("state") or "").endswith("BUSY") or (g("currentgame") or "0") not in ("0", "")
    return {"up": True, "busy": busy, "uuid": g("uniqueid"), "name": g("hostname")}


async def sunshine(max_age=1.5):
    now = time.monotonic()
    if _state["sun"] is None or now - _state["sun_at"] > max_age:
        _state["sun"] = await asyncio.to_thread(_sunshine_blocking)
        _state["sun_at"] = time.monotonic()
    return _state["sun"]


def sunshine_installed():
    return os.path.exists(os.path.join(os.environ.get("ProgramFiles", ""), "Sunshine", "sunshine.exe"))


def screens_default():
    """The two PC tiles for the TV home screen, but only on a computer that has Sunshine installed."""
    if not enabled() or not sunshine_installed():
        return []
    return [{"id": "pc-vidbox", "name": "Vidbox on PC", "kind": "moonlight", "app": "Vidbox", "fallback": "vidbox"},
            {"id": "pc-desktop", "name": "PC Desktop", "kind": "moonlight", "app": "Desktop"}]


def _kill_kiosk_edge():
    """Close only the Edge windows started with our kiosk profile; never the owner's normal Edge."""
    ps = ("Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
          "Where-Object { $_.CommandLine -like '*streaming*kiosk-profile*' } | "
          "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }")
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=15,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return len([ln for ln in r.stdout.split() if ln.strip().isdigit()])
    except Exception as e:  # noqa: BLE001
        log.warning("kiosk close failed: %s", e)
        return 0


def _wake_screen():
    """Dismiss the screensaver / wake the display: a 1-pixel mouse nudge and back (counts as real input)."""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        u = ctypes.windll.user32
        u.mouse_event(0x0001, 1, 0, 0, 0)
        u.mouse_event(0x0001, -1, 0, 0, 0)
    except Exception as e:  # noqa: BLE001
        log.warning("wake screen failed: %s", e)


_awake = {"thread": None}


def _awake_loop():
    """While a stream is on, tell Windows the display is in use so the screensaver and screen-off timer stay away."""
    import ctypes
    ES_CONTINUOUS, ES_SYSTEM_REQUIRED, ES_DISPLAY_REQUIRED = 0x80000000, 0x00000001, 0x00000002
    k = ctypes.windll.kernel32
    try:
        while _state.get("app"):
            k.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
            time.sleep(20)
    finally:
        k.SetThreadExecutionState(ES_CONTINUOUS)
        _awake["thread"] = None


def _keep_awake():
    if sys.platform != "win32":
        return
    th = _awake.get("thread")
    if th is not None and th.is_alive():
        return
    import threading
    th = threading.Thread(target=_awake_loop, name="pc-awake", daemon=True)
    _awake["thread"] = th
    th.start()


async def stream_start(S, app):
    """Start the Moonlight stream of `app` on the TV (the shortcut skips Moonlight's own menus)."""
    if app not in APPS:
        raise S.ApiError(400, "app must be Vidbox or Desktop")
    sun = await sunshine(0)
    if not sun["up"] or not sun["uuid"]:
        raise S.ApiError(409, "Sunshine isn't running on the computer. Double-click START-SUNSHINE.cmd in the streaming folder.")
    await asyncio.to_thread(_wake_screen)
    cmd = ("am start -n %s/.ShortcutTrampoline --es UUID %s --es Name %s --es AppName %s"
           % (MOONLIGHT, sun["uuid"], (sun["name"] or "PC").replace(" ", "-"), app))
    try:
        await S.tv.adb("shell", cmd, timeout=15)
    except Exception as e:  # noqa: BLE001
        raise S.ApiError(503, "Couldn't reach the TV to start the stream (%s)." % str(e)[:80])
    _state["app"] = app
    _keep_awake()
    return {"app": app}


async def stream_stop(S):
    closed = await asyncio.to_thread(_kill_kiosk_edge)
    err = None
    try:
        await S.tv.adb("shell", "am force-stop %s; input keyevent KEYCODE_HOME" % MOONLIGHT, timeout=15)
    except Exception as e:  # noqa: BLE001
        err = str(e)[:80]
    _state["app"] = None
    _state["sun_at"] = 0
    return {"closed_pc_windows": closed, "tv": "ok" if not err else err}


# --------------------------------------------------------------------------- HTTP
def _lan(request):
    ip = (request.remote or "").split("%")[0]
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return a.is_loopback or a.is_private or a.is_link_local


def _take(n=1.0):
    """Rate limit: about 150 events a second, bursts up to 150."""
    now = time.monotonic()
    _state["tokens"] = min(150.0, _state["tokens"] + (now - _state["tok_at"]) * 150.0)
    _state["tok_at"] = now
    if _state["tokens"] < n:
        return False
    _state["tokens"] -= n
    return True


def routes(r, S):
    def guard(request):
        if not enabled():
            raise S.ApiError(404, "PC streaming is switched off.")
        if not _lan(request):
            raise S.ApiError(403, "PC mode only works from the home network.")

    async def status():
        sun = await sunshine()
        mode = _state["mode_until"] > time.time()
        return {"sunshine": sun["up"], "streaming": sun["busy"], "app": _state["app"], "mode": mode,
                "mode_left": max(0, int(_state["mode_until"] - time.time())) if mode else 0,
                "can_input": bool(sun["busy"] or mode), "dry_run": DRY,
                "moonlight_pc": sun["name"]}

    async def h_status(request):
        if not enabled():
            return S.ok(enabled=False)
        guard(request)
        s = await status()
        if DRY:
            s["last"] = list(_dry_log[-10:])
        return S.ok(**s)

    async def h_mode(request):
        guard(request)
        d = await S.body(request)
        if d.get("on"):
            mins = max(1, min(MODE_MAX_MIN, int(_num(d.get("minutes", 30), MODE_MAX_MIN))))
            _state["mode_until"] = time.time() + mins * 60
        else:
            _state["mode_until"] = 0.0
        return S.ok(**(await status()))

    async def h_input(request):
        guard(request)
        d = await S.body(request)
        evs = d.get("events") if isinstance(d.get("events"), list) else [d]
        evs = [e for e in evs if isinstance(e, dict)][:EVENTS_MAX]
        if not evs:
            raise S.ApiError(400, "send an event")
        sun = await sunshine()
        if not (sun["busy"] or _state["mode_until"] > time.time()):
            raise S.ApiError(409, "PC mode is off. Start a stream or switch PC mode on first.")
        if not _take(len(evs)):
            raise S.ApiError(429, "Slow down a little.")
        done = 0
        for e in evs:
            try:
                if _do(e):
                    done += 1
            except Exception as ex:  # noqa: BLE001
                log.warning("pc input failed: %s", ex)
        return S.ok(done=done, of=len(evs), ok_all=(done == len(evs)))

    async def h_stream(request):
        guard(request)
        d = await S.body(request)
        action = d.get("action")
        if action == "start":
            res = await stream_start(S, d.get("app") or "Vidbox")
            return S.ok(**res)
        if action == "stop":
            return S.ok(**(await stream_stop(S)))
        raise S.ApiError(400, "action must be start or stop")

    r.add_get("/api/pc/status", h_status)
    r.add_post("/api/pc/mode", h_mode)
    r.add_post("/api/pc/input", h_input)
    r.add_post("/api/pc/stream", h_stream)
