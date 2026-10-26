"""Claude for the TV: /api/ask and Claude's picks.

Always `claude -p` on your own Claude plan: ANTHROPIC_API_KEY is stripped from the child's
environment and nothing here calls api.anthropic.com. Model named explicitly (Sonnet).
Runs from a folder outside the workspace so the workspace CLAUDE.md, hooks and plugins never
load into a TV request (faster, and nothing of the agent system can surface on the TV).
"""
import asyncio
import json
import logging
import os
import re
import shutil
import sys
import time
import uuid

import apps
import config
import finder
import store
import taste

log = logging.getLogger("claude")

HERE = os.path.dirname(os.path.abspath(__file__))
CLAUDE = os.environ.get("CLAUDE_BIN") or shutil.which("claude") or "/opt/homebrew/bin/claude"
MODEL = "sonnet"
WORKDIR = os.path.join(config.DATA, "claude-workdir")
BRIDGE_URL = f"http://127.0.0.1:{os.environ.get('PORT', '5400')}"
ASK_TIMEOUT = 120
RECS_TIMEOUT = 180
RECS_MAX_AGE = 6 * 3600
RECS_MIN_GAP = 15 * 60  # after a play, refresh picks at most this often

_recs_lock = asyncio.Lock()

ASK_SYSTEM = """You run the living room TV in a home (a Google TV). You control it only with the tv tools. The people asking are on the couch
with a phone remote.

- To put something on, call play with the title. Pass season and episode only if they said
  them; leave them out otherwise, so the app carries on where they are up to. play finds where
  it streams in {country} and opens it in the right app. If they name an app, pass service.
- Only say a show is playing when play answers started true. If started is false, or missing,
  say the app is open and repeat play's note.
- For "what should we watch" questions, look at history and recs, then answer with two or three
  titles. Only play one if they asked you to put something on.
- For simple control (pause, louder, open Netflix, go home) use key, volume or launch.
- Never turn the TV off unless they clearly asked. Never sign in to anything.
- Do not ask questions back. Make a sensible choice and say what you chose.

Your final answer is shown on a phone. One or two short sentences, plain words, the
English spelling used in {country}, no dashes used as punctuation, no markdown. Say what you did, or why you could not."""

RECS_PROMPT = """{taste}

Played on our TVs lately, newest first (title, year, type, app):
{history}

Apps on the TV: {apps}.

Recommend 12 shows or films they have not watched that they are likely to enjoy, available to
stream in {country}, based on the taste above (weigh what they finished and rewatched, avoid
things like what they dropped early, and use their YouTube channels as a hint to interests).
Prefer things on the apps listed. Mix in a couple of recent releases.
Answer with ONLY a JSON array, no prose, each item:
{{"title": "...", "year": 2024, "type": "tv" or "movie", "reason": "Because you watched X"}}
The reason is at most eight words."""


def _env(extra=None):
    env = {k: v for k, v in os.environ.items()
           if k not in ("ANTHROPIC_API_KEY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")
           and not k.startswith("CLAUDE_CODE_SSE")}
    env.setdefault("HOME", os.path.expanduser("~"))
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + env.get("PATH", "")
    env.update(extra or {})
    return env


async def run_claude(prompt, system=None, mcp_config=None, timeout=ASK_TIMEOUT):
    os.makedirs(WORKDIR, exist_ok=True)
    args = [CLAUDE, "-p", prompt, "--model", MODEL, "--output-format", "json",
            "--no-session-persistence", "--setting-sources", "project", "--tools", ""]
    if system:
        args += ["--system-prompt", system]
    if mcp_config:
        args += ["--strict-mcp-config", "--mcp-config", mcp_config, "--allowedTools", "mcp__tv"]
    else:
        args += ["--strict-mcp-config"]
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=WORKDIR, env=_env(), stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError("Claude took too long")
    text = out.decode(errors="replace").strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        raise RuntimeError((err.decode(errors="replace").strip() or text)[:200] or "Claude failed")
    if data.get("is_error"):
        raise RuntimeError(str(data.get("result") or data.get("subtype") or "Claude error")[:200])
    return data.get("result") or ""


def _mcp_config(ask_id, tv_id=None):
    os.makedirs(WORKDIR, exist_ok=True)
    path = os.path.join(WORKDIR, f"mcp-{ask_id}.json")
    cfg = {"mcpServers": {"tv": {
        "type": "stdio",
        "command": sys.executable,
        "args": [os.path.join(HERE, "mcp_server.py")],
        "env": {"BRIDGE_URL": BRIDGE_URL, "ASK_ID": ask_id, **({"TV_ID": tv_id} if tv_id else {})},
    }}}
    with open(path, "w") as f:
        json.dump(cfg, f)
    return path


