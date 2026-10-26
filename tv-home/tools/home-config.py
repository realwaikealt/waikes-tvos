"""Print the TV home's settings from config.json (the same parts the bridge serves as /tv/config.js),
base64 encoded, for apply.sh to hand to the app on the TV. The app keeps them and uses them for the
copy of the home it carries inside it (option A, or when the computer is off).

Usage: .venv/bin/python tv-home/tools/home-config.py [--json]     (COUCH_CONFIG picks another file)
Never contains secrets: only people, weather, the home's look and each TV's quick buttons.
"""
import base64
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "bridge"))
import config  # noqa: E402

pub = config.public()
pub["ask"] = {"enabled": False}
text = json.dumps(pub, separators=(",", ":"))
print(text if "--json" in sys.argv else base64.b64encode(text.encode()).decode())
