"""Taste profile per person (each person in config.json, and everyone) from all watch history: plays on our TVs
plus imported Netflix and YouTube history. Saved to data/taste.json; summary() gives Claude a
short plain-text version for recommendations.

What it works out, per person:
- shows: episodes seen, finished / dropped / watching now / partly (using JustWatch episode
  counts), rewatched episodes;
- films: finished / stopped early (when the Netflix full export says how long each sitting was);
- genres, weighted by how much was watched;
- YouTube channels and YouTube Music artists;
- recent (last 90 days) next to long term.
"""
import asyncio
import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

import config
import finder
import store

TASTE = os.path.join(store.DATA, "taste.json")
DETAILS_CACHE = os.path.join(store.DATA, "title-details.json")
RECENT_DAYS = 90
ENRICH_TOP = 40  # titles per person looked up on JustWatch (cached on disk)


def _when(text):
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _events():
    """Imported + bridge history as one list of plain events."""
    out = []
    for i in store.imported():
        kid = "kid" in (i.get("profile") or "").lower()
        out.append({"who": i.get("who"), "kids": kid, "source": i["source"], "title": i["title"],
                    "kind": i.get("kind"), "season": i.get("season"),
                    "episode": i.get("episode_title") or i.get("episode"),
                    "when": _when(i.get("when")), "duration_s": i.get("duration_s"),
                    "channel": i.get("channel")})
    for h in store.history():
        out.append({"who": h.get("who"), "kids": False, "source": h.get("service") or "tv",
                    "title": h["title"], "kind": "episode" if h.get("type") == "tv" else
                    ("film" if h.get("type") == "movie" else None),
                    "season": h.get("season"),
                    "episode": h.get("episode_title") or h.get("episode"),
                    "when": _when(h.get("when")), "duration_s": None, "channel": None})
    return [e for e in out if e["when"] and e["title"]]


def _belongs(e, person):
    if person == "everyone":
        # The household taste leaves out imported Kids profiles and anyone marked "kid" or
        # "guest" in config.json (they still get their own profile).
        return not e["kids"] and e["who"] not in config.left_out_of_taste()
    return e["who"] in (person, "both")


