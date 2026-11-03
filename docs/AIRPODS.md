# AirPods and Bluetooth audio on the TV

What it does, how it works, and what is and is not possible. Code: `AirPodsParser.kt`, `AirPodsWatcher.kt` (native),
`tv-home/web/airpods.js|css` (Settings screen), `MainActivity.kt` (hooks: key routing, lifecycle, `TVOS.bt*`).

## The honest limits
- Apple's pop-up ("AirPods Pro, Connect") is an iPhone/iPad/Mac feature. A TV cannot make an iPhone show it, and
  Android cannot show Apple's own sheet. What we can do: AirPods broadcast the same Bluetooth LE "proximity pairing"
  packet (company 0x004C, type 0x07) whenever the case lid is open, to anyone listening. The TV listens, and shows
  **our own** Apple-style sheet.
- The packet only says "AirPods of model X, battery N, case open" at some signal strength. It does not pair anything.
  Pairing is the normal Bluetooth classic pairing, which AirPods only accept while in pairing mode (lid open, button
  on the back held until the light flashes white), unless they are already paired with this TV.
- AirPods that are also paired with an iPhone connect to the iPhone first when the lid opens. To move them to the TV
  pair them again on the TV (or choose them in the TV's Bluetooth page).
- Android randomises the addresses it sees, so the TV cannot tell *which* AirPods it heard; it matches by model.
  Nothing identifying is stored (only counters and the last signal strength).

## TV facts (measured 2026-11-02)
Bluetooth + BLE present, MediaTek driver (`sys.tcl.bt.driver=mtk`), adapter on since boot, `MaxConnectedAudioDevices: 2`,
A2DP service present (A2DP source role available), no hardware scan filters (`mMaxScanFilters: 0`, so filtering is
done in software; the low-power scan mode keeps the load tiny). Only bonded device: the TCL remote (`BT_RC923_M1`, HID).
Bluetooth name of the TV: "FBI Surveillance TV" (visible to phones; change it in the TV's Bluetooth settings).

## How it behaves
- Scans only while Home is in front, the screen is on, and the feature is on (Settings > AirPods & Bluetooth audio).
  Stops on pause, screen off, when a web app/other app is in front, and while the sheet or pairing is active.
- Filter: Apple manufacturer data starting `07`; needs 2 packets above the signal threshold within 6 s.
  Sensitivity: Very close (> -45 dBm), Near the TV (> -55, default), Same room (> -65).
- Sheet: model name, battery for pods and case, **Connect** / **Not now** (D-pad left/right, OK, Back).
  Not now silences it for 3 minutes; a successful connection for 10 minutes; nothing shows if a Bluetooth headset is
  already playing sound.
- Connect: if an AirPods/Beats device is already paired, tries to connect it; else Bluetooth discovery for a device
  named AirPods/Beats, `createBond()`, then A2DP connect (hidden method via reflection, with Android's own auto
  connect after pairing as the main path). Clear failure help text. Timeouts: discovery 35 s, bonding 25 s, connect 15 s.
- Settings screen: pop-up On/Off, sensitivity, guided "Pair AirPods" (3 steps + live status), "Bluetooth audio" (opens
  the TV's Bluetooth page), an "Allow nearby-device access" row when the permission is missing, and a line showing where
  sound goes now (TV speakers / Bluetooth device).
- Phone remote: More/TV sheet > "Bluetooth audio (AirPods)" opens the TV's Bluetooth page through ADB
  (`POST /api/tvpage {"what":"bluetooth"}`).

## Permissions (granted with `pm grant`, kept across `pm install -r`)
`android.permission.ACCESS_FINE_LOCATION` (Android 11 requires it for any BLE scan; also Location must be switched on
in the TV's settings). On Android 12+ also `BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT`. `BLUETOOTH` and `BLUETOOTH_ADMIN`
are normal permissions on Android 11 (declared).

## Tests
- `AirPodsParserTest` (JUnit, `gradlew testReleaseUnitTest`): model names, battery/charging nibbles, flipped pods,
  Beats/Max, unknown models, other Apple messages and junk rejected.
- On the TV: the `TVOS.btDemo(model)` test hook shows the sheet as if AirPods had been heard.
- Needs real AirPods: the actual packet fields (battery nibble order, flipped bit) are community reverse engineering
  and untested against real hardware here; pairing and sound routing on this TCL firmware.

## Verified on the TV (2026-11-02/03)
- Scan runs (`dumpsys bluetooth_manager`: LOW_POWER, filter ManufacturerId=76 data=[7]) and already received Apple 0x07 packets nearby.
- Sheet (`am start ... --ei airpods_demo 3616`), Connect > "Looking for your AirPods…" (Bluetooth discovery running) > after 35 s "Couldn’t connect" with help and Try again / Close; Close returns to Home.
- Settings > AirPods & Bluetooth audio screen; "Bluetooth audio" opens the TV's pairing page `com.android.tv.settings/.accessories.AddAccessoryActivity`. The generic `android.settings.BLUETOOTH_SETTINGS` intent does NOT resolve on this TCL; the bridge now uses the component.
