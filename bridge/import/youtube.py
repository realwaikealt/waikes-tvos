"""YouTube watch history from Google Takeout: watch-history.json (or the .html
version if Takeout was left on HTML). Each entry: the video title ("Watched ..."), its link, the
channel, and the time. Ads ("From Google Ads") and removed videos are skipped. YouTube Music
plays are kept but marked as music.
"""
import hashlib
import html
import json
import re
from datetime import datetime


def _key(*parts):
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:16]


def _item(title, url, channel, channel_url, when, product, person):
    title = re.sub(r"^Watched\s+", "", title or "").strip()
    if not title or title.startswith("a video that has been removed") or title == url:
        return None
    vid = None
    if url:
        m = re.search(r"[?&]v=([\w-]{6,})", url)
        vid = m.group(1) if m else None
    return {"key": _key("youtube", person, vid or title, when), "source": "youtube",
            "who": person, "title": title, "video_id": vid, "url": url, "channel": channel,
            "channel_url": channel_url, "when": when,
            "kind": "music" if product == "YouTube Music" else "video"}


def parse_json(text, person):
    out = []
    for e in json.loads(text):
        if any("Google Ads" in (d.get("name") or "") for d in e.get("details") or []):
            continue
        sub = (e.get("subtitles") or [{}])[0]
        it = _item(e.get("title"), e.get("titleUrl"), sub.get("name"), sub.get("url"),
                   e.get("time"), e.get("header"), person)
        if it:
            out.append(it)
    return out


CELL = re.compile(
    r'<div class="header-cell[^>]*>\s*<p[^>]*>(?P<product>[^<]+)(?:<br\s*/?>)?</p>.*?'
    r'<div class="content-cell[^>]*>(?P<body>.*?)</div>', re.S)


def _html_time(text):
    text = re.sub(r"\s+", " ", html.unescape(text)).strip()
    text = re.sub(r"\s+[A-Z]{2,5}$", "", text)  # drop the time zone name (AEDT etc)
    for fmt in ("%d %b %Y, %H:%M:%S", "%b %d, %Y, %I:%M:%S %p", "%d %b %Y, %I:%M:%S %p"):
        try:
            return datetime.strptime(text.replace(" ", " "), fmt).isoformat()
        except ValueError:
            continue
    return None


def parse_html(text, person):
    out = []
    for m in CELL.finditer(text):
        body = m.group("body")
        if "From Google Ads" in body:
            continue
        links = re.findall(r'<a href="([^"]+)">([^<]*)</a>', body)
        parts = [p.strip() for p in re.split(r"<br\s*/?>", body) if p.strip()]
        when = _html_time(re.sub(r"<[^>]+>", "", parts[-1])) if parts else None
        if not links or not when:
            continue
        url, title = links[0]
        channel_url, channel = links[1] if len(links) > 1 else (None, None)
        it = _item("Watched " + html.unescape(title), html.unescape(url),
                   html.unescape(channel) if channel else None, channel_url, when,
                   m.group("product").strip(), person)
        if it:
            out.append(it)
    return out
