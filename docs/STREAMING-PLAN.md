# Streaming Vidbox (and the desktop) from the PC to the TV

Written 2026-11-02. Status: researched and downloads prepared. **Nothing is installed** on the PC or the TV.

## Problem
Vidbox is a heavy desktop site. The TCL TV's WebView is too weak for it, even after smooth mode. The PC (always on, running
the bridge) is far stronger, so let the PC run the browser and send the picture and sound to the TV.

## What this PC can do (checked)
| Item | Result |
|---|---|
| GPU | NVIDIA GeForce RTX 3080, driver 32.0.16.1062: has NVENC (H.264, HEVC, AV1 on 30-series decode only, so use H.264/HEVC) |
| CPU / RAM | Intel i7-12700 (12 cores), 31.7 GB |
| Network | Wired Ethernet (Killer E3100G 2.5 GbE, link 1 Gbps). TV is also on Ethernet, so the stream is wired end to end |
| Existing virtual display | "StarDesk Virtual Display Adapter" is already installed (from some remote-desktop tool). Not ours; ask the owner what it is before relying on it |

Verdict: ideal host. 1080p60 H.264 at 20 Mbps over wired LAN is easy; latency should be about 20-40 ms.

## Options compared
### A. Sunshine (PC) + Moonlight (TV), recommended
- Open-source (LizardByte Sunshine, Moonlight project). Hardware encodes on the RTX 3080, streams video + audio, accepts
  keyboard, mouse and gamepad input. The TV only decodes video (its decoder handles H.264 1080p60 easily).
- Sunshine "applications": each entry is a command the PC starts when a stream begins. We add **Vidbox** (Edge in kiosk mode
  at the Vidbox URL) and **Desktop** (plain desktop, no command).
- Real browser on the PC means real extensions (uBlock Origin) for ads, no WebView limits, full-speed video, DRM-free sites
  work as on a normal PC.
- Effort: install ~15 min (owner present for the first-run password and the pairing PIN), then ~1 day of integration for the
  launcher tile and remote controls.
- Cons: a driver or two get installed (audio sink), admin/UAC prompts, firewall rules, needs the PC logged in and awake,
  the stream takes over the PC display unless a virtual display is used.

### B. Home-made "browser in the PC" (headless Chromium via Playwright, frames to the TV)
- Bridge runs Chromium, sends CDP screencast JPEGs (or WebRTC) to a canvas in the TV WebView, forwards input.
- Cons: CDP screencast has no audio (WebRTC tab capture could carry audio but is fiddly), JPEG over WebSocket is 100-300 ms
  latency and ~15-25 fps at 1080p, the TV WebView must decode the images (the same weak CPU), video playback is choppy,
  a lot of custom code. Effort: about 3-5 days to reach "okay", and it would still be worse than A.
- Use only as a fallback if the owner refuses to install anything on the PC.

### C. Make the TV do less (already done / cheap)
- Smooth mode, ad and adult blocklist, popups blocked: done.
- A "Send to PC" button: the TV (or the phone remote) asks the bridge to open the URL in Edge on the PC monitor, so the
  owner can watch on the PC. Cheap (about 1 hour) but it does not show on the TV, so it is a stopgap.

### Recommendation
**A**, with C's "Send to PC" kept as a convenience. B is not worth building.

## Downloads (already in `C:\Users\abutl\couch-tv-testing\tmp\stream\`, not installed)
| File | Source | SHA256 (verified against the GitHub release digest) |
|---|---|---|
| `Sunshine-Windows-AMD64-installer.msi` (33,710,080 B) | https://github.com/LizardByte/Sunshine/releases/tag/v2026.914.233613 (published 2026-09-15) | `1d7fed8beecd5889dc7ff14cf9f42d6d38f37c3066c13c6c2a5f4e91847e0ccf` |
| `moonlight-v12.2-nonRoot.apk` (11,137,885 B) | https://github.com/moonlight-stream/moonlight-android/releases/tag/v12.2 (published 2026-09-12) | `a871f6190365386ee3ac5722a016d4da015ee1555631ec257f6e5dc3f4a45fe0` (case-normalised: `A871F619...45FE0`) |

