"""Which home screen the TV's Home button opens: this one, or the TV's own (Google TV).

Only for a TV whose config.json entry has a "home_switch" block, for example:

  "home_switch": {
    "google_packages": ["com.google.android.apps.tv.launcherx", "com.google.android.tungsten.setupwraith"],
    "google_home": "com.google.android.apps.tv.launcherx/.home.HomeActivity",
    "ours": "app.couchtv.launcher/.MainActivity"
  }

It talks to the TV with the real adb program (so Wireless debugging works too), never uninstalls anything, and
only disables / enables the packages listed. "ours" makes this home the default and switches Google's off;
"google" switches Google's back on, makes it the default again and opens it. Needs the "adb_path" in config.json
(or adb on the PATH).
"""
import asyncio
import os
import re
import shutil
import subprocess

import config

NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _adb():
    p = config.CONFIG.get("adb_path")
    if p and os.path.isfile(p):
        return p
    return shutil.which("adb")


def _tv(tv_id):
    for t in config.TVS:
        if t["id"] == tv_id:
            return t
    return None


def available(tv_id):
    t = _tv(tv_id)
    return bool(t and isinstance(t.get("home_switch"), dict) and _adb())


def _run(args, timeout=25):
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, creationflags=NOWIN,
                       encoding="utf-8", errors="replace")
    return ((r.stdout or "") + (r.stderr or "")).strip()


def _endpoint(adb, ip):
    """Wireless debugging uses a changing port: ask adb which one this TV announces, else the usual 5555."""
    try:
        out = _run([adb, "mdns", "services"], 15)
    except (OSError, subprocess.SubprocessError):
        out = ""
    for line in out.splitlines():
        m = re.search(r"_adb-tls-connect\._tcp\s+(%s:\d+)" % re.escape(ip), line)
        if m:
            return m.group(1)
    return "%s:5555" % ip


def _sh(adb, ep, cmd):
    return _run([adb, "-s", ep, "shell", cmd])


def _state_sync(tv_id):
    t = _tv(tv_id)
    cfg = t["home_switch"]
    adb = _adb()
    ep = _endpoint(adb, t["ip"])
    _run([adb, "connect", ep], 15)
    off = _sh(adb, ep, "pm list packages -d")
    pkgs = cfg.get("google_packages") or []
    google_off = bool(pkgs) and all(("package:" + p) in off for p in pkgs[:1])
    return adb, ep, cfg, ("ours" if google_off else "google")


async def state(tv_id):
    if not available(tv_id):
        return {"available": False}
    try:
        _adb_, _ep, _cfg, mode = await asyncio.get_running_loop().run_in_executor(None, _state_sync, tv_id)
        return {"available": True, "mode": mode}
    except Exception as e:  # noqa: BLE001
        return {"available": True, "mode": None, "error": str(e)[:160]}


def _switch_sync(tv_id, mode):
    adb, ep, cfg, _now = _state_sync(tv_id)
    ours, g_home, pkgs = cfg["ours"], cfg["google_home"], cfg.get("google_packages") or []
    log = []
    if mode == "ours":
        # first make this home the default, THEN switch Google's off, so the TV always has a home
        log.append(_sh(adb, ep, "cmd package set-home-activity %s" % ours))
        log.append(_sh(adb, ep, "cmd role add-role-holder --user 0 android.app.role.HOME %s 0" % ours.split("/")[0]))
        for p in pkgs:
            log.append(_sh(adb, ep, "pm disable-user --user 0 %s" % p))
        log.append(_sh(adb, ep, "am start -n %s" % ours))
    else:
        # first switch Google's back on, THEN make it the default and open it
        for p in pkgs:
            log.append(_sh(adb, ep, "pm enable %s" % p))
        log.append(_sh(adb, ep, "cmd package set-home-activity %s" % g_home))
        log.append(_sh(adb, ep, "cmd role add-role-holder --user 0 android.app.role.HOME %s 0" % g_home.split("/")[0]))
        log.append(_sh(adb, ep, "am start -n %s" % g_home))
    return _state_sync(tv_id)[3]


async def switch(tv_id, mode):
    if mode not in ("ours", "google") or not available(tv_id):
        raise ValueError("mode must be ours or google, and this TV needs a home_switch setting")
    return await asyncio.get_running_loop().run_in_executor(None, _switch_sync, tv_id, mode)
