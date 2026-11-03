# Design tokens — Asher’s tvOS

One look across every surface. Name is always **Asher’s tvOS** (curly apostrophe U+2019). GitHub-facing files (README, LICENSE) say "Waike".

## Surfaces
| Surface | Source | Notes |
|---|---|---|
| TV home (web) | `tv-home/web/app.css` | Source of truth; Inter + Antonio (clock). |
| TV native overlays (toolbar, keyboard, legend, Blocked page, fallback grid) | `…/launcher/Ui.kt` | Mirrors the web tokens; Inter variable font in `assets/fonts/inter.ttf`. |
| Injected focus ring | `assets/webnav.js` | White 4px ring, 16px radius, dark halo. |
| Phone remote | `remote/src/styles.css` | SF system stack; own spring curve (touch). |
| Bridge pages (`/diag`, `/install`, `/diag/latest`, placeholder) | `remote/public/*.html`, `bridge/diag.py`, `bridge/server.py` | Inline copy of the tokens below. |
| On-TV app (setup/home) | `on-tv/.../*.kt` | Same palette; system sans-serif-medium. |

## Colour
| Token | Value | Use |
|---|---|---|
| ground | `#120D13` | Boot/splash, blocked page, fallback, bridge pages |
| bg (web) | `#0B0B0E` | TV web page base |
| panel | `#221820` | Settings, toolbar, keyboard, cards (rim: inset 1px `rgba(255,255,255,.10)`) |
| tile | `#1C1C21` | App tiles, banners behind transparent art |
| text | `#F5F5F7` | Primary |
| text-2 / text-3 | `rgba(245,245,247,.62)` / `.42` | Secondary / tertiary |
| on-white | `#111` | Text on a focused (white) control |
| warn | `#FF9F8A` | Warnings on TV |
| ok / warn / bad (phone) | `#34C759` / `#FFB340` / `#FF6961` | Status |

## Type
Inter (variable, 400–700) for UI; Antonio only for the big clock. Headings weight 700, tracking −0.02em. Controls 600, body/notes 560.
Sizes at 1080p: h2 40–48px, row/pill 22–25px, note 22px, caption 20px.

## Shape
Panel radii 32–44px (toolbar 44, cards 40, notes 32), pills fully round (min height 56), tiles 20, focus ring 16 on web content.
Spacing: safe-x 80px, safe-y 60px, gap 40px (TV); 4/8/12/16/24 (phone).

## Focus language
Focused = solid white fill, `#111` text, spring scale (pills 1.06, tiles 1.08, rows 1.015). Over page content: 4px white ring + dark halo.

## Motion
- Spring: `cubic-bezier(0.3, 1.15, 0.4, 1)` (TV). Phone uses `(0.34, 1.4, 0.64, 1)` — intentionally livelier for touch.
- Ease-out: `cubic-bezier(0.22, 1, 0.36, 1)`.
- Durations: fast 180 / med 300 / slow 420 ms. Enter = fade + scale from origin; leave interruptible.
- Perf: transform/opacity only, no backdrop blur on the TV.

## Copy tone
Short, plain, sentence case, curly apostrophes, no exclamation marks. Errors say what happened and what to press.

## Known deviations
- Boot overlay uses system-ui, not Inter (loads before fonts).
- Phone uses the SF stack; TV uses Inter. Intentional (platform feel).
- On-TV app uses system sans-serif-medium (no bundled font).
