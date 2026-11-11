"""Wallpaper Engine wallpapers as the TV's home background.

Read-only on Steam's folders. The owner's Wallpaper Engine library (Steam app 431960) is scanned for
project.json files; video wallpapers are served to the TV as a muted H.264 loop (the original file when it is
already TV friendly, otherwise a transcode kept in data/wallpapers/); scene/web wallpapers have no video we can
play, so their preview picture (jpg/png/gif) is the background. Live rendering of those would need the PC to
stream them (see docs/STREAMING-PLAN.md), which this does not do.

Routes (registered by register(r) in server.py):
  GET  /api/wallpapers                 the list, what is chosen, whether ffmpeg is there
  GET  /api/wallpapers/{id}/preview    the wallpaper's preview picture (thumbnail)
  GET  /api/wallpapers/{id}/status     video preparation state (ready / preparing / error)
  GET  /api/wallpaper                  the current choice {id, t, state, url, kind}
  POST /api/wallpaper                  {"id": "scenes" | "<id>", "t": <ms, optional>} choose one
  GET  /wp/{id}.mp4                    the TV-friendly video (Range supported)
"""
import asyncio
import glob
import json
import os
import re
import shutil
import subprocess
import tempfile
import time

from aiohttp import web

import config

DATA_DIR = os.path.join(config.DATA, "wallpapers")
CHOICE_FILE = os.path.join(config.DATA, "wallpaper.json")
APP_ID = "431960"
SCAN_TTL = 60.0

_scan_cache = {"at": 0.0, "items": {}, "engine": None}
_jobs = {}            # id -> {"state": "preparing"|"error", "detail": str, "started": float}
_probe_cache = {}     # path+mtime -> probe dict
_worker_busy = False


