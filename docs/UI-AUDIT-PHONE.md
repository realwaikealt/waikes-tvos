# Phone remote: UI audit (2 Nov 2026)

Scope: `remote/` (React + Vite, served by the bridge). Method: extracted every design value from `remote/src/styles.css`,
screenshotted every tab and sheet with headless Edge against a mock bridge at 393x852, 375x667, 430x932, 744x1133 and
852x393 (before and after), and read them against the Apple HIG checklist (type, spacing, 44 pt targets, contrast,
press states, motion, safe areas, accessibility). The physical TV was not touched.

## Design values: before and after

| Area | Before (drift) | After (one token set, appended to `styles.css`) |
|---|---|---|
| Type sizes | 11, 11.5, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 30, 34 | 12, 13, 14, 15, 16, 17, 20, 22, 28, 34 (`--t-*`); 11/11.5 to 12, 18 to 17, 19 to 20, 21 to 22, 30 to 28 |
| Error colour | `#ff6961` and `#ffb4ae` used ad hoc | `--bad` (fills) and `--err-ink` (text), `--err-bg` (toast) |
| Radii | 8 to 34 mixed | scale `--r-sm 10`, `--r-md 16`, `--r-lg 22`, `--r-xl 30` (declared; legacy radii left where they match component shape, see leftovers) |
| Touch targets | `.person-remove` 40, `.person-name` 40, `.who-seg button` 40, `.fine-link` about 20 | all `min-height: var(--h-touch)` (44) |
| Durations | .07 .15 .2 .25 .28 .3 .32 .35 .38 .4 .42 .5 .9 s | scale `--d-press .07`, `--d-fast .2`, `--d-med .32`, `--d-slow .45`; sheet and scrim now use it |
| z-index | 0/1/30/40/50/60/70 hard coded | `--z-banner 30`, `--z-toast 40`, `--z-sheet 50`, `--z-onboard 60`, `--z-crash 70` |
| `.sheet` background | defined 3 times (0.52, 0.8, 0.95) | one value in `--sheet` (rgba(34,24,32,.95), the TV's Night glass) |
| `.dock` padding | defined twice, conflicting | single definition |
| Secondary text contrast | `--ink-3` 0.60; fine-link 0.38 x 0.8 (about 2.2:1) | `--ink-3` 0.64; fine-link uses `--ink-2` (above 4.5:1 on the sheet) |

## Defects fixed

1. **Stale and Australian copy.** Ask sheet said "Ask for a show" with chips "Put on Bluey" and "What's new on Stan?". Now "Ask Claude",
   placeholder "Ask Claude anything…", chips: Keep watching X / What should we watch tonight?, What's the weather?, Will it rain this week?,
   Tell me a joke (matching the TV). The Ask button on Remote and the Watch empty state say "Ask Claude". Speech recognition is `en-US`
   (was `en-AU`); `<html lang>` and the web manifest are `en-US`.
2. **TV sheet group headers inconsistent**: only some had icons. Backup, Restart, About and Web app controls now carry icons (new Download, Info, Pointer glyphs in the same 24 px, 2 px round stroke set).
3. **Mixed button styles in the TV sheet**: Picture actions were 44 px chips, every other action a 50 px pill. Now pills.
4. **Notes without styling**: Web app controls text used `muted small` classes that had no CSS (rendered at 17 px). Now `note lede` and `more-note role="status"`.
5. **Subtitles appeared twice** on the Remote tab (quick action and the expanded transport row). Transport row no longer repeats it.
6. **Touch targets under 44 pt** (people remove/name, who-picker segments, licences link). Fixed.
7. **Focus ring clipped** on the volume pill (it clips overflow). Offset moved inside.
8. **TV sheet bottom edge** collided with the tab bar's corners; its max height now leaves the bar clear.
9. **Landscape phone (852x393)**: the swipe pad was clipped behind the tab bar and its arrows overlapped the ring. The column now scrolls, the pad keeps 190 px and a smaller ring.
10. **iPad**: the swipe pad filled the whole screen height. Capped at 520 px.
11. **iOS press states**: Safari only fires `:active` when a `touchstart` listener exists. Added a passive no-op listener in `main.jsx`.
12. **Reduced motion**: press-scale, chevron nudges and the endless pulse animations are now off under `prefers-reduced-motion` (previously only durations shrank).
13. Controls no longer select text or show the iOS callout on long press.

## Checked and already fine

Viewport (`user-scalable=no`, `viewport-fit=cover`), `overscroll-behavior: none`, safe-area insets on every edge including the bottom tab bar,
`touch-action: manipulation` (no 300 ms delay), haptics (`tick()` via `navigator.vibrate`, iOS 18 switch-label fallback) on keys and sheet actions,
aria-labels on icon buttons, `focus-visible` ring, Dynamic Type via `--dt`, `prefers-contrast` and `prefers-reduced-transparency`,
sheet dark glass matches the TV Night palette. No "Look" references remain in `remote/src` (grep, case-insensitive).
The only remaining Australian strings are the streaming-service name map in `App.jsx` (`stan`, `kayo`, `binge`, `foxtel-go`), which are valid app ids.

## Leftovers

- Existing font-size and radius declarations were remapped only where they drifted from the scale; a full rewrite of every legacy rule onto `var(--t-*)` and `var(--r-*)` is not done (values now match the scale, but the variables are not yet referenced everywhere).
- White-alpha fills (.07 to .26) are not yet all mapped to `--fill-1/2/3`.
- Not screenshotted: `/diag`, `/install`, boot overlay and the offline/unreachable states beyond the mock's `unreach` state; reviewed from source only.
- Contrast was checked by value, not with a tool, for the translucent glass over bright artwork.
- Real iPhone check of haptics and the landscape layout is still to do.
