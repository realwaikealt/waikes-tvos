# TV UI audit (tv-home/web), 2026-11-02

Method: headless Edge screenshots at 1920x1080 and 1280x720 (mock mode) of Home, dock focus, people, Ask, Settings (top/mid/bottom),
PIN, About, licences, Debug panes, All apps; measured boxes; read app.css/index.html. Shots: `tmp/y1shots/` (B_* before, A_* after at
1080p, C_* at 720p). No JS errors in any run.

| Area | Before | After |
|---|---|---|
| Document language | `en-AU` (US config) | `en-US` |
| Help text (Settings/Debug/Ask/About, PIN) | 19 px, 55% white | 20 px, 62% white |
| About "Open-source licences" line | 15 px, 38% white (about 2:1 contrast) | 20 px, 62% white (over 6:1) |
| Settings panel behind About/Licences/PIN | 40% opacity, its help/note text bled through over the dock | 22% opacity, help/note hidden while behind |
| Settings list | first/last rows touched the clip edge | 4 px vertical padding |

## Fixed
- Stale test: `tmp/t_debug.mjs` expected "Asher Butler" in About; About says "Asher" (test updated).

## Deliberately left
- Per-scene date position (Golden/Water/Fog/Night differ on purpose; date is not on the quick-button line in Golden).
- No scroll-edge fade mask on the settings list: masks on a scrolling element risk the 17 ms frame budget on this TV.
- Font-size and radius token refactor not done wholesale (about 24 sizes, many radii): low risk of regressions was preferred; only drifted values touched.
- "Send diagnostics"/phone-pane checks in `t_debug.mjs` need the live bridge and fail in mock mode (not UI defects).

## Tests
`node --check` on all tv-home/web/*.js passes; arrange-test.js passes; t_debug.mjs passes except the bridge-only checks above;
boot_test.mjs shows skeletons then boot gone by 6.5 s.

## Second pass (Y1b, 2026-11-02): every screen at 1920x1080 and 1280x720

Shots: `tmp/y1bshots/` (Q/R before, T/U after) from `tmp/y1b_shots.mjs`; no JS errors in either sweep.

### Defects fixed
| Where | Defect | Fix |
|---|---|---|
| Debug | Settings panel stayed bright behind it (title and help text leaked through) | Debug now sets `.settings.behind` like About (app.js openDebug/closeDebug) |
| Debug | Help line touched the Close row | `.debug-panel .settings-help` margin-top |
| Licences | Blank band and rule above the heading | `.about-sec.lic-page` drops margin, padding and border |
| All CSS | ~24 font sizes, 17 radii, 25 text alphas drifting | Snapped onto the tokens below (changes are 0-1 px steps, same look) |

### Tokens (top of app.css, names stable; the phone remote and overlay should mirror them)
- Type: `--fs-fine 1.0625`, `--fs-caption 1.25`, `--fs-callout 1.4375`, `--fs-body 1.625`, `--fs-title 1.875`, `--fs-headline 2.5`, `--fs-display 3.25` (rem; weight/tracking/leading rules are in the CSS header comment).
- Ink: `--ink-1 .86`, `--ink-2 .7`, `--ink-3 .62` (tertiary raised from .42-.58, so it now passes AA).
- Radii: `--r-xs .5 --r-sm .75 --r-md 1 --r-lg 1.5 --r-xl 2 --r-panel 2.5`.
- Spacing (4/8): `--sp-1..--sp-10`; panels: `--panel-bg`, `--panel-pad`. Motion tokens unchanged.

### Checked and fine
Boot overlay, skeletons, quick buttons, people popover and pick-up, dock and lifted hint, All apps (groups, hidden tab; the gear tile in one shot was only mid scroll), Ask (menu, thinking, answer, long, error), PIN, About, Settings, Debug panes at both sizes.

### Not changed / notes
- `t_debug.mjs` fails "send pane", "sent and shows the phone address", "phone pane shows url" both before and after this pass (the Debug menu gained "Screen on/off log", so its index-based steps are stale). Not caused by this pass.
- Sleep menu shot targeting in my script landed on Settings; the sleep menu was covered in the first pass.
- Dead classic-era CSS (`.time`, `.tile/.face`, `sway/glint`) left in place; removal is a separate safe-cleanup.
