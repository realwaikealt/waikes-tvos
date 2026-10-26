#!/usr/bin/env python3
"""Look for Google TV and Android TV devices on this Wi-Fi. Changes nothing.

    .venv/bin/python scripts/find-tvs.py [seconds]

Listens for the names TVs announce on the home network (mDNS) for a few seconds and prints one
line per device: its name, address, model (when it says), and what it offers:
  remote  = Android TV Remote protocol (the bridge uses this, option B)
  cast    = Google Cast (almost every Google TV, also many speakers and Chromecasts)
  adb     = Wireless debugging is switched on (Android 11 and newer, Developer options)
A TV that shows "remote" is a Google TV or Android TV. A "Cast device" only offers cast: it could
be a speaker, an older Chromecast or a Fire TV (check-tv.py tells them apart). Samsung, LG and
other TVs that do not run Android are not listed at all.
"""
import socket
import sys
import time

try:
    from zeroconf import ServiceBrowser, ServiceListener, Zeroconf
except ImportError:
    sys.exit("Needs zeroconf: .venv/bin/pip install -r bridge/requirements.txt")

SERVICES = {
    "_androidtvremote2._tcp.local.": "remote",
    "_googlecast._tcp.local.": "cast",
    "_adb-tls-connect._tcp.local.": "adb",
}


class Found(ServiceListener):
    def __init__(self):
        self.devices = {}

    def add_service(self, zc, type_, name):
        info = zc.get_service_info(type_, name, timeout=2000)
        if not info:
            return
        addrs = [socket.inet_ntoa(a) for a in info.addresses if len(a) == 4]
        if not addrs:
            return
        props = {k.decode(errors="ignore"): (v or b"").decode(errors="ignore") for k, v in info.properties.items()}
        ip = addrs[0]
        d = self.devices.setdefault(ip, {"names": set(), "models": set(), "offers": set()})
        friendly = props.get("fn") or name.split("._")[0]
        d["names"].add(friendly)
        if props.get("md"):
            d["models"].add(props["md"])
        d["offers"].add(SERVICES[type_])

    def update_service(self, zc, type_, name):
        self.add_service(zc, type_, name)

    def remove_service(self, zc, type_, name):
        pass


def main():
    wait = float(sys.argv[1]) if len(sys.argv) > 1 else 6
    zc = Zeroconf()
    found = Found()
    for t in SERVICES:
        ServiceBrowser(zc, t, found)
    time.sleep(wait)
    zc.close()
    tvs = {ip: d for ip, d in found.devices.items() if "remote" in d["offers"] or "adb" in d["offers"]}
    others = {ip: d for ip, d in found.devices.items() if ip not in tvs}
    if not tvs:
        print("No Android TV found. If your TV is Samsung, LG or another brand, that is expected: tell your")
        print("agent the brand and model.")
        print("If it is a Google TV or Android TV: check it is on, awake and on the same Wi-Fi (not a guest")
        print("network), then try again. On a Mac, the first run may ask to find devices on your local")
        print("network: say Allow (System Settings, Privacy and Security, Local Network), then run it again.")
    for ip, d in sorted(tvs.items()):
        model = ", ".join(sorted(d["models"])) or "model not given"
        print(f"TV       {ip:15}  {' / '.join(sorted(d['names']))}  ({model})  offers: {', '.join(sorted(d['offers']))}")
    for ip, d in sorted(others.items()):
        model = ", ".join(sorted(d["models"])) or "model not given"
        print(f"Cast device {ip:15}  {' / '.join(sorted(d['names']))}  ({model})  "
              "(could be a speaker, a Chromecast or a Fire TV)")


if __name__ == "__main__":
    main()
