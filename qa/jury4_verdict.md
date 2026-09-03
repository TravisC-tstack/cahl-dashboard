# CAHL UI/UX JURY — Juror 4/5 (Interaction & Flow lens)

Site: https://cahl.neural-forge.io (app v50, /api/version js:50). Desktop 1800×868, mobile 390×844 (CDP emulation).
Exercise battery: typed in both search boxes (team typeahead + ⌘K palette), real-key Cmd+K open/nav/Enter/Escape,
theme toggle (incl. 5× rapid), rapid tab switching (10-click storm + clean loop), Refresh single + 5× rapid,
sort clicks on League standings + Players table (mouse + keyboard), day pills, retry affordance, mobile pass.
22 screenshots in `qa/jury4/`. Zero JS console errors the whole session.

## Per-dimension scores

| # | Dimension | Evidence (what I saw) | Score |
|---|-----------|----------------------|-------|
| 1 | Visual identity | Chiller logo, CBJ Union Blue + Goal Red, mono micro-labels, scoreboard energy on League/Players; generic pale-gray empty states (blank skeleton cards) drag it. | 7.0 |
| 2 | Typographic system | Saira Condensed + JetBrains Mono present and consistent; but season-table numerals not tabular (misaligned columns), times low-contrast on mobile, no display-scale jump on scores. | 6.5 |
| 3 | Color system | Disciplined: red = live/interactive/active-tab/PLAYOFF LINE; blue links/team names; light+dark both coherent, no neon. Stray pink block behind ⌘K input text (dark) is the one off-system blemish. | 7.5 |
| 4 | Layout & hierarchy | Strong card/section grammar when rendered; but hash-routing bug breaks deep links (team→league), League dead on first run, MY TEAM hero overlaps its subtitle. | 6.5 |
| 5 | Density & data presentation | Sticky thead + sortable headers + PLAYOFF LINE good; rows ~80px airy for a stats table, numerals centered not right-aligned, no DIFF/STK columns, 'Bye Week' as a standings row, all-zero season lacks an empty-state. | 6.0 |
| 6 | Interaction & micro-feedback | **Harsh lens.** Team tab hang (blank skeletons, no shimmer/spinner/error/retry), League tab fires zero API calls for first-run users with no explanation, team typeahead 'timed out' msg persists stale, /api/players 18.9s and /api/teams 25.5s cold, per-keystroke lookup spam. Wins: refresh disable + suppression, palette arrows/Enter/Escape, sort arrows ~170-210ms, retry works. | 5.5 |
| 7 | Motion design | 11 keyframes; spinner/pulses run but hidden; mobile Today hero glow is decorative; theme auto-revert after palette close felt glitchy. Positives: reduced-motion covered (3 blocks), long-task observer caught nothing in tab storm. | 6.5 |
| 8 | Depth & material | Flat surfaces + hairlines + single glow accent; no blur soup; palette backdrop correct dim (rgba .66). Solid. | 7.5 |
| 9 | Consistency & component quality | Same card/section/pill grammar everywhere incl. palette; avatar initials bug ('CE' for Aaron Rucker); 'UPDATED tonight 11:54 AM' copy bug; red-on-red-on-UPCOMING semantics drift (red square on an upcoming section). | 7.0 |
| 10 | Mobile ergonomics | **Weakest surface.** Bottom nav right pattern (~70px targets) but footer text overlaps nav, hero overlaps subtitle + clips at edge, table header collapses to 'TimeHomeScoreAwayRink', ⌘K hint on touch, truncation 'Goal Miners (Thurs…'. | 5.0 |

## Weighted total

Weights per brief (identity .12, type .12, color .10, layout .12, density .12, interaction .10, motion .08, depth .08, consistency .08, mobile .08).

**WEIGHTED TOTAL: 6.5 /10**

## The 3 cheapest fixes that raise the score most

1. **Fix the first-run dead ends (Team hang + League empty).** Team tab: render cached/partial team data immediately, keep shimmer animating, and after ~8s swap to a real error card with a Retry button. League: when `state.leagueId` is empty, show a "Pick your team to unlock league views" card in `#leagueContent` instead of nothing. Also fix `#team` deep-link rendering the League view.
   *Estimated delta: interaction 5.5→7.5, layout 6.5→7.5 → total +0.9*
2. **Debounce + cache both typeaheads, and warm/CDN the heavy endpoints.** 300ms debounce with in-flight cancellation on team + palette search; cache last result set; add `/api/players` + `/api/teams` to the hourly cron warm (or Cache-Control on the cold 19-25s responses) so first search never times out.
   *Estimated delta: interaction +0.7, density +0.3 → total +0.6*
3. **Mobile: bottom safe-area padding, real stacked cards, kill overlapping text.** Add `padding-bottom` for the fixed nav, replace the broken table header + rows with stacked game cards (time · rink · away @ home · countdown), restore hero text flow, drop the ⌘K hint on touch.
   *Estimated delta: mobile 5.0→7.0, identity/type +0.2 → total +0.5*

That sums to ~+2.0 → ~8.5/10 attainable without a redesign; 9.7 needs the display-type/data-viz layer that lens 1-3 jurors should weigh in on.

## Interaction-lens log (what hung / double-fired / lacked feedback)

- HUNG: Team tab after rapid switch storm — blank `.skeleton-card`s, spinner in DOM but hidden, "Loading your team…" with 0 pending network requests; recovered only on full reload (never on tab re-entry). Evidence: 03-team-hung.png, 04-team-freshload.png.
- DEAD: League tab for first-run users — day pills clickable, zero API calls ever fired (`/api/league*` absent from the entire session's resource log), `#leagueContent` empty, no message. `loadLeagueContent` gated on `state.leagueId` which is only set by choosing a team — silently. Evidence: 13-league-fresh.png + resource log.
- STALE FEEDBACK: team typeahead timeout message ("Teams request timed out — tap to retry") persisted across new queries; a brand-new query showed the old error for 3+ seconds until retry was tapped. Evidence: 06-teamsearch-dead.png.
- NO-HANG WINS: Refresh button disables during flight and suppresses duplicate cycles (5 rapid clicks → 3 clean cycles, no storm); LIVE auto-refresh toggle survives 4 rapid toggles with no interval leak; palette garbage query gets a proper "No matches" state; sort clicks give arrow feedback in ~170-210ms and are keyboard-operable (tabindex+Enter); palette Esc/arrows/Enter all correct.
- LATENCY (cold Vercel lambdas): /api/players 18,894ms; /api/teams 25,523ms; league HTML asset 16,557ms. Warm calls: today/scores 110-921ms, lookups ~95-211ms, refresh ~110-250ms.
- Double-fire check: none found. Per-keystroke network spam found instead (no debounce): players/lookup fired on 'Bo','Bow','Bowe','Bowen' — and the longest query was the slowest (17.4s).

VERDICT: 6.5/10
