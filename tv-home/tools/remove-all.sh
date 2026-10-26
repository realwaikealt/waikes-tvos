#!/bin/sh
# Takes couch-tv completely off a TV and puts it back the way it came (see docs/UNINSTALL.md).
#   0. Checks the computer can still reach the TV over ADB. If not, says how to do it with the
#      TV remote instead and stops, so it never claims a success it did not have.
#   1. Switches the home screen and everything apply.sh switched off back on (undo.sh).
#   2. Removes the couch-tv apps from the TV.
#   3. Optional (DEV_OFF=1): switches off network debugging, USB debugging and Developer options.
#      This has to be last: the moment debugging is off, the computer can no longer reach the TV.
#
# Option B: stop the bridge before running this (docs/UNINSTALL.md), or its daily guard can
# switch the Google home off again.
#
# Usage, from the repo root:
#   TV_IP=<tv address> [TV_NAME=living-room] [DEV_OFF=1] [ADB_PORT=5555] sh tv-home/tools/remove-all.sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
PY="${PY:-$HERE/../../.venv/bin/python}"
T="$HERE/tvadb.py"
: "${TV_IP:?set TV_IP to the address of the TV}"
export TV_IP

if ! "$PY" "$T" ping > /dev/null; then
  echo
  echo "The computer cannot reach the TV, so nothing was changed. Do it with the TV remote instead"
  echo "(docs/UNINSTALL.md, \"With only the TV remote\"):"
  echo "  1. Settings tile on the couch-tv home (or the Settings button on the remote)."
  echo "  2. Apps, See all apps, Show system apps."
  echo "  3. Open Google TV Home and press Enable. Do the same for Setup."
  echo "  4. Back in Apps, open Home (the couch-tv one) and press Uninstall."
  echo "  5. Press Home. Google TV is back."
  echo "Do step 3 before step 4."
  exit 1
fi

echo "1/3  Putting the home screen back"
if ! sh "$HERE/undo.sh"; then
  echo "undo.sh failed part way. Nothing else was changed. See docs/UNINSTALL.md."
  exit 1
fi

echo "2/3  Removing the couch-tv apps"
for p in ${APPS:-app.couchtv.launcher dev.couchtv.ontv}; do
  if "$PY" "$T" shell "pm list packages $p" | grep -q "package:$p\$"; then
    "$PY" "$T" shell "pm uninstall $p"
  else
    echo "     $p is not on this TV"
  fi
done
"$PY" "$T" keys HOME

if [ "${DEV_OFF:-0}" = 1 ]; then
  echo "3/3  Switching off debugging and Developer options (the connection drops now, that is expected)"
  "$PY" "$T" shell "settings put global adb_wifi_enabled 0; settings put global development_settings_enabled 0; settings put global adb_enabled 0" || true
else
  echo "3/3  Developer options left on. Run again with DEV_OFF=1, or switch them off on the TV (docs/UNINSTALL.md)."
fi
echo "Done. Press Home on the TV: you should see the TV's own home screen."
