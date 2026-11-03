# PC as the brain: what the bridge now does for the TV

Measured on the TCL Q750G (mt5889, WebView 155), cold launch of the home (`force-stop`, then Home), 6-7 runs each, over Wi-Fi.
Marks come from `tv-home/web/perf.js` (ring buffer `window.__perf`, console `[perf]`, and a report POSTed to the bridge, read with `GET /api/perf`).

## Results (ms from navigationStart; medians of the warm runs)

| Mark | Before (raw files, ~9 calls) | After (minified+gzip+ETag, 1 call) |
|---|---|---|
| First script runs (`perf.js`) | 790-920 | ~600 |
| First paint | 1110-1290 | ~890 |
| `load` | 1250-1445 | ~1080-1130 |
| Boot screen removed | 2450-2590 | 2250-2290 |
| Bytes over Wi-Fi for the page | ~188 KB (index 6 + js 133 + css 45 + small) | ~40 KB (3 + 27.8 + 7.3 + small) |
| `/api/home` (all startup data, one call) | n/a (7-9 calls) | 125-168 ms |

Boot-screen removal is gated by the 900 ms minimum and the data; its gain (about 250 ms) is the earlier paint, the rest is the floor.
Cold-start noise is large (first runs after other TV activity are 30-60 % slower), so only the repeated warm runs are compared.

Frame timing / memory (12 focus moves): before p50 7 ms, p90 13 ms, PSS 111 MB, idle CPU 0 %. After p50 9 ms, p90 18 ms, PSS 247 MB, idle CPU 0 %.
This worse "after" is NOT from these changes (they touch only network and file size, no rendering); other agents installed a new APK and changed the UI at the same time. Not attributable, re-measure once all work is merged.

## What was built
- `bridge/tvassets.py`: `/tv/*` files minified on the PC (esbuild at `bridge/data/tools/esbuild.exe`, not committed; without it files are served as they are), gzip once and cached in memory, `ETag` + 304, fonts `immutable` for a year, pictures 1 h, html/js/css `no-cache` (a 304 costs nothing). `?dev` gives the plain files. The file `bridge/data/tvassets.off` switches it off (used for the A/B). Warmed at bridge start.
- `bridge/homeapi.py`: `GET /api/home` runs the existing handlers at the same time and returns people, shows, screens, webapps, who, apps, order, arrange, weather in one answer with an ETag. Also `POST/GET /api/perf`.
- `tv-home/web/home-prime.js` + a small wrapper in `app.js` `api()`: the startup burst of GETs is answered from one `/api/home`. Each part is used once, the snapshot dies after 4 s, any failure (older bridge, null part) falls back to the normal separate call, and a failed `/api/home` is not retried for 60 s. Offline/preview/mock modes are untouched.
- `bridge/imgproxy.py`: `GET /img?u=<https url>&w=<px>` shrinks poster art on the PC (Pillow, JPEG q80, disk cache in `bridge/data/imgcache`, refuses private/LAN addresses). Not yet used by the page (see below).

## Tried and found not worth it / not done
- Scene backgrounds: already 1920x1080 JPEG, 167-362 KB each; nothing to gain.
- Brotli: the `brotli` module is not installed; gzip gets 133 KB to 27.8 KB already.
- CSS (`content-visibility`, `will-change`): focus frames were already 7 ms median; no change made, no evidence it would win.
- WebView settings in `MainActivity.kt`: not changed (no APK rebuild by this task). `setWebContentsDebuggingEnabled(true)` stays on because the perf tools use it. Candidates for the next native build: nothing urgent.
- Event-loop blocking: no blocking `subprocess`/`sleep` in the async handlers (wallpapers.py uses executors).
- Image proxy is ready but not wired: the only remote art is the 3 lock-screen cards (`it.backdrop || it.poster` in `app.js`), to be switched to `/img?u=...&w=640` when online. Left out to avoid another edit in busy code.

## Not tested
`/api/home` equals the separate endpoints only by construction (same handlers); ETag 304 path of `/api/home` and `/img` not exercised from the TV. The TV's offline copy is now downloaded minified (gzip transparent), which was not verified by an offline launch.
