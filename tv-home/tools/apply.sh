#!/bin/sh
# Installs our Home app on a TV and makes it the home screen. Switches off the Google TV home,
# ambient mode, the setup wizard (its "recovery home" outranks any home app we can install) and
# any extra packages named in EXTRA_OFF (e.g. an ACR ad tracker the survey found). Only packages
# that exist on that TV are touched, and the list of what was switched off is written to
# tv-home/tvs/<TV_NAME>.disabled, which undo.sh reads. Run survey-tv.py first.
#
# Other makers' own home screens (survey-tv.py lists them) are left alone: the TV's default home
# is set to couch-tv instead, with `cmd package set-home-activity`.
#
# Option A (TV home only, no computer left on): leave BRIDGE_URL out. The app then shows the copy
#   of the home it carries inside it, with the people, weather, clock, look and quick buttons from
#   your config.json (passed to the TV now). Run this again after a Google TV update brings the
#   Google home back, or after you change config.json.
# Option B (computer bridge): set BRIDGE_URL so the home loads from the bridge.
#
# Usage, from the repo root:
#   TV_IP=<tv address> [BRIDGE_URL=http://<your-computer>:5400] [APK=couch-tv-home.apk]
#     [TV_NAME=living-room] [TV_ID=<id>] [EXTRA_OFF="pkg pkg"] [KEEP_SETUP=1] [ADB_PORT=5555]
#     sh tv-home/tools/apply.sh
# APK defaults to the one scripts/build-apk.sh builds. KEEP_SETUP=1 leaves the setup wizard on
# (use it when survey-tv.py warned that the wizard owns the Wi-Fi). On some TVs the wizard then
# keeps winning Home; if Home still shows Google TV afterwards, the wizard has to go off.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
PY="${PY:-$ROOT/.venv/bin/python}"
T="$HERE/tvadb.py"
TV_NAME=${TV_NAME:-living-room}
: "${TV_IP:?set TV_IP to the address of the TV}"
export TV_IP
APK=${APK:-$HERE/../android/app/build/outputs/apk/release/app-release.apk}
if [ ! -f "$APK" ]; then
  echo "No app at $APK."
  echo "Download couch-tv-home.apk from the GitHub Releases page and run again with APK=<that file>,"
  echo "or build it with: sh scripts/build-apk.sh"
  exit 1
fi
"$PY" "$T" ping > /dev/null
mkdir -p "$HERE/../tvs"
LIST="$HERE/../tvs/$TV_NAME.disabled"
WANT="com.google.android.apps.tv.launcherx com.google.android.tvlauncher com.google.android.apps.tv.dreamx"
[ "${KEEP_SETUP:-0}" = 1 ] || WANT="$WANT com.google.android.tungsten.setupwraith"
WANT="$WANT ${EXTRA_OFF:-}"
RESOLVE="cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME"

# Remember the home the TV had, so undo.sh puts that one back (it may be the maker's own).
PREV=$("$PY" "$T" shell "$RESOLVE" | tail -1)
case "$PREV" in
  */*) case "$PREV" in app.couchtv.launcher/*) ;; *) echo "$PREV" > "$HERE/../tvs/$TV_NAME.home" ;; esac ;;
esac

"$PY" "$T" install "$APK"
present=$("$PY" "$T" shell "pm list packages" | sed 's/package://')
: > "$LIST"
for p in $WANT; do
  if echo "$present" | grep -qx "$p"; then
    "$PY" "$T" shell "pm disable-user --user 0 $p"
    echo "$p" >> "$LIST"
  fi
done
# Only after the switch-offs, or the setup wizard's recovery home wins.
"$PY" "$T" shell "cmd package set-home-activity app.couchtv.launcher/.MainActivity"

# Tell our home where the bridge is ("none" for option A) and hand it the settings from
# config.json for its built-in copy. Force-stop first: a running home only reads "bridge".
CFG64=$("$PY" "$HERE/home-config.py")
"$PY" "$T" shell "am force-stop app.couchtv.launcher; am start -n app.couchtv.launcher/.MainActivity --es bridge ${BRIDGE_URL:-none} --es config_b64 $CFG64 ${TV_ID:+--es tv $TV_ID}"

# Tell the bridge's daily guard what to keep switched off (a Google TV update can switch it back
# on). Option A has no bridge, so no guard: run this script again after an update.
KEEP="$ROOT/bridge/data/keep-disabled.json"
[ "$TV_NAME" = living-room ] || KEEP="$ROOT/bridge/data/keep-disabled.$TV_NAME.json"
if [ -n "${BRIDGE_URL:-}" ]; then
  mkdir -p "$(dirname "$KEEP")"
  "$PY" -c 'import json,sys; print(json.dumps(sys.stdin.read().split()))' < "$LIST" > "$KEEP"
fi
"$PY" "$T" keys HOME
NOW=$("$PY" "$T" shell "$RESOLVE")
echo "home screen now: $(echo "$NOW" | tail -1)"
echo "switched off (undo list): $LIST"
cat "$LIST"
