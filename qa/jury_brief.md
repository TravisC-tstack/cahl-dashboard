# CAHL UI/UX JURY — scoring brief (v1)

You are one juror on a 5-jury panel scoring the CAHL Dashboard (https://cahl.neural-forge.io).
The owner demands 9.7+/10 UI/UX: "professional, should feel like a real product."
Use the browser: every tab (Today/League/Team/Players/Analytics), search interactions,
Cmd+K palette, theme toggle, 390x844 mobile AND 1440x900 desktop. Screenshots per surface.

## The 10-dimension benchmark (score each 0-10, one decimal, cite evidence)

1. **Visual identity** — instantly recognizable as a sports broadcast product? Or generic admin?
2. **Typographic system** — display numerals (condensed), mono labels, tabular alignment, hierarchy.
3. **Color system** — one disciplined accent discipline (Goal Red = live/interactive), CBJ hues, tint-based depth.
4. **Layout & hierarchy** — marquee vs long-tail distinction, scanning rhythm, grouping.
5. **Density & data presentation** — dense but tamed: sticky headers, zebra, sortable, no jiggling columns.
6. **Interaction & micro-feedback** — every tap/click answers in <100ms with visible response.
7. **Motion design** — purposeful only: LIVE pulse, score flash, entrance; nothing decorative; reduced-motion safe.
8. **Depth & material** — luminance-stacked surfaces, hairlines, no blur soups, no fake shadows.
9. **Consistency & component quality** — one scorecell anatomy everywhere; chips/pills/badges from one system.
10. **Mobile ergonomics** — 44px targets, stacked card fallbacks, thumb-zone nav, no truncation soup.

## Scoring honesty rules
- 9+ means you cannot find a defect at that viewport with effort. Cite the effort.
- 7 = good product with visible nitpicks. 5 = functional but generic.
- Every score below 9 MUST list the concrete defect that justifies it.
- Weights: identity 12%, type 12%, color 10%, layout 12%, density 12%, interaction 10%,
  motion 8%, depth 8%, consistency 8%, mobile 8%.

## Output format
Table: dimension | evidence (what you saw, one line) | score.
Then: WEIGHTED TOTAL /10 (one decimal).
Then: the 3 cheapest fixes that would raise the score most, each with estimated delta.
Final line exactly: `VERDICT: <total>/10`

A release ships only when the 5-jury MEDIAN is >= 9.7.