# ---------- finding Wallpaper Engine ----------
def _steam_libraries():
    libs = []
    steam = None
    try:
        import winreg
        for hive, key in ((winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"),
                          (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam")):
            try:
                with winreg.OpenKey(hive, key) as k:
                    steam = winreg.QueryValueEx(k, "SteamPath" if hive == winreg.HKEY_CURRENT_USER else "InstallPath")[0]
                    break
            except OSError:
                continue
    except ImportError:
        pass
    steam = steam or r"C:\Program Files (x86)\Steam"
    steam = os.path.normpath(steam)
    libs.append(steam)
    vdf = os.path.join(steam, "steamapps", "libraryfolders.vdf")
    try:
        with open(vdf, encoding="utf-8", errors="replace") as f:
            for m in re.finditer(r'"path"\s+"([^"]+)"', f.read()):
                p = os.path.normpath(m.group(1).replace("\\\\", "\\"))
                if p not in libs:
                    libs.append(p)
    except OSError:
        pass
    extra = config.CONFIG.get("wallpaper_engine_dirs") or []
    for p in extra:
        if p not in libs:
            libs.append(p)
    return libs


def _load_project(folder):
    path = os.path.join(folder, "project.json")
    try:
        with open(path, encoding="utf-8-sig", errors="replace") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _folder_size(folder, cap_files=2000):
    total = 0
    n = 0
    for root, _dirs, files in os.walk(folder):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
            n += 1
            if n > cap_files:
                return total
    return total


def _item(folder, wid, source):
    pj = _load_project(folder)
    if not pj:
        return None
    typ = str(pj.get("type") or "").strip().lower()
    prev = pj.get("preview") or ""
    prev_path = os.path.join(folder, prev) if prev else ""
    if not (prev and os.path.isfile(prev_path)):
        prev_path = ""
        for ext in ("gif", "jpg", "png", "jpeg"):
            guess = os.path.join(folder, "preview." + ext)
            if os.path.isfile(guess):
                prev_path = guess
                break
    video_path = ""
    if typ == "video":
        vf = os.path.join(folder, str(pj.get("file") or ""))
        if os.path.isfile(vf):
            video_path = vf
        else:
            vids = sorted(glob.glob(os.path.join(folder, "*.mp4")) + glob.glob(os.path.join(folder, "*.webm")))
            video_path = vids[0] if vids else ""
        if not video_path:
            typ = typ or "other"
    if not prev_path and not video_path:
        return None
    rating = str(pj.get("contentrating") or "").strip()
    return {
        "id": wid, "title": str(pj.get("title") or wid)[:120], "type": typ or "other", "source": source,
        "folder": folder, "preview_path": prev_path, "video_path": video_path, "rating": rating,
        "size_mb": round(_folder_size(folder) / 1048576, 1),
    }


def scan(force=False):
    if not force and _scan_cache["items"] and time.time() - _scan_cache["at"] < SCAN_TTL:
        return _scan_cache["items"], _scan_cache["engine"]
    items = {}
    engine = None
    for lib in _steam_libraries():
        steamapps = os.path.join(lib, "steamapps")
        we = os.path.join(steamapps, "common", "wallpaper_engine")
        if os.path.isdir(we):
            engine = engine or we
            for sub, tag in (("defaultprojects", "default"), ("myprojects", "mine")):
                base = os.path.join(we, "projects", sub)
                if os.path.isdir(base):
                    for name in sorted(os.listdir(base)):
                        folder = os.path.join(base, name)
                        if os.path.isdir(folder):
                            it = _item(folder, "%s-%s" % (tag, re.sub(r"[^A-Za-z0-9_-]", "_", name)), tag)
                            if it:
                                items[it["id"]] = it
        ws = os.path.join(steamapps, "workshop", "content", APP_ID)
        if os.path.isdir(ws):
            engine = engine or ws
            for name in sorted(os.listdir(ws)):
                folder = os.path.join(ws, name)
                if name.isdigit() and os.path.isdir(folder):
                    it = _item(folder, name, "workshop")
                    if it:
                        items[it["id"]] = it
    _scan_cache.update(at=time.time(), items=items, engine=engine)
    return items, engine


# ---------- ffmpeg ----------
def find_ffmpeg():
    """PATH, then an explicit setting, then a tools folder next to the project. As a last resort the ffmpeg.exe that
    Free Download Manager ships (only run, never changed). Nothing is downloaded or installed."""
    given = config.CONFIG.get("ffmpeg") or os.environ.get("FFMPEG")
    if given and os.path.isfile(given):
        return given
    found = shutil.which("ffmpeg")
    if found:
        return found
    here = os.path.dirname(os.path.abspath(config.ROOT))
    for pat in (os.path.join(here, "tools", "ffmpeg*", "**", "ffmpeg.exe"),
                os.path.join(here, "tools", "ffmpeg*", "ffmpeg.exe"),
                os.path.join(here, "..", "tools", "ffmpeg*", "**", "ffmpeg.exe"),
                r"C:\Program Files\Softdeluxe\Free Download Manager\ffmpeg.exe"):
        for hit in glob.glob(pat, recursive=True):
            if os.path.isfile(hit):
                return hit
    return None


_enc_cache = {}


def _encoder(ff):
    if ff in _enc_cache:
        return _enc_cache[ff]
    try:
        out = subprocess.run([ff, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=20,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    except (OSError, subprocess.SubprocessError):
        out = ""
    enc = "libx264" if " libx264 " in out else ("h264_mf" if " h264_mf " in out else None)
    _enc_cache[ff] = enc
    return enc


def probe(path):
    """codec/size/fps/bitrate from `ffmpeg -i` (there is no ffprobe); None when ffmpeg is missing."""
    ff = find_ffmpeg()
    if not ff:
        return None
    try:
        key = "%s|%s" % (path, os.path.getmtime(path))
    except OSError:
        return None
    if key in _probe_cache:
        return _probe_cache[key]
    try:
        err = subprocess.run([ff, "-hide_banner", "-i", path], capture_output=True, text=True, timeout=30,
                             encoding="utf-8", errors="replace",
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stderr
    except (OSError, subprocess.SubprocessError):
        return None
    v = re.search(r"Video: (\w+).*?, (\d{2,5})x(\d{2,5})", err)
    if not v:
        return None
    fps = re.search(r"([\d.]+) fps", err)
    br = re.search(r"bitrate: (\d+) kb/s", err)
    dur = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    pix = re.search(r"Video: [^,]*(?:\([^)]*\))?[^,]*, (\w+)", err)
    info = {
        "codec": v.group(1).lower(), "w": int(v.group(2)), "h": int(v.group(3)),
        "fps": float(fps.group(1)) if fps else 30.0, "kbps": int(br.group(1)) if br else 0,
        "seconds": (int(dur.group(1)) * 3600 + int(dur.group(2)) * 60 + float(dur.group(3))) if dur else 0.0,
        "pix": pix.group(1) if pix else "",
    }
    # rotation metadata would make the shown size differ from the stored one
    if re.search(r"rotate\s*:\s*(90|270)", err):
        info["w"], info["h"] = info["h"], info["w"]
    _probe_cache[key] = info
    return info


def tv_friendly(p):
    """Plays well in the TV's hardware decoder and does not waste pixels."""
    if not p:
        return False
    ratio = p["w"] / float(p["h"] or 1)
    return (p["codec"] == "h264" and p["h"] <= 1080 and p["w"] <= 1920 and p["fps"] <= 30.5
            and (p["kbps"] or 0) <= 10000 and 1.6 <= ratio <= 1.9 and p["pix"].startswith("yuv420p"))


# ---------- recording scene and web wallpapers ----------
# Wallpaper Engine can draw a scene or web wallpaper in its own window ("-playInWindow"). ffmpeg's gfxcapture (Windows
# Graphics Capture) records that ONE window, nothing else on the screen. We record a short loop once per wallpaper, keep it
# (like a converted video) and the TV plays it, so scene wallpapers move on the TV. One recording at a time, low priority.
_rec_cache = {}


def we_exe():
    if "exe" not in _rec_cache:
        found = None
        for lib in _steam_libraries():
            p = os.path.join(lib, "steamapps", "common", "wallpaper_engine", "wallpaper64.exe")
            if os.path.isfile(p):
                found = p
                break
        _rec_cache["exe"] = found
    return _rec_cache["exe"]


def _has_gfxcapture(ff):
    k = "gfx:" + ff
    if k not in _rec_cache:
        try:
            out = subprocess.run([ff, "-hide_banner", "-filters"], capture_output=True, text=True, timeout=20,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
        except (OSError, subprocess.SubprocessError):
            out = ""
        _rec_cache[k] = " gfxcapture " in out
    return _rec_cache[k]


def capturable(it):
    """A scene or web wallpaper the PC can record (needs Wallpaper Engine and an ffmpeg with gfxcapture)."""
    if it["type"] not in ("scene", "web") or config.CONFIG.get("wallpaper_record") is False:
        return False
    if not os.path.isfile(os.path.join(it["folder"], "project.json")):
        return False
    ff = find_ffmpeg()
    return bool(ff and we_exe() and _has_gfxcapture(ff) and _encoder(ff))


def playable(it):
    return (it["type"] == "video" and bool(it["video_path"])) or capturable(it)


def _rec_path(it):
    try:
        m = int(os.path.getmtime(os.path.join(it["folder"], "project.json")))
    except OSError:
        m = 0
    return os.path.join(DATA_DIR, "%s-rec-1080p-%d.mp4" % (it["id"], m))


def _find_window(title):
    try:
        import ctypes
        return int(ctypes.windll.user32.FindWindowW(None, title) or 0)
    except Exception:  # noqa: BLE001
        return 0


def _close_window(hwnd):
    try:
        import ctypes
        ctypes.windll.user32.PostMessageW(hwnd, 0x0010, 0, 0)   # WM_CLOSE: only our own recording window
    except Exception:  # noqa: BLE001
        pass


def _looks_black(ff, path):
    try:
        r = subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-ss", "4", "-i", path, "-frames:v", "1",
                            "-vf", "scale=16:9", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                           capture_output=True, timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        data = r.stdout
        return bool(data) and (sum(data) / float(len(data))) < 6
    except (OSError, subprocess.SubprocessError):
        return False


def _record(it):
    global _worker_busy
    ff = find_ffmpeg()
    enc = _encoder(ff) if ff else None
    exe = we_exe()
    out = _rec_path(it)
    title = "tvos-rec-%s" % re.sub(r"[^A-Za-z0-9]", "", it["id"])
    hwnd = 0
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        for old in glob.glob(os.path.join(DATA_DIR, it["id"] + "-rec-*.mp4")):
            if old != out:
                try:
                    os.remove(old)
                except OSError:
                    pass
        tmp = out + ".part.mp4"
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        subprocess.Popen([exe, "-control", "openWallpaper", "-file", os.path.join(it["folder"], "project.json"),
                          "-playInWindow", title, "-width", "1920", "-height", "1080"], creationflags=flags)
        end = time.time() + 40
        while time.time() < end and not hwnd:
            time.sleep(0.5)
            hwnd = _find_window(title)
        if not hwnd:
            raise RuntimeError("Wallpaper Engine did not open this wallpaper")
        time.sleep(float(config.CONFIG.get("wallpaper_record_settle") or 10))   # let the scene load and start moving
        secs = int(config.CONFIG.get("wallpaper_record_seconds") or 20)
        src = "gfxcapture=window_title=%s:capture_cursor=0:max_framerate=30,hwdownload,format=bgra," % title
        src += "scale=1920:1080:flags=bicubic,fps=30,format=yuv420p"
        cmd = [ff, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", src, "-t", str(secs), "-an",
               "-c:v", enc, "-b:v", "7000k", "-maxrate", "9000k", "-bufsize", "14000k", "-g", "60",
               "-movflags", "+faststart"]
        if enc == "libx264":
            cmd += ["-preset", "veryfast", "-profile:v", "high", "-level", "4.1", "-threads", "2"]
        cmd += [tmp]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=secs + 120, creationflags=flags | getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0),
                           encoding="utf-8", errors="replace")
        if r.returncode != 0 or not os.path.isfile(tmp) or os.path.getsize(tmp) < 50000:
            raise RuntimeError((r.stderr or "the recording failed").strip().splitlines()[-1][:200] if (r.stderr or "").strip() else "the recording failed")
        if _looks_black(ff, tmp):
            os.remove(tmp)
            raise RuntimeError("Wallpaper Engine drew nothing for this one")
        os.replace(tmp, out)
        _jobs.pop(it["id"], None)
    except Exception as e:  # noqa: BLE001
        _jobs[it["id"]] = {"state": "error", "detail": str(e)[:240], "started": time.time()}
    finally:
        if hwnd or _find_window(title):
            _close_window(hwnd or _find_window(title))
        _worker_busy = False


# ---------- preparing a video ----------
def _height():
    """1080 (default) or 720: set "wallpaper_height" in config.json if a video makes the TV warm or janky."""
    try:
        return 720 if int(config.CONFIG.get("wallpaper_height") or 1080) <= 720 else 1080
    except (TypeError, ValueError):
        return 1080


def _cached_path(it):
    try:
        m = int(os.path.getmtime(it["video_path"]))
    except OSError:
        m = 0
    return os.path.join(DATA_DIR, "%s-%dp-%d.mp4" % (it["id"], _height(), m))


def video_state(it):
    """('ready', path) | ('preparing', None) | ('error', detail) | ('none', None)"""
    if capturable(it):
        job = _jobs.get(it["id"])
        done = _rec_path(it)
        if os.path.isfile(done):
            return "ready", done
        if job and job["state"] == "preparing":
            return "preparing", None
        if job and job["state"] == "error":
            return "error", job["detail"]
        return "idle", None
    if it["type"] != "video" or not it["video_path"]:
        return "none", None
    job = _jobs.get(it["id"])
    done = _cached_path(it)
    if os.path.isfile(done):
        return "ready", done
    ff = find_ffmpeg()
    if ff is None:
        # Without ffmpeg we can only offer the original and cannot check it. Small H.264 files are common but not certain.
        return "error", "ffmpeg isn't on this PC, so videos can't be checked or converted for the TV."
    if job and job["state"] == "preparing":
        return "preparing", None
    if job and job["state"] == "error":
        return "error", job["detail"]
    p = probe(it["video_path"])
    if tv_friendly(p):
        return "ready", it["video_path"]
    return "idle", None


def _transcode(it):
    global _worker_busy
    ff = find_ffmpeg()
    enc = _encoder(ff) if ff else None
    out = _cached_path(it)
    try:
        if not enc:
            raise RuntimeError("this ffmpeg has no H.264 encoder")
        os.makedirs(DATA_DIR, exist_ok=True)
        # drop older conversions of the same wallpaper
        for old in glob.glob(os.path.join(DATA_DIR, it["id"] + "-*.mp4")):
            if old != out:
                try:
                    os.remove(old)
                except OSError:
                    pass
        tmp = out + ".part.mp4"
        # centre-crop to 16:9 (dual-monitor and portrait files), then 1080p30, no sound, ~7 Mbps
        hh = _height()
        vf = ("crop=w='min(iw,ih*16/9)':h='min(ih,iw*9/16)',scale=-2:'min(%d,ih)'," % hh +
              "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30,format=%s" % ("nv12" if enc == "h264_mf" else "yuv420p"))
        cmd = [ff, "-hide_banner", "-loglevel", "error", "-y", "-i", it["video_path"], "-an", "-sn", "-dn",
               "-vf", vf, "-c:v", enc, "-b:v", "7000k" if hh > 720 else "3500k", "-maxrate", "9000k" if hh > 720 else "5000k", "-bufsize", "14000k",
               "-g", "60", "-movflags", "+faststart"]
        if enc == "libx264":
            cmd += ["-preset", "medium", "-profile:v", "high", "-level", "4.1"]
        cmd += [tmp]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600, creationflags=flags,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0 or not os.path.isfile(tmp) or os.path.getsize(tmp) < 1024:
            raise RuntimeError((r.stderr or "ffmpeg failed").strip().splitlines()[-1][:200])
        os.replace(tmp, out)
        _jobs.pop(it["id"], None)
    except Exception as e:  # noqa: BLE001 - reported to the person, not raised
        _jobs[it["id"]] = {"state": "error", "detail": str(e)[:240], "started": time.time()}
    finally:
        _worker_busy = False


async def prepare(it):
    """Start converting (once at a time). Returns the state afterwards."""
    global _worker_busy
    st, _ = video_state(it)
    if st != "idle":
        return st
    if _worker_busy:
        return "preparing"
    _worker_busy = True
    _jobs[it["id"]] = {"state": "preparing", "detail": "", "started": time.time()}
    asyncio.get_running_loop().run_in_executor(None, _record if capturable(it) else _transcode, it)
    return "preparing"


# ---------- pictures sized for the TV ----------
_img_sem = None


def _make_image(it, kind):
    """thumb (360x202, for the picker/phone) or still (1920x1080, the background) as a cached JPEG made with ffmpeg
    from the wallpaper's preview picture (the first frame of a gif). Returns a path (the original preview if
    ffmpeg is missing or fails)."""
    src = it["preview_path"]
    if not src:
        return None
    # a video wallpaper's still is a frame of the video itself (full HD); the preview picture is small and soft
    vsrc = it["video_path"] if it["type"] == "video" and it["video_path"] else ""
    if not vsrc and capturable(it) and os.path.isfile(_rec_path(it)):
        vsrc = _rec_path(it)
    from_video = kind == "still" and bool(vsrc) and os.path.isfile(vsrc)
    pick = vsrc if from_video else src
    ff = find_ffmpeg()
    if not ff:
        return src
    try:
        m = int(os.path.getmtime(pick))
    except OSError:
        return src
    out_dir = os.path.join(DATA_DIR, "img")
    out = os.path.join(out_dir, "%s-%s%s-%d.jpg" % (it["id"], kind, "-hd" if from_video else "", m))
    if os.path.isfile(out):
        return out
    w, h, q = (360, 202, "5") if kind == "thumb" else (1920, 1080, "3")
    os.makedirs(out_dir, exist_ok=True)
    tmp = out + ".part.jpg"
    cmd = [ff, "-hide_banner", "-loglevel", "error", "-y"] + (["-ss", "2"] if from_video else []) + ["-i", pick, "-frames:v", "1",
           "-vf", "scale=%d:%d:force_original_aspect_ratio=increase:flags=bicubic,crop=%d:%d,format=yuvj420p" % (w, h, w, h),
           "-q:v", q, tmp]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=60, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if r.returncode == 0 and os.path.isfile(tmp) and os.path.getsize(tmp) > 200:
            os.replace(tmp, out)
            return out
    except (OSError, subprocess.SubprocessError):
        pass
    return src


async def _image(request, kind):
    global _img_sem
    items, _ = scan()
    it = items.get(request.match_info["id"])
    if not it or not it["preview_path"]:
        raise web.HTTPNotFound()
    if _img_sem is None:
        _img_sem = asyncio.Semaphore(2)
    async with _img_sem:
        path = await asyncio.get_running_loop().run_in_executor(None, _make_image, it, kind)
    return web.FileResponse(path, headers={"Cache-Control": "public, max-age=86400"})


async def h_thumb(request):
    return await _image(request, "thumb")


async def h_still(request):
    return await _image(request, "still")


# ---------- the choice ----------
def _choice_file():
    """Each TV has its own wallpaper choice (the default TV keeps wallpaper.json)."""
    tv = config.CURRENT_TV.get()
    if not tv or tv == config.DEFAULT_TV or not all(c.isalnum() or c == "-" for c in tv):
        return CHOICE_FILE
    return os.path.join(config.DATA, "wallpaper.%s.json" % tv)


def read_choice():
    try:
        with open(_choice_file(), encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("id"), str):
            return {"id": d["id"], "t": int(d.get("t") or 0)}
    except (OSError, ValueError):
        pass
    return {"id": "scenes", "t": 0}


def write_choice(wid, t=None):
    os.makedirs(config.DATA, exist_ok=True)
    d = {"id": wid, "t": int(t or time.time() * 1000)}
    fd, tmp = tempfile.mkstemp(dir=config.DATA, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(d, f)
    os.replace(tmp, _choice_file())
    return d


def _public(it):
    st, detail = video_state(it)
    return {"id": it["id"], "title": it["title"], "type": it["type"], "source": it["source"], "rating": it["rating"],
            "size_mb": it["size_mb"], "video": playable(it), "rec": capturable(it),
            "state": st, "preview": "/api/wallpapers/%s/thumb" % it["id"]}


def _state_for(wid):
    if wid == "scenes":
        return {"id": "scenes", "kind": "scenes", "state": "ready"}
    items, _ = scan()
    it = items.get(wid)
    if not it:
        return {"id": wid, "kind": "missing", "state": "error", "detail": "That wallpaper isn't on the computer any more."}
    if playable(it):
        st, detail = video_state(it)
        d = {"id": wid, "kind": "video", "state": st, "poster": "/api/wallpapers/%s/still" % wid}
        if st == "ready":
            d["url"] = "/wp/%s.mp4" % wid
        if st == "error":
            d["detail"] = detail
        return d
    return {"id": wid, "kind": "image", "state": "ready", "url": "/api/wallpapers/%s/still" % wid}


# ---------- handlers ----------
def _json(data, status=200):
    return web.json_response(data, status=status, headers={"Cache-Control": "no-store"})


async def h_list(request):
    loop = asyncio.get_running_loop()
    items, engine = await loop.run_in_executor(None, scan, request.query.get("refresh") == "1")
    hide_mature = not config.CONFIG.get("wallpaper_allow_mature")
    out = []
    for it in items.values():
        if hide_mature and it["rating"].lower() in ("mature", "questionable"):
            continue
        out.append({"id": it["id"], "title": it["title"], "type": it["type"], "source": it["source"],
                    "rating": it["rating"], "size_mb": it["size_mb"], "video": playable(it), "rec": capturable(it),
                    "preview": "/api/wallpapers/%s/thumb" % it["id"]})
    out.sort(key=lambda x: (0 if x["video"] and not x["rec"] else (1 if x["video"] else 2), x["title"].lower()))
    ff = await loop.run_in_executor(None, find_ffmpeg)
    return _json({"ok": True, "engine": bool(engine), "ffmpeg": bool(ff), "count": len(out), "items": out,
                  "current": read_choice()})


async def h_preview(request):
    items, _ = scan()
    it = items.get(request.match_info["id"])
    if not it or not it["preview_path"]:
        raise web.HTTPNotFound()
    return web.FileResponse(it["preview_path"], headers={"Cache-Control": "public, max-age=86400"})


async def h_status(request):
    items, _ = scan()
    it = items.get(request.match_info["id"])
    if not it:
        raise web.HTTPNotFound()
    return _json(dict(_state_for(it["id"]), ok=True))


async def h_current(request):
    loop = asyncio.get_running_loop()
    c = read_choice()
    s = await loop.run_in_executor(None, _state_for, c["id"])
    if s.get("state") == "idle":   # chosen, but the conversion never ran (the bridge restarted meanwhile): start it again
        items, _ = scan()
        if c["id"] in items:
            s["state"] = await prepare(items[c["id"]])
    return _json(dict(s, ok=True, t=c["t"]))


async def h_choose(request):
    try:
        body = await request.json()
    except ValueError:
        body = {}
    wid = str(body.get("id") or "")
    if wid != "scenes":
        items, _ = scan()
        if wid not in items:
            return _json({"ok": False, "error": "That wallpaper isn't available."}, 404)
        it = items[wid]
        if playable(it):
            await prepare(it)
    c = write_choice(wid, body.get("t"))
    loop = asyncio.get_running_loop()
    s = await loop.run_in_executor(None, _state_for, wid)
    return _json(dict(s, ok=True, t=c["t"]))


async def h_video(request):
    wid = request.match_info["id"]
    items, _ = scan()
    it = items.get(wid)
    if not it or not playable(it):
        raise web.HTTPNotFound()
    st, path = await asyncio.get_running_loop().run_in_executor(None, video_state, it)
    if st == "idle":
        await prepare(it)
        st = "preparing"
    if st != "ready":
        return _json({"ok": False, "state": st, "error": "The video isn't ready yet."}, 409 if st == "preparing" else 503)
    return web.FileResponse(path, headers={"Cache-Control": "public, max-age=3600", "Content-Type": "video/mp4"})


def register(r):
    r.add_get("/api/wallpapers", h_list)
    r.add_get("/api/wallpapers/{id}/preview", h_preview)
    r.add_get("/api/wallpapers/{id}/thumb", h_thumb)
    r.add_get("/api/wallpapers/{id}/still", h_still)
    r.add_get("/api/wallpapers/{id}/status", h_status)
    r.add_get("/api/wallpaper", h_current)
    r.add_post("/api/wallpaper", h_choose)
    r.add_get(r"/wp/{id}.mp4", h_video)
