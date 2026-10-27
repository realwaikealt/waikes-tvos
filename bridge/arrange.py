"""Auto arrange for the TV's apps: which group an app is in and what order they go in.

Only changes what the TV home and the phone show. Nothing is ever disabled or removed from the TV;
"Hidden" is a tab in the launcher, and every app in it can be brought back with one tap.

The rules (packages, name patterns, popularity) are shared with the TV home: they live in
tv-home/web/arrange-rules.js, between the "/*json*/" and "/*endjson*/" markers, and the TV's own
sorting in tv-home/web/app.js follows the same steps as sort_apps() here.

Saved per TV in app-arrange.<tv>.json:
  prefs  mode (smart, used, recent, az, category, manual; "" = manual if an order was saved, else smart),
         group (headers between groups), show_hidden (the Hidden tab at the end),
         pinned (always first, in this order), hidden (hidden by hand), shown (kept out of Hidden by hand)
  usage  {package: {"n": opens, "t": last opened, unix seconds}}
"""
import json
import os
import re
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RULES_FILE = os.path.join(os.path.dirname(HERE), "tv-home", "web", "arrange-rules.js")

MODES = ("smart", "used", "recent", "az", "category", "manual")
MODE_LABELS = {"smart": "Smart", "used": "Most used", "recent": "Recently used", "az": "A to Z",
               "category": "By group", "manual": "My order"}
DEFAULT_PREFS = {"mode": "", "group": True, "show_hidden": True, "pinned": [], "hidden": [], "shown": []}
_rules = None


def rules():
    """The shared rules, read once from the TV home's own file."""
    global _rules
    if _rules is None:
        with open(RULES_FILE, encoding="utf-8") as f:
            text = f.read()
        a, b = text.index("/*json*/") + len("/*json*/"), text.rindex("/*endjson*/")
        r = json.loads(text[a:b].strip().rstrip(";").strip())
        r["_patterns"] = [(re.compile(p, re.I), c) for p, c in r["patterns"]]
        r["_names"] = [(re.compile(p, re.I), c) for p, c in r["names"]]
        r["_cats"] = [c["id"] for c in r["categories"]]
        r["_rank"] = {p: i for i, p in enumerate(r["rank"])}
        _rules = r
    return _rules


def categories():
    return rules()["categories"]


def classify(package, name=""):
    """The group id for an app: its exact package first, then package patterns, then its name."""
    r = rules()
    if package in r["packages"]:
        return r["packages"][package]
    for rx, cat in r["_patterns"]:
        if rx.search(package or ""):
            return cat
    for rx, cat in r["_names"]:
        if rx.search((name or "").strip()):
            return cat
    return "other"


def rank_of(package):
    return rules()["_rank"].get(package, 999)


def clean_prefs(p):
    """Anything the phone or TV sends, cut down to what is allowed."""
    p = p if isinstance(p, dict) else {}
    out = dict(DEFAULT_PREFS)
    mode = p.get("mode", out["mode"])
    out["mode"] = mode if mode in MODES or mode == "" else ""
    for k in ("group", "show_hidden"):
        if isinstance(p.get(k), bool):
            out[k] = p[k]
    for k in ("pinned", "hidden", "shown"):
        v = p.get(k)
        out[k] = [x for x in dict.fromkeys(v) if isinstance(x, str) and len(x) < 200][:200] if isinstance(v, list) else []
    return out


def effective_mode(prefs, has_saved_order):
    m = prefs.get("mode") or ""
    return m if m in MODES else ("manual" if has_saved_order else "smart")


def is_hidden(package, category, prefs, mode):
    """My order shows everything where the owner put it: pins and hides apply to the automatic modes."""
    if mode == "manual":
        return False
    if package in prefs.get("hidden", ()):
        return True
    return category == "hidden" and package not in prefs.get("shown", ())


def _use(usage, package):
    u = usage.get(package) or {}
    return int(u.get("n") or 0), float(u.get("t") or 0)


def sort_apps(apps, prefs, usage, manual_order=None):
    """apps: [{package, name}]. Returns [{package, name, category, hidden, pinned, group}] in the order
    the dock and All apps use. Hidden apps come last. Same steps as arrangeApps() in the TV's app.js."""
    prefs = clean_prefs(prefs)
    mode = effective_mode(prefs, bool(manual_order))
    cats = rules()["_cats"]
    items = []
    for a in apps:
        pkg = a["package"]
        cat = classify(pkg, a.get("name", ""))
        items.append({"package": pkg, "name": a.get("name") or pkg, "category": cat,
                      "hidden": is_hidden(pkg, cat, prefs, mode),
                      "pinned": mode != "manual" and pkg in prefs["pinned"]})

    def cat_i(it):
        return cats.index(it["category"]) if it["category"] in cats else len(cats)

    def name_k(it):
        return it["name"].lower()

    def used_k(it):
        n, t = _use(usage, it["package"])
        return (-n, -t, rank_of(it["package"]), name_k(it))

    def recent_k(it):
        n, t = _use(usage, it["package"])
        return (-t, -n, rank_of(it["package"]), name_k(it))

    def smart_k(it):
        n, t = _use(usage, it["package"])
        return (-n, rank_of(it["package"]), name_k(it))

    if mode == "manual":
        at = {p: i for i, p in enumerate(manual_order or [])}
        items.sort(key=lambda it: (at.get(it["package"], len(at)), name_k(it)))
    else:
        key = {"smart": smart_k, "used": used_k, "recent": recent_k, "az": lambda it: (name_k(it),),
               "category": lambda it: (name_k(it),)}[mode]
        by_group = mode in ("smart", "category") or prefs["group"]
        items.sort(key=(lambda it: (cat_i(it),) + key(it)) if by_group else key)
    pin_at = {p: i for i, p in enumerate(prefs["pinned"])}
    # hidden last, pinned first among what is shown; the rest keep the order above
    items.sort(key=lambda it: (1 if it["hidden"] else 0, 0 if it["pinned"] and not it["hidden"] else 1,
                               pin_at.get(it["package"], 0) if it["pinned"] else 0))
    for it in items:
        it["group"] = "hidden" if it["hidden"] else it["category"]
    return {"mode": mode, "headers": prefs["group"] and mode != "manual", "items": items}


def bump(usage, package, now=None):
    """Count one opening of an app."""
    u = usage.setdefault(package, {"n": 0, "t": 0})
    u["n"] = int(u.get("n") or 0) + 1
    u["t"] = int(now if now is not None else time.time())
    return usage


def clean_usage(u):
    out = {}
    for k, v in (u.items() if isinstance(u, dict) else []):
        if isinstance(k, str) and isinstance(v, dict) and len(out) < 500:
            out[k] = {"n": max(0, int(v.get("n") or 0)), "t": max(0, int(v.get("t") or 0))}
    return out
