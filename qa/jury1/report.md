# UI/UX JURY 1/5 — CAHL Dashboard v50 (Glass Rink)
Reviewed: 2026-09-03, https://cahl.neural-forge.io (style.css?v=50, app.js?v=50)
Method: live browser, desktop 1440x900 (all 5 tabs, sort, theme toggle, Cmd+K, typeahead, team palette select) then mobile emulation 390x844 touch (Today/League/Team/Players, tables, theme). Screenshots in qa/jury1/ (d1-*, d2-*, d3-*, d4-*, d5-*, d6-*, d7-*, d8-*, m1-m5).

## Scorecard

| Dimension | Evidence | Score |
|---|---|---|
| 1. Visual identity | Real broadcast DNA: Chiller badge, red top stripe, mono NO GAMES LIVE pill, Saira Condensed team names, Goal Red reserved. But the marquee hero title is CLIPPED at both viewport edges (spans x=-64 to 1504 on a 1440 viewport) and overlaps the dek — on BOTH desktop and mobile ("…mp Donkeys Hockey" printed over the subtitle). The loudest brand element on the front door is broken. | 6.5 |
| 2. Typographic system | Saira Condensed + JetBrains Mono + Inter present and correctly assigned (96 mono els); tabular-nums on every table cell; mono time column. Defects: "UPCOMING" chip repeated on all 19 rows (starves 5 team names into ellipses), casing anarchy ("UPDATED tonight 11:51 AM", "Next Game Home"), schedule header row misaligned over the two column groups (SCORE over rink chips, RINK over away names). | 7.5 |
| 3. Color system | Dark navy 4-level luminance stack (page→bar→card→inset ticker); light theme verified coherent (navy #0d1b2e text on white). Breaches: alarm-red on the OFF "NO GAMES LIVE" state, red match-highlight in palette, red square bullet on non-live sections, blue team-name vs blue-link ambiguity. | 7.5 |
| 4. Layout & hierarchy | Marquee/long-tail inverted: my-team hero is the quietest zone while 19 equal rows dominate; hero clip breaks the top of the page; provenance metadata sits inline with nav tabs; Analytics GOAL DIFF renders as an empty hairline with a prose legend; SESSION RECORDS is a labeled void. | 5.5 |
| 5. Density & data presentation | Sticky theads (61/61), working sort with ↓/↑ flip (tested on PTS), tabular figures, uniform 39–46px row rhythm. No zebra anywhere; single header row serves two column groups; mobile standings cut at OTL (PTS/GF/GA off-canvas, no scroll cue) and roster loses 4/10 columns mid-PTS. | 6.0 |
| 6. Interaction & micro-feedback | Palette opens in 0.12s with selected-row ring + keycap footer; typeahead returns cross-team results <1s with match highlight; sort instant; focus-visible rings present; nav content swap 151ms. Misses: theme toggle 39x30 (<44px), ⌘K chip rendered on touch devices where it's dead, duplicated Refresh affordances. | 7.0 |
| 7. Motion design | 11 keyframe sets, all purposeful (live-breathe, live-dot-pulse, score-flash, shimmer, pal-fade 0.12s, rise-in entrance); 3 prefers-reduced-motion blocks + print grayscale. Risks: entrance fade is slow enough that cold loads show blank cards for 2–3s (captured twice); hero-glow-breathe is decorative. | 7.0 |
| 8. Depth & material | Hairlines everywhere, no blur soup (backdrop-filter:none), no fake shadows, consistent 10–12px radii, inset ticker pill is the best material on the site. Deductions: table bodies are flat separator-only fields; unexplained amber stripe artifact at the left viewport edge on mobile captures. | 7.5 |
| 9. Consistency & component quality | One card anatomy (red bullet + mono caps + rule) across 7+ cards; one chip/pill system. Breaks: player typeahead dropdown CLIPPED under the next card (verified: dropdown bottom 444 vs card bottom 306, z-60 inside z-30 stacking context); duplicate header row mid-roster; GOALIES grid drifts vs skater tables; 3 overlapping search affordances on Team tab. | 6.5 |
| 10. Mobile ergonomics | No page-level horizontal overflow (390=390) but header controls overflow the viewport by 95px (live pill ends at x=485, clipped); theme toggle 39x30, Refresh 29px; Today rows are squeezed desktop tables at 180–200px tall, not card fallbacks; standings/roster cut with scrollbar-only hint; provenance text collides with Analytics in the bottom strip. | 3.5 |

## WEIGHTED TOTAL
identity 6.5×.12=0.78 · type 7.5×.12=0.90 · color 7.5×.10=0.75 · layout 5.5×.12=0.66 · density 6.0×.12=0.72 · interaction 7.0×.10=0.70 · motion 7.0×.08=0.56 · depth 7.5×.08=0.60 · consistency 6.5×.08=0.52 · mobile 3.5×.08=0.28

**WEIGHTED TOTAL: 6.5/10**

## 3 cheapest high-delta fixes
1. **Fix the hero marquee clip/overlap** (`.hero-name-wrap` spans x=-64→1504, overlaps the dek on desktop AND mobile). One CSS rule; it's the front door of the site. Est. delta: identity +1.0, layout +1.0 → **+0.26**.
2. **Mobile card fallback + 44px targets**: stacked game/team cards <480px (Today rows are 180–200px squeezed tables), pin PTS or reduce columns on standings/roster with an edge-fade cue, bump toggle/Refresh to 44px, hide ⌘K chip on touch, move provenance out of the bottom strip and fix the header 95px overflow. Est. delta: mobile 3.5→7.5 → **+0.32**.
3. **Kill the per-row UPCOMING chip + repair the schedule header**: remove 19 redundant chips (returns width, fixes 5 ellipses), add a real header per column group (or single-group layout), add zebra tint. Est. delta: type +0.5, density +0.5, consistency +0.5 → **+0.16**.

(One-line honorable mention: raise the typeahead dropdown's stacking so it isn't clipped by the next card — single z-index fix.)

VERDICT: 6.5/10
