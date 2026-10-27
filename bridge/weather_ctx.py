"""Weather and web search helpers for the Claude ask (stdlib only, so the MCP server can use them too).

Weather is Open-Meteo: free, no account, no key. (Apple WeatherKit needs a paid developer key, so it is
not used.) Brave Search is optional: set BRAVE_API_KEY (free tier at api.search.brave.com) to enable it.
"""
import json
import os
import time
import urllib.parse
import urllib.request

CODES = {0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
         51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
         61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
         71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light showers",
         81: "showers", 82: "heavy showers", 85: "snow showers", 86: "snow showers",
         95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with hail"}
_cache = {}
CACHE_FOR = 10 * 60


def _get(url, headers=None, timeout=12):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _hour12(iso):
    h = int(iso[11:13])
    return f"{(h % 12) or 12}{'am' if h < 12 else 'pm'}"


def _clock(iso):
    h, m = int(iso[11:13]), iso[14:16]
    return f"{(h % 12) or 12}:{m}{'am' if h < 12 else 'pm'}"


def summary(lat, lon, place, tz, fahrenheit=True):
    """A compact plain-text weather report: now, the next 12 hours, 7 days, sunrise and sunset."""
    key = (round(lat, 3), round(lon, 3), fahrenheit)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_FOR:
        return hit[1]
    unit = "fahrenheit" if fahrenheit else "celsius"
    deg = "F" if fahrenheit else "C"
    q = urllib.parse.urlencode({
        "latitude": lat, "longitude": lon, "timezone": tz or "auto", "forecast_days": 7,
        "temperature_unit": unit, "wind_speed_unit": "mph" if fahrenheit else "kmh",
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
        "hourly": "temperature_2m,precipitation_probability,weather_code",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset"})
    d = _get("https://api.open-meteo.com/v1/forecast?" + q)
    c, h, dy = d["current"], d["hourly"], d["daily"]
    lines = [f"Weather for {place} (Open-Meteo), {deg} and {'mph' if fahrenheit else 'km/h'}.",
             f"Now: {round(c['temperature_2m'])}°{deg} (feels {round(c['apparent_temperature'])}°), "
             f"{CODES.get(c['weather_code'], 'unknown')}, humidity {c['relative_humidity_2m']}%, wind {round(c['wind_speed_10m'])}."]
    now_iso = c["time"][:13]
    start = next((i for i, t in enumerate(h["time"]) if t[:13] >= now_iso), 0)
    nxt = [f"{_hour12(h['time'][i])} {round(h['temperature_2m'][i])}° {CODES.get(h['weather_code'][i], '')} "
           f"({h['precipitation_probability'][i] or 0}% rain)" for i in range(start, min(start + 12, len(h["time"])), 2)]
    lines.append("Next hours: " + "; ".join(nxt) + ".")
    days = []
    for i, t in enumerate(dy["time"]):
        import datetime
        name = "Today" if i == 0 else datetime.date.fromisoformat(t).strftime("%A")
        days.append(f"{name} {round(dy['temperature_2m_max'][i])}°/{round(dy['temperature_2m_min'][i])}° "
                    f"{CODES.get(dy['weather_code'][i], '')}, {dy['precipitation_probability_max'][i] or 0}% rain")
    lines.append("Week: " + "; ".join(days) + ".")
    lines.append(f"Sunrise {_clock(dy['sunrise'][0])}, sunset {_clock(dy['sunset'][0])} today.")
    text = "\n".join(lines)
    _cache[key] = (time.time(), text)
    return text


def brave_available():
    return bool(os.environ.get("BRAVE_API_KEY"))


def brave(query, count=5):
    """Brave web search results as short text, or an error string."""
    key = os.environ.get("BRAVE_API_KEY")
    if not key:
        return "Brave Search is not set up (BRAVE_API_KEY missing). Use WebSearch instead."
    q = urllib.parse.urlencode({"q": query, "count": max(1, min(int(count), 8))})
    d = _get("https://api.search.brave.com/res/v1/web/search?" + q,
             {"Accept": "application/json", "X-Subscription-Token": key})
    out = []
    for r in (d.get("web") or {}).get("results", [])[:count]:
        out.append(f"- {r.get('title')}: {r.get('description', '')[:300]} ({r.get('url')})")
    return "\n".join(out) or "No results."