def _load_cache():
    try:
        with open(DETAILS_CACHE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


async def _details(cache, title, kind):
    key = f"{kind}|{title.lower()}"
    if key not in cache:
        try:
            cache[key] = await finder.details(title, "tv" if kind == "episode" else
                                              "movie" if kind == "film" else None)
        except Exception:
            return None  # not cached: try again next build
    return cache[key]


def _show_status(s, info, now):
    eps = len(s["eps"])
    recent = (now - s["last"]).days <= 30
    seasons = info.get("seasons") if info else None
    if seasons and s["seasons"]:
        total = sum(seasons.get(str(n)) or 0 for n in s["seasons"])
        if total and eps >= 0.8 * total and max(s["seasons"]) == max(int(k) for k in seasons):
            return "finished"
        if total and eps >= 0.8 * total:
            return f"finished season {max(s['seasons'])} of {len(seasons)}"
        if eps <= 2 and not recent:
            return f"dropped after {eps} episode{'s' if eps != 1 else ''}"
        if recent:
            return f"watching now ({eps} of {total} episodes in seasons seen)" if total else "watching now"
        return f"partly watched ({eps} of {total} episodes)" if total else f"{eps} episodes"
    if eps <= 2 and not recent and s["sittings"] <= 2:
        return f"dropped after {eps or 1} episode{'s' if eps > 1 else ''}"
    return "watching now" if recent else f"{eps or s['sittings']} episodes watched"


def _film_status(f, info):
    runtime = (info or {}).get("runtime_min")
    if f["longest_s"] and runtime:
        share = f["longest_s"] / (runtime * 60)
        if share >= 0.7:
            return "finished"
        if share <= 0.25:
            return "stopped early"
        return "partly watched"
    return "watched"


async def _profile(events, person, cache, now):
    mine = [e for e in events if _belongs(e, person)]
    recent_cut = now - timedelta(days=RECENT_DAYS)
    shows = defaultdict(lambda: {"sittings": 0, "eps": set(), "seasons": set(), "days": defaultdict(set),
                                 "first": None, "last": None, "recent": 0})
    films = defaultdict(lambda: {"sittings": 0, "longest_s": 0, "first": None, "last": None})
    channels, channels_recent, artists = Counter(), Counter(), Counter()
    for e in mine:
        if e["source"] == "youtube":
            if e["kind"] == "music":
                artists[(e["channel"] or "").replace(" - Topic", "") or "?"] += 1
            elif e["channel"]:
                channels[e["channel"]] += 1
                if e["when"] >= recent_cut:
                    channels_recent[e["channel"]] += 1
            continue
        if e["kind"] == "episode" or e["season"] or e["episode"]:
            s = shows[e["title"]]
            s["sittings"] += 1
            if e["episode"]:
                key = f"{e['season']}|{e['episode']}"
                s["eps"].add(key)
                s["days"][key].add(e["when"].date())
            if e["season"]:
                s["seasons"].add(int(e["season"]))
            s["recent"] += e["when"] >= recent_cut
        else:
            s = films[e["title"]]
            s["sittings"] += 1
            s["longest_s"] = max(s["longest_s"], e["duration_s"] or 0)
        s["first"] = min(filter(None, [s["first"], e["when"]]))
        s["last"] = max(filter(None, [s["last"], e["when"]]))

    top_shows = sorted(shows.items(), key=lambda kv: -kv[1]["sittings"])[:ENRICH_TOP]
    top_films = sorted(films.items(), key=lambda kv: -kv[1]["last"].timestamp())[:ENRICH_TOP // 2]
    infos = {}
    for title, _ in top_shows:
        infos[("episode", title)] = await _details(cache, title, "episode")
    for title, _ in top_films:
        infos[("film", title)] = await _details(cache, title, "film")

    genres = Counter()
    show_rows, film_rows = [], []
    for title, s in top_shows:
        info = infos.get(("episode", title))
        for g in (info or {}).get("genres") or []:
            genres[g] += s["sittings"]
        show_rows.append({
            "title": title, "status": _show_status(s, info, now), "sittings": s["sittings"],
            "episodes": len(s["eps"]), "seasons": sorted(s["seasons"]),
            "rewatched_episodes": sum(1 for d in s["days"].values() if len(d) > 1),
            "recent_sittings": s["recent"], "last": s["last"].date().isoformat(),
            "genres": (info or {}).get("genres")})
    for title, f in top_films:
        info = infos.get(("film", title))
        for g in (info or {}).get("genres") or []:
            genres[g] += 2
        film_rows.append({"title": title, "status": _film_status(f, info), "times": f["sittings"],
                          "last": f["last"].date().isoformat(), "genres": (info or {}).get("genres")})
    return {
        "events": len(mine),
        "shows": show_rows,
        "films": film_rows,
        "genres": [g for g, _ in genres.most_common(10)],
        "youtube_channels": [c for c, _ in channels.most_common(15)],
        "youtube_channels_recent": [c for c, _ in channels_recent.most_common(10)],
        "youtube_videos": sum(channels.values()),
        "music_artists": [a for a, _ in artists.most_common(10)],
        "recent_shows": [r["title"] for r in sorted(show_rows, key=lambda r: -r["recent_sittings"])
                         if r["recent_sittings"]][:10],
    }


_build_lock = asyncio.Lock()


async def build():
    async with _build_lock:
        events = _events()
        cache = _load_cache()
        now = datetime.now(timezone.utc)
        out = {"built": now.isoformat(timespec="seconds"),
               "sources": dict(Counter(e["source"] for e in events)),
               "people": {}}
        for p in (*config.PEOPLE_IDS, "everyone"):  # read now: people can change while the bridge runs
            out["people"][p] = await _profile(events, p, cache, now)
        os.makedirs(store.DATA, exist_ok=True)
        with open(DETAILS_CACHE, "w") as f:
            json.dump(cache, f)
        store._write(TASTE, out)
        return out


def load():
    return store._read(TASTE, {})


def summary(who=None, limit=1800):
    """Plain text for Claude. who: a person id / both or None (everyone)."""
    data = load()
    person = who if who in config.PEOPLE_IDS else "everyone"
    p = (data.get("people") or {}).get(person)
    if not p or not p.get("events"):
        return ""
    name = config.person_name(person) or "the household"
    lines = [f"Taste of {name} (from {p['events']} things watched):"]
    if p["genres"]:
        lines.append("Genres most watched: " + ", ".join(p["genres"][:8]) + ".")
    if p["recent_shows"]:
        lines.append("Watching lately: " + ", ".join(p["recent_shows"][:6]) + ".")
    fin = [s["title"] for s in p["shows"] if s["status"].startswith("finished")]
    drop = [s["title"] for s in p["shows"] if s["status"].startswith("dropped")]
    rew = [s["title"] for s in p["shows"] if s["rewatched_episodes"]]
    if fin:
        lines.append("Finished: " + ", ".join(fin[:12]) + ".")
    if drop:
        lines.append("Dropped early (avoid similar): " + ", ".join(drop[:10]) + ".")
    if rew:
        lines.append("Rewatched: " + ", ".join(rew[:6]) + ".")
    ff = [f["title"] for f in p["films"] if f["status"] == "finished"]
    fs = [f["title"] for f in p["films"] if f["status"] == "stopped early"]
    if ff:
        lines.append("Films finished: " + ", ".join(ff[:10]) + ".")
    if fs:
        lines.append("Films stopped early: " + ", ".join(fs[:6]) + ".")
    if p["youtube_channels"]:
        lines.append(f"YouTube ({p['youtube_videos']} videos), top channels: "
                     + ", ".join(p["youtube_channels"][:10]) + ".")
    if p["youtube_channels_recent"]:
        lines.append("YouTube lately: " + ", ".join(p["youtube_channels_recent"][:6]) + ".")
    if p["music_artists"]:
        lines.append("Music: " + ", ".join(p["music_artists"][:6]) + ".")
    text = "\n".join(lines)
    return text[:limit]
