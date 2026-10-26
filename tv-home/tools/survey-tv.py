"""Read-only check of a TV before our home screen goes on it. Changes nothing on the TV or its screen.

Prints what the switch-over depends on: Android version, the home screen apps, which of the
packages we switch off exist on this TV, any ad trackers (ACR), and who owns the saved Wi-Fi
network (if the setup wizard owns it, switching the wizard off deletes the Wi-Fi: see docs/UNINSTALL.md).

Usage: TV_IP=<tv address> [ADB_PORT=5555] .venv/bin/python tv-home/tools/survey-tv.py
"""
import os
import re
import sys

from adb_shell.adb_device import AdbDeviceTcp
from adb_shell.auth.sign_pythonrsa import PythonRSASigner

KEY = os.path.expanduser(os.environ.get("ADB_KEY", "~/.android/adbkey"))
if not os.path.exists(KEY):
    from adb_shell.auth.keygen import keygen
    os.makedirs(os.path.dirname(KEY), exist_ok=True)
    keygen(KEY)
priv = open(KEY).read()
pub = open(KEY + ".pub").read()
ip = os.environ.get("TV_IP") or sys.exit("set TV_IP to the address of the TV")
port = int(os.environ.get("ADB_PORT") or 5555)
dev = AdbDeviceTcp(ip, port, default_transport_timeout_s=60)
try:
    dev.connect(rsa_keys=[PythonRSASigner(pub, priv)], auth_timeout_s=30)
except Exception as e:
    sys.exit(f"Cannot reach the TV at {ip}:{port} over ADB ({type(e).__name__}). Is Network debugging on, "
             "and was 'Allow USB debugging?' accepted on the TV? See README step 1.")
sh = lambda c: dev.shell(c, timeout_s=60, read_timeout_s=30).strip()

print("TV", ip)
print("model:", sh("getprop ro.product.manufacturer"), sh("getprop ro.product.model"))
print("android:", sh("getprop ro.build.version.release"), "sdk", sh("getprop ro.build.version.sdk"),
      "abi", sh("getprop ro.product.cpu.abi"))
print("screen:", sh("wm size").replace("\n", " / "), "|", sh("wm density").replace("\n", " / "))
print("webview:", (re.findall(r"versionName=(\S+)", sh("dumpsys package com.google.android.webview")) or ["?"])[0])
print("memory:", sh("grep -E 'MemTotal|MemAvailable' /proc/meminfo").replace("\n", " / "))

print("\nhome screen now:", sh("cmd package resolve-activity --brief -a android.intent.action.MAIN "
                                "-c android.intent.category.HOME").splitlines()[-1])
print(sh("pm query-activities --brief -a android.intent.action.MAIN -c android.intent.category.HOME"))

pkgs = set(l.replace("package:", "") for l in sh("pm list packages").splitlines())
disabled = set(l.replace("package:", "") for l in sh("pm list packages -d").splitlines())
WANT_OFF = {
    "com.google.android.apps.tv.launcherx": "Google TV home",
    "com.google.android.tvlauncher": "older Android TV home",
    "com.google.android.apps.tv.dreamx": "ambient mode (promos when idle)",
    "com.google.android.tungsten.setupwraith": "setup wizard (its recovery home outranks ours)",
}
print("\npackages we switch off:")
for p, what in WANT_OFF.items():
    state = "not on this TV" if p not in pkgs else ("already off" if p in disabled else "present")
    print(f"  {p:45} {state:15} {what}")

acr = sorted(p for p in pkgs if re.search(r"acr|samba|alphonso|inscape|anoki|tvision|admob|\.ads?\b", p))
print("\npossible ad trackers (check each before switching off):", ", ".join(acr) or "none found")

wifi = sh("dumpsys wifi | grep -E 'SSID|creatorName|creatorUid' | head -40")
creators = sorted(set(re.findall(r"creatorName[=:] ?(\S+)", wifi)))
print("\nsaved Wi-Fi networks were created by:", ", ".join(creators) or "unknown (read it at the TV)")
if any("setupwraith" in c for c in creators):
    print("  WARNING: the setup wizard owns a saved network. Switching the wizard off can delete that")
    print("  Wi-Fi, and then the computer can no longer reach the TV (so the computer undo cannot")
    print("  either: the fix is the TV-remote route in docs/UNINSTALL.md). Re-join the Wi-Fi in")
    print("  Settings first, or run apply.sh with KEEP_SETUP=1 to leave the wizard on.")

apps = sh("pm query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER")
print("\nTV apps:")
print("\n".join(sorted(l.strip() for l in apps.splitlines() if "/" in l)))
dev.close()