async def ask(text, who, asks, tv_id=None):
    ask_id = uuid.uuid4().hex[:12]
    asks[ask_id] = []
    cfg = _mcp_config(ask_id, tv_id)
    start = time.monotonic()
    names = [p["name"] for p in config.PEOPLE]
    asker = {p["id"]: p["name"] + " is asking" for p in config.PEOPLE}
    asker["both"] = " and ".join(names) + " are watching together"
    asker = asker.get(who)
    prompt = f"({asker}) {text}" if asker else text
    likes = taste.summary(who)
    if likes:
        # So "recommend something" and "put on something good" use the real taste.
        prompt = f"{prompt}\n\n[Background, use only if relevant]\n{likes}"
    try:
        reply = await run_claude(prompt, ASK_SYSTEM.format(country=config.COUNTRY_NAME), cfg)
    except RuntimeError as e:
        reply = f"Sorry, that did not work: {e}"
        log.warning("ask failed: %s", e)
    finally:
        actions = asks.pop(ask_id, [])
        try:
            os.remove(cfg)
        except OSError:
            pass
    return {"reply": reply.strip(), "actions": actions,
            "seconds": round(time.monotonic() - start, 1)}


# ---------- picks ----------
def _key(who):
    return "all" if who in (None, "both") else who


def _installed_app_names():
    return ", ".join(a["name"] for a in apps.APPS if a["jw"])


async def _enrich(item):
    try:
        best, _ = await finder.find(item["title"], item.get("type"))
    except Exception:
        best = None
    if not best:
        return None
    # Only keep it if the year roughly matches what Claude meant.
    if item.get("year") and best.get("year") and abs(int(item["year"]) - int(best["year"])) > 1:
        return None
    usable = [p for p in best["providers"] if p["playable"]]
    first = (usable or best["providers"] or [None])[0]
    return {"title": best["title"], "year": best["year"], "type": best["type"],
            "poster": best["poster"], "backdrop": best["backdrop"], "reason": item.get("reason"),
            "service": first["service"] if first else None, "playable": bool(usable)}


async def _popular_picks():
    items = await finder.popular(None, first=40)
    picks = []
    for b in items:
        usable = [p for p in b["providers"] if p["playable"]]
        if not usable:
            continue
        picks.append({"title": b["title"], "year": b["year"], "type": b["type"],
                      "poster": b["poster"], "backdrop": b["backdrop"],
                      "reason": f"Popular in {config.COUNTRY_NAME} this week",
                      "service": usable[0]["service"], "playable": True})
        if len(picks) >= 12:
            break
    return picks


def _parse_list(text):
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    m = re.search(r"\[.*\]", text, re.S)
    return json.loads(m.group(0) if m else text)


async def refresh_recs(who=None, force=False):
    async with _recs_lock:
        cache = store.recs()
        entry = cache.get(_key(who))
        age = time.time() - entry.get("ts", 0) if entry else None
        if entry and age < (RECS_MIN_GAP if force else RECS_MAX_AGE):
            return entry
        hist = [h for h in store.history() if store.matches(h, who)][:60]
        likes = taste.summary(who)
        picks = []
        if hist or likes:
            lines = "\n".join(f"- {h['title']} ({h.get('year')}, {h.get('type')}, {h.get('service')})"
                              for h in hist) or "(nothing yet)"
            try:
                raw = await run_claude(RECS_PROMPT.format(taste=likes or "(no taste profile yet)", country=config.COUNTRY_NAME,
                                                          history=lines, apps=_installed_app_names()),
                                       timeout=RECS_TIMEOUT)
                wanted = _parse_list(raw)[:14]
                watched = {h["title"].lower() for h in store.history()} | {
                    i["title"].lower() for i in store.imported() if i.get("source") != "youtube"}
                found = await asyncio.gather(*[_enrich(w) for w in wanted
                                               if isinstance(w, dict) and w.get("title")])
                picks = [p for p in found if p and p["title"].lower() not in watched][:12]
            except Exception as e:
                log.warning("Claude picks failed, using popular: %s", e)
        if not picks:
            try:
                picks = await _popular_picks()
            except Exception as e:
                log.warning("popular picks failed: %s", e)
                picks = entry["picks"] if entry else []
        from datetime import datetime
        from zoneinfo import ZoneInfo
        entry = {"ts": time.time(), "picks": picks,
                 "updated": datetime.now(ZoneInfo(config.TIMEZONE)).isoformat(timespec="seconds")}
        cache = store.recs()
        cache[_key(who)] = entry
        store.save_recs(cache)
        return entry


async def cached_recs(who=None):
    entry = store.recs().get(_key(who))
    stale = not entry or time.time() - entry.get("ts", 0) > RECS_MAX_AGE
    if stale and not _recs_lock.locked():
        asyncio.create_task(refresh_recs(who))
    if not entry:
        entry = store.recs().get("all")  # nothing for this person yet: show the shared picks
    if not entry:
        return [], None
    return entry["picks"], entry.get("updated")


async def background_loop():
    await asyncio.sleep(5)
    while True:
        try:
            for who in [None, *config.PEOPLE_IDS]:
                await refresh_recs(who)
        except Exception:
            log.exception("recs refresh failed")
        await asyncio.sleep(1800)
