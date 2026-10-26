#!/usr/bin/env bash
# Test helper, EMULATOR ONLY: asks the TV app for a phone code, reads it off the emulator screen,
# pairs, and prints the token. Usage: scripts/pair-emulator.sh [serial] [base]
set -euo pipefail
serial="${1:-emulator-5554}"
base="${2:-http://localhost:15400}"
case "$serial" in emulator-*) ;; *) echo "emulator only" >&2; exit 2 ;; esac
adb="${ADB:-adb}"
"$adb" -s "$serial" shell am start -n dev.couchtv.ontv/.SetupActivity >/dev/null
sleep 1.5
curl -s -X POST "$base/api/pair/start" >/dev/null
sleep 1.5
pin=$("$adb" -s "$serial" exec-out uiautomator dump /dev/tty | grep -o 'Phone code  [0-9]* [0-9]*' | tr -dc '0-9')
curl -s -X POST -H 'content-type: application/json' -d "{\"pin\":\"$pin\",\"name\":\"test\"}" "$base/api/pair" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))'