- Sunshine MSI Authenticode signature: **Valid**, signer `CN=David Lane, O=David Lane, Kissimmee, Florida, US` (LizardByte's maintainer).
- Moonlight APK signature (apksigner): signer `O=Limelight Team`, cert SHA-256 `d6ce3a4df15060fe488fe52441a549dee4ba199b36e2cb1ed9085cca8bfa1aca`. The APK is universal (contains arm64-v8a, armeabi-v7a, x86, x86_64) so one file fits the TV's ARM CPU; minSdk 21; it declares the leanback launcher, so it shows up on Android TV. Use the **nonRoot** build (the root build only adds a root-only input path).
- Ask for the owner's go-ahead before installing either. Moonlight is not on the TV yet.

## Install and configure (steps for the lead, after approval)
### 1. Sunshine on the PC (needs owner at the PC for UAC + password)
1. Run the MSI (`msiexec /i Sunshine-Windows-AMD64-installer.msi`). UAC prompt: owner clicks Yes. Keep defaults: service on,
   firewall rules on. It installs a Windows service, a firewall rule set, and the "Steam Streaming Speakers" virtual audio
   device (lets the PC mute its own speakers while streaming).
2. Do **not** install the paid "Virtual HID Driver" add-on. Without it Sunshine uses ViGEmBus (gamepad) and SendInput
   (keyboard/mouse), which is fine here.
3. Open `https://localhost:47990`, accept the self-signed certificate warning, **owner creates the username and a long
   password** (this step cannot be automated or done by Claude on the owner's behalf).
4. Settings that matter (Configuration tab, or `sunshine.conf`):
   - `origin_web_ui_allowed = pc` (web UI only from the PC itself, the default is `lan`).
   - `encoder = nvenc`, `hevc_mode = 0`.
   - `upnp = disabled` (default; never port-forward on the Cox router).
   - Display: either keep the real monitor and set `dd_resolution_option = auto` (monitor switches to the TV's 1080p during
     the stream and reverts after), or use a virtual display (below).
   - Audio: leave the default sink; tick "Mute on host" via Steam Streaming Speakers if the owner wants the PC quiet.
5. Applications (`C:\Program Files\Sunshine\config\apps.json`, or the web UI Applications tab):
```json
{
  "env": {},
  "apps": [
    { "name": "Desktop", "image-path": "desktop.png" },
    {
      "name": "Vidbox",
      "cmd": "\"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe\" --kiosk https://vidbox.wtf/home --edge-kiosk-type=fullscreen --no-first-run --user-data-dir=C:\\Users\\abutl\\couch-tv-testing\\kiosk-profile",
      "auto-detach": "true",
      "wait-all": "true",
      "exit-timeout": "5",
      "image-path": ""
    }
  ]
}
```
   - A separate `--user-data-dir` keeps the owner's normal Edge untouched. In that profile install uBlock Origin once
     (owner/Claude through the desktop stream, or load unpacked) so ads and popups are blocked on the PC.
   - The stream ends when Edge closes (`wait-all`/`exit-timeout`). A "Quit" in Moonlight closes it.
   - Verify the Edge path on this PC before writing the file.
6. Windows firewall ports used on the LAN (the installer adds these; list kept for checking): TCP 47984 (HTTPS), 47989
   (HTTP), 47990 (web UI, restrict with `origin_web_ui_allowed = pc`), 48010 (RTSP); UDP 47998 (video), 47999 (control), 48000
   (audio), 48002 (mic, optional). Scope the rules to "Private" network and to the TV's IP if possible.
7. The PC must be logged in and unlocked (a locked Windows session blocks screen capture). Disable lock-on-idle or use a
   long timeout while streaming.

### 2. Moonlight on the TV (TV lock, then `adb install`)
```
tools/tv.py install ... moonlight-v12.2-nonRoot.apk     # or b64push.py + pm install -r
```
Then open Moonlight once: Add PC manually `192.168.0.61` (the TV is not on mDNS reliably). Moonlight shows a 4-digit PIN; the
owner enters it at `https://localhost:47990` > PIN (device name "TCL TV"). After pairing, the apps Desktop and Vidbox appear.

Moonlight settings to set on the TV: 1080p, 60 fps, bitrate 20-30 Mbps, codec H.264 (switch to HEVC if the picture is soft),
"Show on-screen controls" off, "Mouse emulation via gamepad" on (see Input).

### 3. Launching from our launcher (what the lead will automate)
Moonlight ships an exported trampoline built for shortcuts: `com.limelight/.ShortcutTrampoline`. Extras read from its source:
`UUID` (the PC's id, string), `Name` (PC name fallback), `AppName` (e.g. `Vidbox`), `AppId` (optional int), `HDR` (bool).
It wakes the PC (Wake-on-LAN) and starts the stream directly, skipping the Moonlight menus:
```
am start -n com.limelight/.ShortcutTrampoline --es UUID <pc-uuid> --es Name <pc-name> --es AppName Vidbox
```
How to get `<pc-uuid>`: after pairing, `http://192.168.0.61:47989/serverinfo` returns `<uniqueid>`; or read it from
Moonlight's PC list (long-press > "View details"). `com.limelight.Game` itself is not exported, so use the trampoline.
Tile: the Vidbox tile (More apps) gets a "Stream from PC" action that runs this `am start` through the existing app-launch
path in MainActivity (needs `queries` for `com.limelight` if we launch by package intent; the explicit component works from the
bridge via adb too). Fall back to the current WebView Vidbox if Moonlight is not installed or the PC is unreachable.
Also a "Desktop" tile with `AppName Desktop`.

### 4. Input (how the owner controls it from the couch)
- TV remote in Moonlight: the D-pad and OK arrive as Android key events, which Moonlight forwards as keyboard arrows/Enter,
  so Tab/arrow/Enter work on a page but pointing at small buttons is clumsy. Moonlight's "mouse emulation via gamepad" turns
  the D-pad into a cursor (hold Start to toggle) as a gamepad-based pointer; this is how most people use Moonlight on TV boxes.
  Not yet tested here, test first.
- **Best fix, uses the PC being the host:** the bridge runs on the same PC, so the phone remote can send mouse movement,
  clicks, scroll and typed text straight to Windows (`SendInput` via `ctypes` or `pyautogui`) with no dependence on TV keys.
  Add `POST /api/pc/input` (move, click, scroll, key, text) and a touchpad + keyboard sheet on the phone remote ("PC mode"),
  active when a Sunshine stream is running. This also solves "typing from the phone into the page", which the WebView
  approach struggled with. Effort about 1 day. Guard it: only accept from LAN and only while a stream is active.
- Optional hardware: a small Bluetooth air-mouse/keyboard remote (about $15-25) paired to the TV also works in Moonlight
  (mouse and keys are forwarded as-is). Mention to the owner as an add-on, not required.
- Gamepads work natively.

### 5. Virtual display (optional, do later)
By default Sunshine streams the real monitor, and `dd_resolution_option=auto` temporarily changes its resolution to 1080p and
back. If the owner wants the monitor untouched while the TV streams, use a virtual display so the TV gets its own 1920x1080
screen: either "Virtual Display Driver" by itself (open-source, MikeTheTech; installs an unsigned/test-signed or
signed IDD driver, needs admin and may need a reboot) or the existing StarDesk adapter if the owner confirms what it is.
Then set `dd_configuration_option = ensure_only_display` or select that output in Sunshine `output_name`. Not recommended for
phase 1; try the plain setup first. **Do not install without asking.**

## Risk list
| Risk | Mitigation |
|---|---|
| Admin rights / UAC prompts | Owner is at the PC for the installs; nothing is silent. |
| Driver installs (audio sink, ViGEmBus gamepad driver) | Only Sunshine's signed drivers; skip Virtual HID add-on and any virtual-display driver in phase 1. |
| Firewall rules opening ports | Rules scoped to Private network; LAN only; never port-forward; `upnp=disabled`. |
| Anyone on the Wi-Fi could use the stream | Pairing needs a PIN the owner types on the PC; unpaired clients cannot connect. Strong web UI password; `origin_web_ui_allowed = pc`. Pairing is per device, revokable under Sunshine > Troubleshooting/Clients. |
| Stream shows the PC desktop/private windows | Use the Vidbox kiosk app (not Desktop) as the default tile; Desktop tile behind the Settings PIN. |
| PC asleep/locked/off | Bridge host is on anyway; set no-sleep while plugged in; Moonlight wakes via WoL. A locked session cannot be captured. |
| Router DHCP changes the PC address | Same issue as the TV; needs the Cox reservation (open item). |
| Latency / quality surprises | Measure: Moonlight stats overlay; fall back to the WebView. |
| Sunshine/Moonlight updates | Pin the verified versions; update by hand after checking release notes. |
| Windows Defender SmartScreen | The MSI is signed; if blocked, owner chooses "Run anyway". |

## Rollback / uninstall
- PC: Settings > Apps > Sunshine > Uninstall (removes service, firewall rules, config; the audio sink and ViGEmBus are listed
  separately, remove them there). Delete `C:\Users\abutl\couch-tv-testing\kiosk-profile`.
- TV: `pm uninstall com.limelight` is allowed for a sideloaded user app (rule is "never uninstall" for system packages; this is
  our own addition, so it is fine) or just `pm disable-user com.limelight`.
- Launcher: the Vidbox tile keeps the existing WebView path, so removing Moonlight changes nothing else.
- Router: nothing changes there.

## Confirmation to ask the owner (exact wording)
> **OK to install the PC-streaming helper?**
> I'd install **Sunshine** on your PC (a signed, open-source program that sends your PC screen and sound to the TV) and
> **Moonlight** on the TV (the matching viewer). This makes Vidbox run on your PC, which is much smoother than on the TV.
> You'll see a Windows "allow changes" prompt, and I'll need you at the PC for about five minutes to choose a password and type
> a four-digit pairing code. It adds a Windows service, a few private-network firewall rules and a virtual audio device; nothing
> is opened to the internet. To remove it later: Windows Settings > Apps > Sunshine > Uninstall, and uninstall Moonlight on the
> TV. Say "yes, install" and I'll do it; or "not yet".

## Task list once approved
1. Owner OKs; verify Edge path; install Sunshine (owner does UAC + password); apply config + apps.json (the lead can edit
   `apps.json`/`sunshine.conf` files directly; admin may be needed to write into Program Files).
2. Install Moonlight APK on the TV (TV lock); pair (owner types PIN); read `uniqueid`.
3. Add "Stream from PC" to the Vidbox tile + Desktop tile in tv-home; fallback logic; Settings toggle.
4. Bridge `POST /api/pc/input` + phone "PC mode" touchpad/keyboard; limited to active streams.
5. Measure latency and frame rate (Moonlight overlay), tune bitrate/codec; note results in PROJECT.md.
6. Optional: virtual display; uBlock Origin in the kiosk profile.
