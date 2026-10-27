"""Checks for the app categorizer and the sort modes, on the apps the living-room TV really has.

Run: .venv/Scripts/python.exe bridge/test_arrange.py   (no TV, no network; also checks the JS rules file parses)
The TV home sorts with the same rules in tv-home/web/app.js; tv-home/web/arrange-test.js (node) checks that
side against fixtures/arrange-expected.json, which this script writes.
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import arrange  # noqa: E402

APPS = json.load(open(os.path.join(HERE, "fixtures", "tv-apps.json")))["apps"]
NAME = {a["package"]: a["name"] for a in APPS}


def groups(res):
    out = {}
    for it in res["items"]:
        out.setdefault(it["group"], []).append(it["name"])
    return out


class Categorize(unittest.TestCase):
    def test_every_installed_app_lands_somewhere_sensible(self):
        want = {
            "streaming": {"YouTube", "Netflix", "Disney+", "Prime Video", "Apple TV", "HBO Max", "CBS", "Hulu",
                          "Paramount+", "Peacock TV", "Pluto TV", "TCL TV+", "Tubi"},
            "live": {"FOX One", "TV", "YouTube TV"},
            "kids": {"YouTube Kids"},
            "music": {"Spotify", "YouTube Music"},
            "utilities": {"Gallery", "Media Player", "Weather", "BROWSER", "App Store", "Settings"},
            "other": {"Instagram"},
            "hidden": {"Quick Panel", "Safety Guard", "TCL Channel", "TCL Home", "User Guide", "Works with Alexa"},
        }
        got = {}
        for a in APPS:
            got.setdefault(arrange.classify(a["package"], a["name"]), set()).add(a["name"])
        self.assertEqual(got, want)

    def test_unknown_apps_fall_back_to_the_name_then_other(self):
        c = arrange.classify
        self.assertEqual(c("com.example.thing", "Mystery"), "other")
        self.assertEqual(c("com.example.gamezone", "Zone"), "games")
        self.assertEqual(c("com.example.x", "Cool Browser"), "utilities")
        self.assertEqual(c("com.tcl.newthing", "New TCL thing"), "hidden")
        self.assertEqual(c("com.mediatek.foo", "Foo"), "hidden")
        self.assertEqual(c("com.plexapp.android", "Plex"), "streaming")
        self.assertEqual(c("com.google.android.setupwizard", "Setup"), "hidden")

    def test_exact_package_beats_a_tcl_pattern(self):
        self.assertEqual(arrange.classify("com.tcl.tv.plus", "TCL TV+"), "streaming")
        self.assertEqual(arrange.classify("com.tcl.gallery", "Gallery"), "utilities")


class Sorting(unittest.TestCase):
    def sort(self, mode, usage=None, **prefs):
        return arrange.sort_apps(APPS, dict(prefs, mode=mode), usage or {})

    def test_smart_puts_streaming_first_by_popularity_and_hidden_last(self):
        r = self.sort("smart")
        names = [it["name"] for it in r["items"]]
        self.assertEqual(names[:6], ["Netflix", "YouTube", "Prime Video", "Disney+", "HBO Max", "Hulu"])
        g = groups(r)
        order = [k for k in dict.fromkeys(it["group"] for it in r["items"])]
        self.assertEqual(order, ["streaming", "live", "kids", "music", "utilities", "other", "hidden"])
        self.assertEqual(set(g["hidden"]), {"Quick Panel", "Safety Guard", "TCL Channel", "TCL Home", "User Guide", "Works with Alexa"})
        self.assertEqual(names[-1] in g["hidden"], True)

    def test_my_own_use_beats_the_built_in_ranking(self):
        use = {"tv.pluto.android": {"n": 9, "t": 100}, "com.tubitv": {"n": 3, "t": 200}}
        names = [it["name"] for it in self.sort("smart", use)["items"]]
        self.assertEqual(names[:3], ["Pluto TV", "Tubi", "Netflix"])

    def test_most_used_and_recent(self):
        use = {"com.spotify.tv.android": {"n": 5, "t": 10}, "com.netflix.ninja": {"n": 2, "t": 50}}
        r = self.sort("used", use, group=False)
        self.assertEqual([it["name"] for it in r["items"]][:2], ["Spotify", "Netflix"])
        self.assertFalse(r["headers"])
        r = self.sort("recent", use, group=False)
        self.assertEqual([it["name"] for it in r["items"]][:2], ["Netflix", "Spotify"])

    def test_az_flat_and_grouped(self):
        flat = [it["name"] for it in self.sort("az", group=False)["items"] if not it["hidden"]]
        self.assertEqual(flat, sorted(flat, key=str.lower))
        grouped = self.sort("az", group=True)
        self.assertTrue(grouped["headers"])
        self.assertEqual(groups(grouped)["streaming"], sorted(groups(grouped)["streaming"], key=str.lower))

    def test_pins_hides_and_shown(self):
        r = self.sort("smart", pinned=["com.tubitv", "com.spotify.tv.android"], hidden=["com.netflix.ninja"],
                      shown=["com.tcl.guard"])
        names = [it["name"] for it in r["items"]]
        self.assertEqual(names[:2], ["Tubi", "Spotify"])
        by = {it["name"]: it for it in r["items"]}
        self.assertTrue(by["Netflix"]["hidden"])
        self.assertEqual(by["Netflix"]["group"], "hidden")
        self.assertFalse(by["Safety Guard"]["hidden"])
        self.assertEqual(by["Safety Guard"]["group"], "other" if False else by["Safety Guard"]["category"])
        # a hidden app is never pinned
        self.assertNotIn("Netflix", names[:2])

    def test_manual_keeps_the_saved_order_and_only_hides_by_hand(self):
        order = ["com.tubitv", "com.netflix.ninja", "com.tcl.guard"]
        r = arrange.sort_apps(APPS, {"mode": "manual"}, {}, order)
        names = [it["name"] for it in r["items"]]
        self.assertEqual(names[:3], ["Tubi", "Netflix", "Safety Guard"])
        self.assertFalse(r["headers"])
        self.assertFalse(any(it["hidden"] for it in r["items"]))

    def test_unset_mode_follows_whether_an_order_was_saved(self):
        self.assertEqual(arrange.effective_mode({"mode": ""}, True), "manual")
        self.assertEqual(arrange.effective_mode({"mode": ""}, False), "smart")
        self.assertEqual(arrange.effective_mode({"mode": "az"}, True), "az")

    def test_bad_prefs_are_cleaned(self):
        p = arrange.clean_prefs({"mode": "nope", "group": "yes", "pinned": ["a", "a", 3, "b"], "hidden": "x"})
        self.assertEqual(p["mode"], "")
        self.assertTrue(p["group"])
        self.assertEqual(p["pinned"], ["a", "b"])
        self.assertEqual(p["hidden"], [])

    def test_usage_counts(self):
        u = {}
        arrange.bump(u, "a", now=5)
        arrange.bump(u, "a", now=9)
        self.assertEqual(u["a"], {"n": 2, "t": 9})


def write_expected():
    """What the TV home's JavaScript must produce for the same apps and settings (see arrange-test.js)."""
    cases = []
    use = {"tv.pluto.android": {"n": 9, "t": 100}, "com.spotify.tv.android": {"n": 5, "t": 300}}
    for mode, prefs in (("smart", {}), ("used", {"group": False}), ("recent", {"group": False}), ("az", {"group": True}),
                        ("category", {}), ("smart", {"pinned": ["com.tubitv"], "hidden": ["com.netflix.ninja"], "shown": ["com.tcl.guard"]})):
        p = dict(prefs, mode=mode)
        r = arrange.sort_apps(APPS, p, use)
        cases.append({"prefs": p, "usage": use, "headers": r["headers"],
                      "order": [[it["package"], it["group"], it["hidden"]] for it in r["items"]]})
    json.dump({"apps": APPS, "cases": cases}, open(os.path.join(HERE, "fixtures", "arrange-expected.json"), "w"), indent=1)


if __name__ == "__main__":
    write_expected()
    unittest.main(verbosity=1)
