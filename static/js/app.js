// If this page was restored from the back/forward cache (bfcache), it may be a
// stale build — force a real reload so the no-store shell refetches.
window.addEventListener('pageshow', e => {
  if (e.persisted) location.reload();
});

// Version guard: if the cached HTML and JS disagree, reload once to resync.
const JS_VERSION = 46;
if (window.APP_VERSION && window.APP_VERSION !== JS_VERSION && !sessionStorage.getItem('vresync')) {
  sessionStorage.setItem('vresync', '1');
  location.reload();
}

// Self-heal: if the server is running a NEWER frontend than this cached JS, reload fresh.
fetch('/api/version').then(r => r.json()).then(v => {
  if (v.js > JS_VERSION && !sessionStorage.getItem('vserverheal')) {
    sessionStorage.setItem('vserverheal', '1');
    location.reload();
  }
}).catch(() => {});

const $main = document.getElementById('main');
const $ver = document.getElementById('verBadge');
if ($ver) $ver.textContent = 'v' + JS_VERSION;
    const $refresh = document.getElementById('refreshBtn');
    const $auto = document.getElementById('autoToggle');
    const navLinks = document.querySelectorAll('.nav-link');

    let state = {
      tab: 'today',
      leagueId: localStorage.getItem('cahl-league') || '',
      leagueDay: localStorage.getItem('cahl-league-day') || '',
      teamId: localStorage.getItem('cahl-team') || '',
      // Your saved default team (drives the Today hero); teamId is just what you're browsing
      myTeam: localStorage.getItem('cahl-myteam') || localStorage.getItem('cahl-team') || '',
      auto: false,
      leagues: [],
      teams: [],
      teamsLeague: '',
      allTeams: [],
      allTeamsLoading: false,
      teamsError: false,
      allPlayers: [],
      allPlayersLoading: false,
      playersError: false,
      board: { level: 'all', sortKey: 'pts', sortDir: 'desc', showAll: false },
      rosterSort: { key: 'pts', dir: 'desc' },
      goalieSort: { key: 'gp', dir: 'desc' },
      standingsSort: { key: 'pts', dir: 'desc' },
      playersLeague: localStorage.getItem('cahl-players-league') || '',
      playersDay: '',
      _sessions: null,
      sessionDate: '',
      calMonth: '',
      calDay: '',
      leaders: null,
      todayGames: [],
      cache: {}
    };

    const TABS = ['today','league','team','players','analytics'];
    let autoTimer = null;

    function $(sel){ return document.querySelector(sel); }
    function fmtTime(t){ return t || 'TBD'; }

    // Escape scraped text (team/player names come from chillerstats.com) before HTML injection
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Platform detection: viewport width + primary pointer + UA fallback.
    // body gets is-desktop / is-tablet / is-mobile plus data-pointer and data-platform.
    const wideMQ = window.matchMedia('(min-width: 900px)');
    const midMQ = window.matchMedia('(min-width: 600px)');
    const coarseMQ = window.matchMedia('(pointer: coarse)');
    // Safari < 14: MediaQueryList only has addListener
    const onMQChange = (mq, fn) => {
      if (mq.addEventListener) mq.addEventListener('change', fn);
      else if (mq.addListener) mq.addListener(fn);
    };
    function syncViewportClass() {
      const coarse = coarseMQ.matches;
      const wide = wideMQ.matches;
      const mid = midMQ.matches;
      const ua = navigator.userAgent || '';
      // iPadOS 13+ reports as Mac; detect via touch points
      const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
      const uaMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua) || isIPadOS;
      let platform;
      if (coarse || uaMobile) platform = (mid && wide) ? 'tablet' : 'mobile';
      else platform = wide ? 'desktop' : 'mobile';
      document.body.classList.remove('is-desktop', 'is-tablet', 'is-mobile');
      document.body.classList.add('is-' + platform);
      document.body.dataset.pointer = coarse ? 'coarse' : 'fine';
      document.body.dataset.platform = platform;
    }
    syncViewportClass();
    onMQChange(wideMQ, syncViewportClass);
    onMQChange(midMQ, syncViewportClass);
    onMQChange(coarseMQ, syncViewportClass);

    // ---- Theme toggle (light <-> dark), persisted ----
    const rootEl = document.documentElement;
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    function applyTheme(t) {
      rootEl.setAttribute('data-theme', t);
      localStorage.setItem('cahl-theme', t);
      if (themeMeta) themeMeta.setAttribute('content', t === 'dark' ? '#070d1a' : '#002654');
      const themeBtn = document.getElementById('themeToggle');
      if (themeBtn) themeBtn.setAttribute('aria-pressed', t === 'dark' ? 'true' : 'false');
    }
    document.getElementById('themeToggle').addEventListener('click', () => {
      applyTheme(rootEl.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });

    // Full text for W/L/T/OTL chips (screen readers shouldn't rely on color)
    function chipLabel(r) {
      return ({ w: 'Win', l: 'Loss', t: 'Tie', otl: 'Overtime loss' })[r] || r;
    }

    // ---- Two-step league picker: day chips -> league pills ----
    const DAY_ORDER = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Other'];

    function leagueDay(name) {
      const n = (name || '').toLowerCase();
      if (n.includes('sunday')) return 'Sunday';
      if (n.includes('monday')) return 'Monday';
      if (/\btue\b|tuesday/.test(n)) return 'Tuesday';
      if (n.includes('wednesday')) return 'Wednesday';
      if (/\bthur\b|thursday/.test(n)) return 'Thursday';
      if (n.includes('friday')) return 'Friday';
      return 'Other';
    }

    function shortLeagueName(name) {
      let s = (name || '').trim();
      s = s.replace(/^(?:NTPRD Chiller\s+)?(Sunday|Monday|Tuesday|Tue|Wednesday|Thursday|Thur|Friday)\s*-?\s*/i, '');
      s = s.replace(/^NTPRD Chiller\s+/i, '');
      s = s.replace(/\s*-?\s*league\s*$/i, '');
      s = s.replace(/^-\s*/, '').trim();
      return s || name;
    }

    function leagueGroups() {
      const groups = {};
      DAY_ORDER.forEach(d => { groups[d] = []; });
      state.leagues.forEach(l => groups[leagueDay(l.name)].push(l));
      return groups;
    }

    function selectedLeagueDay() {
      if (state.leagueDay) return state.leagueDay;
      if (state.leagueId) {
        const l = state.leagues.find(x => x.id === state.leagueId);
        if (l) return leagueDay(l.name);
      }
      return '';
    }

    function pickerHtml() {
      const groups = leagueGroups();
      const day = selectedLeagueDay();
      let html = '<div class="picker-days">';
      DAY_ORDER.forEach(d => {
        if (!groups[d].length) return;
        html += `<span class="pill day-pill ${d === day ? 'active' : ''}" data-day="${d}" tabindex="0" role="button">${d}<span class="pill-count">${groups[d].length}</span></span>`;
      });
      html += '</div>';
      if (day && groups[day].length) {
        html += '<div class="picker-leagues">';
        groups[day].forEach(l => {
          html += `<span class="pill league-pill ${l.id === state.leagueId ? 'active' : ''}" data-lid="${l.id}" tabindex="0" role="button">${esc(shortLeagueName(l.name))}</span>`;
        });
        html += '</div>';
      }
      return html;
    }

    function currentLeagueName() {
      const l = state.leagues.find(x => x.id === state.leagueId);
      return l ? l.name : '';
    }

    async function chooseLeague(lid) {
      if (!lid) return;
      state.leagueId = lid;
      localStorage.setItem('cahl-league', lid);
      const l = state.leagues.find(x => x.id === lid);
      if (l) {
        state.leagueDay = leagueDay(l.name);
        localStorage.setItem('cahl-league-day', state.leagueDay);
      }
      // Team list belongs to the previous league — force a refetch
      state.teams = [];
      state.teamsLeague = '';
      if (state.tab === 'league') await renderLeague();
      else if (state.tab === 'team') await renderTeam();
      else if (state.tab === 'analytics') await renderAnalytics();
      else setTab('league');
    }

    function changeLeagueHtml() {
      return `<div class="picker-current">League: <b>${currentLeagueName()}</b> <span class="link" data-change-league>Change</span></div>`;
    }

    // ---- Players-tab division filter (independent of main league selection) ----
    function playersPickerHtml() {
      const groups = leagueGroups();
      const activeDay = state.playersDay || (state.playersLeague ? leagueDay(currentPlayersLeagueName()) : '');
      let html = '<div class="picker-days">';
      html += `<span class="pill day-pill ${!state.playersLeague ? 'active' : ''}" data-pl-all="1" tabindex="0" role="button">All CAHL</span>`;
      DAY_ORDER.forEach(d => {
        if (!groups[d].length) return;
        html += `<span class="pill day-pill ${d === activeDay ? 'active' : ''}" data-pl-day="${d}" tabindex="0" role="button">${d}<span class="pill-count">${groups[d].length}</span></span>`;
      });
      html += '</div>';
      if (activeDay && groups[activeDay] && groups[activeDay].length) {
        html += '<div class="picker-leagues">';
        groups[activeDay].forEach(l => {
          html += `<span class="pill league-pill ${l.id === state.playersLeague ? 'active' : ''}" data-pl-lid="${l.id}" tabindex="0" role="button">${esc(shortLeagueName(l.name))}</span>`;
        });
        html += '</div>';
      }
      return html;
    }

    function currentPlayersLeagueName() {
      const l = state.leagues.find(x => x.id === state.playersLeague);
      return l ? l.name : '';
    }

    function leaderSection(title, list, valKey) {
      if (!list || !list.length) return '';
      const rows = list.map(p =>
        `<tr class="link" onclick="selectPlayer('${p.team_id || ''}','${p.player_id || ''}')"><td class="num">${p.rank || ''}</td><td><span class="link">${esc(p.name)}</span></td><td>${esc(p.team)}</td><td class="num">${p[valKey] ?? p.value ?? 0}</td></tr>`
      ).join('');
      return `<h3 style="margin-top:16px">${title}</h3><table><thead><tr><th>#</th><th>Player</th><th>Team</th><th class="num">${title}</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    // ---- Global team search with typeahead ----
    function teamSearchHtml() {
      return `<div class="team-search">
        <input id="teamSearch" type="text" role="combobox" aria-autocomplete="list" aria-controls="teamSuggest" aria-expanded="false" aria-label="Search for a team" placeholder="Type a team name\u2026" autocomplete="off" autocapitalize="off" spellcheck="false" />
        <div id="teamSuggest" class="typeahead" role="listbox"></div>
      </div>`;
    }

    async function loadAllTeams(force=false) {
      if (state.allTeamsLoading) return;
      if (state.allTeams.length && !force) return;
      state.allTeamsLoading = true;
      state.teamsError = false;
      const live = $('#teamSearch');
      if (live && live.value.trim()) renderTypeahead(live);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      try {
        const res = await fetch('/api/teams', { signal: ctrl.signal, cache: 'no-store' });
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data && data.teams);
        if (Array.isArray(list) && list.length) {
          state.allTeams = list;
          state.teamsError = false;
        } else {
          state.allTeams = Array.isArray(list) ? list : [];
          state.teamsError = (data && data.error) ? data.error : 'No teams returned';
        }
      } catch (e) {
        state.teamsError = (e && e.name === 'AbortError') ? 'Teams request timed out' : 'Couldn\u2019t load teams';
      } finally {
        clearTimeout(timer);
        state.allTeamsLoading = false;
      }
      const input = $('#teamSearch');
      if (input && input.value.trim()) renderTypeahead(input);
    }

    async function loadAllPlayers(force=false) {
      if (state.allPlayersLoading) return;
      if (state.allPlayers.length && !force && !state.playersPartial) return;
      state.allPlayersLoading = true;
      state.playersError = false;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 22000);
      try {
        const res = await fetch('/api/players', { signal: ctrl.signal, cache: 'no-store' });
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data && data.players);
        if (Array.isArray(list) && list.length) {
          state.allPlayers = list;
          state.playersError = false;
          if (!Array.isArray(data) && data.partial) {
            state.playersPartial = { fetched: data.fetched, total: data.total };
            state.playersRetries = (state.playersRetries || 0) + 1;
            if (state.playersRetries <= 4) {
              setTimeout(() => loadAllPlayers(true), 8000);
            }
          } else {
            state.playersPartial = null;
            state.playersRetries = 0;
          }
        } else {
          state.playersError = (data && data.error) ? data.error : 'No players returned';
        }
      } catch (e) {
        state.playersError = (e && e.name === 'AbortError') ? 'Player index timed out' : 'Couldn\u2019t load players';
      } finally {
        clearTimeout(timer);
        state.allPlayersLoading = false;
      }
      const el = document.getElementById('fullLeaderboard');
      if (el) {
        const wrap = document.createElement('div');
        wrap.innerHTML = leaderboardHtml();
        if (wrap.firstElementChild) el.replaceWith(wrap.firstElementChild);
      }
      const input = $('#playerSearch');
      if (input && input.value.trim()) renderPlayerTypeahead(input);
    }

    let lookupTimer = null;
    let lookupCtrl = null;
    async function lookupPlayers(q) {
      const query = (q || '').trim();
      if (query.length < 2) return { players: [], error: null, partial: false };
      if (lookupCtrl) lookupCtrl.abort();
      lookupCtrl = new AbortController();
      const timer = setTimeout(() => lookupCtrl.abort(), 40000);
      try {
        const res = await fetch('/api/players/lookup?q=' + encodeURIComponent(query), {
          signal: lookupCtrl.signal,
          cache: 'no-store',
        });
        const data = await res.json();
        const list = (data && data.players) || [];
        return {
          players: Array.isArray(list) ? list : [],
          error: data && data.error ? data.error : null,
          partial: !!(data && data.partial),
        };
      } catch (e) {
        return {
          players: [],
          error: (e && e.name === 'AbortError') ? 'Lookup timed out' : 'Couldn\u2019t search players',
          partial: false,
        };
      } finally {
        clearTimeout(timer);
      }
    }

    async function pickSearchedTeam(teamId, leagueId) {
      state.teamId = teamId;
      localStorage.setItem('cahl-team', teamId);
      setMyTeam(teamId); // searching out a team and picking it = choosing your team
      if (leagueId) {
        state.leagueId = leagueId;
        localStorage.setItem('cahl-league', leagueId);
        const l = state.leagues.find(x => x.id === leagueId);
        if (l) {
          state.leagueDay = leagueDay(l.name);
          localStorage.setItem('cahl-league-day', state.leagueDay);
        }
        state.teams = []; // force refetch of this league's roster
        state.teamsLeague = '';
      }
      await renderTeam();
    }

    // ---- Team search typeahead (fully delegated — re-renders can't leak listeners) ----
    let taIndex = -1;

    function taItems() {
      const box = $('#teamSuggest');
      return box ? [...box.querySelectorAll('.typeahead-item[data-tid]')] : [];
    }

    function taHighlight(items) {
      items.forEach((item, i) => item.classList.toggle('ta-active', i === taIndex));
      if (items[taIndex]) items[taIndex].scrollIntoView({ block: 'nearest' });
    }

    function taClose(input, box) {
      box.classList.remove('open');
      if (input) input.setAttribute('aria-expanded', 'false');
      taIndex = -1;
    }

    function renderTypeahead(input) {
      const box = $('#teamSuggest');
      if (!box) return;
      const q = input.value.trim().toLowerCase();
      if (!q) { box.innerHTML = ''; taClose(input, box); return; }
      const matches = state.allTeams.filter(t => t.name.toLowerCase().includes(q)).slice(0, 8);
      if (state.allTeamsLoading && !state.allTeams.length) {
        box.innerHTML = '<div class="typeahead-item muted">Loading teams\u2026</div>';
      } else if (state.teamsError && !state.allTeams.length) {
        box.innerHTML = '<div class="typeahead-item" data-tretry><span class="ta-name">' + esc(state.teamsError) + ' \u2014 tap to retry</span></div>';
      } else if (!state.allTeams.length) {
        box.innerHTML = '<div class="typeahead-item" data-tretry><span class="ta-name">No teams loaded \u2014 tap to retry</span></div>';
      } else if (!matches.length) {
        box.innerHTML = '<div class="typeahead-item muted">No teams match</div>';
      } else {
        box.innerHTML = matches.map(t =>
          `<div class="typeahead-item" role="option" data-tid="${t.id}" data-lid="${t.league_id}"><span class="ta-name">${esc(t.name)}</span><span class="ta-league">${esc(t.league_name)}</span></div>`
        ).join('');
      }
      taIndex = -1;
      box.classList.add('open');
      input.setAttribute('aria-expanded', 'true');
    }

    // ---- Player lookup typeahead (Players tab) ----
    let paIndex = -1;

    function playerSearchHtml() {
      return `<div class="team-search">
        <input id="playerSearch" type="text" role="combobox" aria-autocomplete="list" aria-controls="playerSuggest" aria-expanded="false" aria-label="Search for a player" placeholder="Type a player name…" autocomplete="off" autocapitalize="off" spellcheck="false" />
        <div id="playerSuggest" class="typeahead" role="listbox"></div>
      </div>`;
    }

    function paItems() {
      const box = $('#playerSuggest');
      return box ? [...box.querySelectorAll('.typeahead-item[data-pname]')] : [];
    }

    function paHighlight(items) {
      items.forEach((item, i) => item.classList.toggle('ta-active', i === paIndex));
      if (items[paIndex]) items[paIndex].scrollIntoView({ block: 'nearest' });
    }

    function paClose(input, box) {
      box.classList.remove('open');
      if (input) input.setAttribute('aria-expanded', 'false');
      paIndex = -1;
    }

    function playerRowHtml(p) {
      const tok = p.token || '';
      const pid = p.player_id || '';
      return `<div class="typeahead-item" role="option" data-ptoken="${esc(tok)}" data-pid="${esc(pid)}" data-tid="${esc(p.team_id || '')}" data-tname="${esc(p.team)}" data-pname="${esc(p.name)}"><span class="ta-name">${esc(p.name)}</span><span class="ta-league">${esc(p.team)} \u00b7 ${esc(p.position || '')}</span></div>`;
    }

    function renderPlayerTypeahead(input) {
      const box = $('#playerSuggest');
      if (!box) return;
      const q = input.value.trim();
      if (!q) { box.innerHTML = ''; paClose(input, box); return; }
      const ql = q.toLowerCase();
      const local = state.allPlayers.filter(p =>
        (p.name || '').toLowerCase().includes(ql) || (p.team || '').toLowerCase().includes(ql)
      ).slice(0, 10);
      if (local.length) {
        box.innerHTML = local.map(playerRowHtml).join('');
      } else if (q.length < 2) {
        box.innerHTML = '<div class="typeahead-item muted">Keep typing a name\u2026</div>';
      } else {
        box.innerHTML = '<div class="typeahead-item muted">Searching\u2026</div>';
      }
      paIndex = -1;
      box.classList.add('open');
      input.setAttribute('aria-expanded', 'true');
      if (q.length < 2) return;
      clearTimeout(lookupTimer);
      lookupTimer = setTimeout(async () => {
        if (!$('#playerSearch') || $('#playerSearch').value.trim() !== q) return;
        const result = await lookupPlayers(q);
        if (!$('#playerSearch') || $('#playerSearch').value.trim() !== q) return;
        const boxNow = $('#playerSuggest');
        if (!boxNow) return;
        if (result.error && !result.players.length) {
          boxNow.innerHTML = '<div class="typeahead-item" data-plookupretry><span class="ta-name">' + esc(result.error) + ' \u2014 tap to retry</span></div>';
        } else if (!result.players.length) {
          const extra = result.partial ? ' Index still filling \u2014 tap to retry.' : '';
          boxNow.innerHTML = '<div class="typeahead-item" data-plookupretry><span class="ta-name">No players match.' + extra + '</span></div>';
        } else {
          boxNow.innerHTML = result.players.slice(0, 10).map(playerRowHtml).join('');
        }
        paIndex = -1;
        boxNow.classList.add('open');
      }, 220);
    }

    function pickSearchedPlayer(token) {
      if (!token) { showToast('No profile link for that player'); return; }
      state.profileReturn = 'players';
      renderPlayerProfile(null, null, token);
    }

    // ---- Full sortable leaderboard ----
    function leagueLevel(name) {
      // First standalone a/b/c/d letter = level ("North A"/"West B" are regions, not levels)
      const m = (name || '').toLowerCase().match(/(?:^|\s)([abcd])(?=\s|$|-)/);
      return m ? m[1] : 'other';
    }

    const BOARD_COLS = [
      { key: 'name', label: 'Player' },
      { key: 'team', label: 'Team' },
      { key: 'position', label: 'Pos' },
      { key: 'gp', label: 'GP', num: true },
      { key: 'g', label: 'G', num: true },
      { key: 'a', label: 'A', num: true },
      { key: 'pts', label: 'Pts', num: true },
      { key: 'ppg', label: 'P/GP', num: true },
      { key: 'pim', label: 'PIM', num: true },
    ];

    // Generic row sorter + sortable header renderer (used by roster/standings tables)
    function sortRows(rows, key, dir, valFn) {
      const d = dir === 'asc' ? 1 : -1;
      return rows.slice().sort((a, b) => {
        const va = valFn(key, a), vb = valFn(key, b);
        if (va < vb) return -d;
        if (va > vb) return d;
        return 0;
      });
    }

    function sortTh(key, label, sort, rt, num) {
      const arrow = sort.key === key ? (sort.dir === 'desc' ? ' \u2193' : ' \u2191') : '';
      return `<th${num ? ' class="num"' : ''} data-sort="${key}" data-rt="${rt}" tabindex="0" role="button" title="Sort by ${label}">${label}${arrow}</th>`;
    }

    const SKATER_VAL = (key, p) => {
      if (key === 'name') return p.name.toLowerCase();
      if (key === 'position') return (p.position || '').toLowerCase();
      if (key === 'jersey') return isNaN(parseInt(p.jersey)) ? 9999 : parseInt(p.jersey);
      if (key === 'ppg') return p.gp ? p.pts / p.gp : 0;
      if (key === 'ggp') return p.gp ? p.g / p.gp : 0;
      return p[key] ?? 0;
    };

    const GOALIE_VAL = (key, p) => {
      if (key === 'name') return p.name.toLowerCase();
      if (key === 'jersey') return isNaN(parseInt(p.jersey)) ? 9999 : parseInt(p.jersey);
      if (key === 'winpct') return p.gp ? p.w / p.gp : 0;
      return p[key] ?? 0;
    };

    const STANDINGS_VAL = (key, s) => key === 'team' ? s.team.toLowerCase() : (s[key] ?? 0);

    function boardRows() {
      const { level, sortKey, sortDir } = state.board;
      let rows = state.allPlayers;
      if (level !== 'all') rows = rows.filter(p => leagueLevel(p.league_name) === level);
      const dir = sortDir === 'asc' ? 1 : -1;
      const val = p => {
        if (sortKey === 'name') return p.name.toLowerCase();
        if (sortKey === 'team') return p.team.toLowerCase();
        if (sortKey === 'position') return (p.position || '').toLowerCase();
        if (sortKey === 'ppg') return p.gp ? p.pts / p.gp : 0;
        return p[sortKey] ?? 0;
      };
      return rows.slice().sort((a, b) => {
        const va = val(a), vb = val(b);
        if (va < vb) return -dir;
        if (va > vb) return dir;
        return 0;
      });
    }

    function leaderboardHtml() {
      const { level, sortKey, sortDir, showAll } = state.board;
      const LEVELS = [['all', 'All Levels'], ['b', 'B League'], ['c', 'C League'], ['d', 'D League'], ['other', 'Other']];
      let html = '<div class="card" id="fullLeaderboard"><h2>Full Leaderboard</h2><div class="picker-days">';
      LEVELS.forEach(([k, label]) => {
        html += `<span class="pill ${level === k ? 'active' : ''}" data-level="${k}" tabindex="0" role="button">${label}</span>`;
      });
      html += '</div>';

      if (!state.allPlayers.length) {
        if (state.playersError) {
          html += '<div class="empty">' + esc(typeof state.playersError === 'string' ? state.playersError : 'Couldn\u2019t load the player index') + ' <button class="ghost small" data-pretry style="margin-top:8px">Retry</button></div></div>';
        } else if (state.allPlayersLoading) {
          html += '<div class="empty">Loading the full leaderboard\u2026 <span class="picker-hint" style="display:block;margin-top:4px">PTS/G leaders below are ready now. Search a name up top \u2014 lookup does not wait for this list.</span></div></div>';
        } else {
          html += '<div class="empty">Full leaderboard isn\u2019t loaded yet. <button class="ghost small" data-pretry style="margin-top:8px">Load leaderboard</button></div></div>';
        }
        return html;
      }

      const rows = boardRows();
      const shown = showAll ? rows : rows.slice(0, 100);
      html += `<div class="picker-hint">${rows.length} players${state.playersPartial ? ` (still loading ${state.playersPartial.fetched}/${state.playersPartial.total}\u2026)` : ''} \u00b7 click a column to sort (again to flip) \u00b7 tap a row for all-time stats</div>`;
      html += '<table class="board"><thead><tr><th class="num">#</th>';
      BOARD_COLS.forEach(c => {
        const arrow = sortKey === c.key ? (sortDir === 'desc' ? ' \u2193' : ' \u2191') : '';
        html += `<th${c.num ? ' class="num"' : ''} data-sort="${c.key}" tabindex="0" role="button" title="Sort by ${c.label}">${c.label}${arrow}</th>`;
      });
      html += '</tr></thead><tbody>';
      html += shown.map((p, i) => `
        <tr class="link" onclick="selectPlayerToken('${p.token || ''}')">
          <td class="num">${i + 1}</td>
          <td><span class="link">${esc(p.name)}</span></td>
          <td>${esc(p.team)}</td>
          <td>${esc(p.position || '-')}</td>
          <td class="num">${p.gp}</td><td class="num">${p.g}</td><td class="num">${p.a}</td>
          <td class="num">${p.pts}</td>
          <td class="num">${p.gp ? (p.pts / p.gp).toFixed(2) : '-'}</td>
          <td class="num">${p.pim}</td>
        </tr>`).join('');
      html += '</tbody></table>';
      if (!showAll && rows.length > shown.length) {
        html += `<button class="ghost small" data-showall style="margin-top:10px">Show all ${rows.length} players</button>`;
      } else if (showAll && rows.length > 100) {
        html += `<button class="ghost small" data-showall style="margin-top:10px">Show top 100</button>`;
      }
      html += '</div>';
      return html;
    }

    function _legacyBindTeamSearch() {
      const input = $('#teamSearch');
      const box = $('#teamSuggest');
      if (!input || !box) return;

      input.addEventListener('focus', () => { loadAllTeams(); }); // probe

      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        if (!q) { box.style.display = 'none'; box.innerHTML = ''; return; }
        const matches = state.allTeams.filter(t => t.name.toLowerCase().includes(q)).slice(0, 8);
        if (!state.allTeams.length) {
          box.innerHTML = '<div class="typeahead-item muted">Loading teams\u2026</div>';
        } else if (!matches.length) {
          box.innerHTML = '<div class="typeahead-item muted">No teams match\\u2026</div>';
        } else {
          box.innerHTML = matches.map(t =>
            `<div class="typeahead-item" data-tid="${t.id}" data-lid="${t.league_id}"><span class="ta-name">${esc(t.name)}</span><span class="ta-league">${esc(t.league_name)}</span></div>`
          ).join('');
        }
        box.style.display = 'block';
      });

      box.addEventListener('click', e => {
        const item = e.target.closest('.typeahead-item[data-tid]');
        if (!item) return;
        box.style.display = 'none';
        input.value = '';
        pickSearchedTeam(item.dataset.tid, item.dataset.lid);
      });

      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          const first = box.querySelector('.typeahead-item[data-tid]');
          if (first) {
            box.style.display = 'none';
            input.value = '';
            pickSearchedTeam(first.dataset.tid, first.dataset.lid);
          }
        } else if (e.key === 'Escape') {
          box.style.display = 'none';
          input.blur();
        }
      });

      document.addEventListener('click', e => {
        if (!e.target.closest('.team-search')) box.style.display = 'none';
      });
    }

    // ---- Interaction polish: skeletons, fade-in, count-ups, pull-to-refresh, button press ----

    // Shimmering placeholder blocks (styled via .skeleton / .skeleton-card in CSS)
    function skeletonHtml(cards=3) {
      let html = '<div class="skeleton">';
      for (let i = 0; i < cards; i++) html += '<div class="skeleton-card"></div>';
      return html + '</div>';
    }

    // Accessibility post-pass on injected markup (th scope for screen readers)
    function a11yFix(root) {
      root.querySelectorAll('th:not([scope])').forEach(th => th.setAttribute('scope', 'col'));
    }

    // Swap #main content with a fade-in transition, then run number count-ups.
    function setMainHtml(html) {
      $main.classList.remove('fade-in');
      $main.innerHTML = html;
      void $main.offsetWidth; // force reflow so the CSS animation restarts
      $main.classList.add('fade-in');
      a11yFix($main);
      animateNumbers($main);
    }

    // Count-up animation for purely numeric values (skips "6-6-0", "W3", etc.)
    function animateNumbers(root) {
      root.querySelectorAll('.stat-box .num, .game-card .score').forEach(el => {
        if (el.dataset.counted) return;
        const m = el.textContent.trim().match(/^([+-]?)(\d+)$/);
        if (!m) return; // non-numeric: leave untouched
        el.dataset.counted = '1';
        const sign = m[1], target = parseInt(m[2], 10), dur = 400;
        const t0 = performance.now();
        (function frame(t) {
          const p = Math.min((t - t0) / dur, 1);
          const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
          el.textContent = sign + Math.round(target * eased);
          if (p < 1) requestAnimationFrame(frame);
        })(t0);
      });
    }

    // Button press micro-interaction (.btn-press toggle, not just CSS :active)
    document.addEventListener('pointerdown', e => {
      const btn = e.target.closest && e.target.closest('button');
      if (btn) btn.classList.add('btn-press');
    });
    ['pointerup', 'pointercancel'].forEach(evt =>
      document.addEventListener(evt, () => {
        document.querySelectorAll('.btn-press').forEach(b => b.classList.remove('btn-press'));
      })
    );

    // Pull-to-refresh on mobile: drag down from top of #main while scrolled to top
    const PTR_THRESHOLD = 70;
    let ptrStartY = null, ptrDelta = 0, ptrBusy = false;
    const ptrHint = document.createElement('div');
    ptrHint.className = 'ptr-hint';
    ptrHint.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:99;display:none;align-items:center;justify-content:center;padding:8px 14px;border-radius:999px;background:var(--card,rgba(0,0,0,.55));pointer-events:none;transition:opacity .15s;opacity:0';
    ptrHint.appendChild(Object.assign(document.createElement('span'), { className: 'spinner' }));
    document.body.appendChild(ptrHint);

    function ptrShow(delta) {
      ptrHint.style.display = 'flex';
      ptrHint.style.opacity = delta >= PTR_THRESHOLD ? '1' : String(Math.min(delta / PTR_THRESHOLD, 1) * 0.7);
    }
    function ptrHide() {
      ptrHint.style.opacity = '0';
      setTimeout(() => { if (ptrStartY === null && !ptrBusy) ptrHint.style.display = 'none'; }, 180);
    }

    $main.addEventListener('touchstart', e => {
      if (e.touches.length !== 1 || ptrBusy) return;
      if ($main.scrollTop > 0 || window.scrollY > 0) return;
      ptrStartY = e.touches[0].clientY;
      ptrDelta = 0;
    }, { passive: true });

    $main.addEventListener('touchmove', e => {
      if (ptrStartY === null) return;
      ptrDelta = e.touches[0].clientY - ptrStartY;
      if (ptrDelta > 10 && $main.scrollTop <= 0 && window.scrollY <= 0) {
        ptrShow(ptrDelta);
      } else if (ptrDelta <= 0) {
        ptrStartY = null;
        ptrHide();
      }
    }, { passive: true });

    $main.addEventListener('touchend', () => {
      if (ptrStartY === null) return;
      const delta = ptrDelta;
      ptrStartY = null;
      ptrDelta = 0;
      if (delta >= PTR_THRESHOLD && !ptrBusy) {
        ptrBusy = true;
        ptrHint.style.opacity = '1';
        Promise.resolve(refreshAll()).finally(() => { ptrBusy = false; ptrHide(); });
      } else {
        ptrHide();
      }
    }, { passive: true });

    async function api(path, refresh=false) {
      const cacheKey = path.split('?')[0];
      if (!refresh && state.cache[cacheKey]) return state.cache[cacheKey];
      try {
        const bust = (refresh || path.indexOf('/api/today') === 0)
          ? (path.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now()
          : '';
        const res = await fetch(path + bust, { cache: 'no-store' });
        const data = await res.json();
        if (res.ok) state.cache[cacheKey] = data;
        return data;
      } catch (e) {
        return { error: 'Network error. Try Refresh.' };
      }
    }

    async function refreshAll() {
      $refresh.disabled = true;
      $refresh.textContent = '';
      $refresh.appendChild(Object.assign(document.createElement('span'), { className: 'spinner' }));
      // Light scope: clears page caches so scores/sheets refetch, keeps big aggregates warm
      await fetch('/api/refresh?scope=scores', { method: 'POST' });
      state.cache = {};
      state._sessions = null;
      state.allTeams = [];
      state.allPlayers = [];
      await loadActiveTab(true);
      $refresh.innerHTML = 'Refresh';
      $refresh.disabled = false;
      const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      showToast(`Updated ${t}`);
    }

    // ---- Live game polling ----
    // Prefer server status (ET). Fallback uses a tight beer-league window so
    // finished games never linger as LIVE (~85 min with a score, 100 min hard).
    function gameLiveState(g) {
      if (g.status === 'live' || g.status === 'final' || g.status === 'upcoming') return g.status;
      const m = (g.time || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (!m) return g.played ? 'final' : 'upcoming';
      let hh = parseInt(m[1], 10) % 12;
      if (m[3].toUpperCase() === 'PM') hh += 12;
      const start = new Date();
      start.setHours(hh, parseInt(m[2], 10), 0, 0);
      const now = new Date();
      const scored = g.played && g.home_score != null;
      const mins = (now - start) / 60000;
      if (mins < -10) return 'upcoming';
      if (mins >= 100) return 'final';
      if (scored && mins >= 85) return 'final';
      return 'live';
    }

    function isLiveGame(g) { return gameLiveState(g) === 'live'; }
    function hasPostedScore(g) {
      return !!(g.played && g.home_score != null && g.away_score != null);
    }
    // ChillerStats lists some practice/scrimmage ice slots with literal names
    // like "Team Blue vs Team Red". Real rosters don't exist behind those, so
    // render them as muted non-links so they don't look like a data bug.
    function isScrimmageTeam(n) {
      return /^team\\s+(blue|red|white|black|grey|gray|gold|green|navy|silver|teal|orange|yellow|purple|home|away)$/i.test((n || '').trim());
    }
    function isScrimmageGame(g) {
      return isScrimmageTeam(g.home) && isScrimmageTeam(g.away);
    }

    let livePollTimer = null;
    let livePollInFlight = false;
    async function tickLiveScores() {
      if (livePollInFlight || document.hidden) return;
      livePollInFlight = true;
      try {
        delete state.cache['/api/today/scores'];
        await loadTodayScores(true);
      } catch (e) { /* next tick retries */ }
      livePollInFlight = false;
    }
    function syncLivePolling(games) {
      const anyLive = (games || []).some(isLiveGame);
      document.body.classList.toggle('has-live', anyLive);
      if (livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; }
      if (!anyLive) return;
      // Do not POST /api/refresh here — that wipes the instance cache and is
      // unreliable across Vercel isolates. Scores path fetches dashboards fresh.
      livePollTimer = setInterval(tickLiveScores, 20000);
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && (state.todayGames || []).some(isLiveGame)) tickLiveScores();
    });

    function setTab(tab) {
      state.tab = tab;
      navLinks.forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
      loadActiveTab();
      $main.focus({ preventScroll: true }); // move keyboard focus into content on tab switch
    }

    async function loadActiveTab(refresh=false) {
      $main.innerHTML = skeletonHtml(4);
      try {
        if (state.tab === 'today') await renderToday(refresh);
        if (state.tab === 'league') await renderLeague(refresh);
        if (state.tab === 'team') await renderTeam(refresh);
        if (state.tab === 'players') await renderPlayers(refresh);
        if (state.tab === 'analytics') await renderAnalytics(refresh);
      } catch (e) {
        $main.innerHTML = `<div class="error">Error loading tab: ${e.message}</div>`;
      }
    }

    function gameHtml(g, showScore=false) {
      const hasScore = g.home_final !== undefined && g.home_final !== null && (g.home_score !== undefined ? g.home_score || g.away_score : g.home_final);
      const home = g.home || g.home_name;
      const away = g.away || g.away_name;
      const homeId = g.home_id;
      const awayId = g.away_id;
      const score = g.home_score !== undefined ? `${g.home_score} - ${g.away_score}` : `${g.home_final} - ${g.away_final}`;
      const played = g.played || (g.home_final !== undefined);
      const now = new Date();
      // Very rough "live" guess: if today and time within the last 3h
      const timeStr = (g.time || '').replace(/\s+/g, '');
      let live = false;
      // Only games dated today can be live — future sessions must never show LIVE
      const isToday = !g.date || (() => {
        const dt = parseGameDate(g.date);
        return dt && dateKey(dt) === dateKey(now);
      })();
      if (isToday && played && !g.home_score && !g.away_score && timeStr) {
        const [h, m] = timeStr.match(/(\d+):(\d+)/)?.slice(1) || [];
        const ampm = timeStr.toLowerCase().includes('pm');
        if (h) {
          let hh = parseInt(h);
          if (ampm && hh !== 12) hh += 12;
          const gameTime = new Date();
          gameTime.setHours(hh, parseInt(m) || 0, 0);
          live = Math.abs(now - gameTime) < 3 * 60 * 60 * 1000;
        }
      }
      return `
        <div class="game-card" data-game='${JSON.stringify({homeId, awayId}).replace(/'/g, "&#39;")}'>
          <div class="meta">
            <span>${esc(g.date || 'Today')} ${fmtTime(g.time)} ${g.facility ? '· ' + esc(g.facility) : ''}</span>
            ${(played || (g.home_score !== undefined && g.home_score !== null)) ? '<span class="score">' + score + '</span>' : (live ? '<span class="live">Live</span>' : '')}
          </div>
          <div class="matchup">
            <div class="team link" data-team="${homeId || ''}" onclick="selectTeam('${homeId || ''}')">${esc(home)}</div>
            <span class="vs">vs</span>
            <div class="team link" data-team="${awayId || ''}" onclick="selectTeam('${awayId || ''}')">${esc(away)}</div>
          </div>
        </div>
      `;
    }

    // Hockey scoreboard: stacked (mobile glance) + row (desktop columns).
    function scoreboardHtml(games) {
      const active = (games || []).filter(isLiveGame);
      if (!active.length) return '';
      let html = '<div class="card scoreboard"><h2><span class="live-dot-inline" aria-hidden="true"></span>Live Now</h2>';
      html += '<div class="sb-list">' + active.map(g => {
        const scored = hasPostedScore(g);
        const hs = scored ? g.home_score : '';
        const as_ = scored ? g.away_score : '';
        const rink = (g.facility || '').replace(/^Chiller\s+/i, '');
        // Scrimmage slots have no real rosters behind them — muted, non-clickable
        if (isScrimmageGame(g)) {
          return `<article class="sb-card" data-status="live" data-scrim="1">
            <div class="sb-status"><span class="sb-live">LIVE</span><span class="sb-meta">${fmtTime(g.time)}${rink ? ' · ' + esc(rink) : ''}</span></div>
            <div class="sb-side"><span class="sb-name">${esc(g.home)}</span><span class="sb-num">${hs === '' ? '–' : hs}</span></div>
            <div class="sb-side"><span class="sb-name">${esc(g.away)}</span><span class="sb-num">${as_ === '' ? '–' : as_}</span></div>
          </article>`;
        }
        return `<article class="sb-card" data-status="live">
          <div class="sb-status"><span class="sb-live">LIVE</span><span class="sb-meta">${fmtTime(g.time)}${rink ? ' · ' + esc(rink) : ''}</span></div>
          <div class="sb-side link" onclick="selectTeam('${g.home_id || ''}')"><span class="sb-name">${esc(g.home)}</span><span class="sb-num">${hs === '' ? '–' : hs}</span></div>
          <div class="sb-side link" onclick="selectTeam('${g.away_id || ''}')"><span class="sb-name">${esc(g.away)}</span><span class="sb-num">${as_ === '' ? '–' : as_}</span></div>
        </article>`;
      }).join('') + '</div>';
      html += '<div class="picker-hint">Scores refresh about every 20s while a game is live</div></div>';
      return html;
    }

    function todayRowHtml(g) {
      const rink = (g.facility || '').replace(/^Chiller\s+/i, '');
      const hasScore = hasPostedScore(g);
      const st = gameLiveState(g);
      const stLabel = st === 'live' ? 'LIVE' : st === 'final' ? 'FINAL' : 'UPCOMING';
      const scrim = isScrimmageGame(g);
      let scoreInner;
      if (hasScore) {
        scoreInner = `<span class="t-score">${g.home_score}\u2013${g.away_score}</span>`;
      } else if (st === 'live') {
        scoreInner = '<span class="t-score live-badge">LIVE</span>';
      } else {
        scoreInner = scrim ? '<span class="t-score t-score-empty">scrim</span>' : '<span class="t-score t-score-empty">vs</span>';
      }
      const homeCell = scrim
        ? `<span class="t-home scrim">${esc(g.home)}</span>`
        : `<span class="t-home link" onclick="selectTeam('${g.home_id || ''}')">${esc(g.home)}</span>`;
      const awayCell = scrim
        ? `<span class="t-away scrim">${esc(g.away)}</span>`
        : `<span class="t-away link" onclick="selectTeam('${g.away_id || ''}')">${esc(g.away)}</span>`;
      return `<div class="today-row" data-status="${st}"${scrim ? ' data-scrim="1"' : ''}>
        <span class="t-time">${fmtTime(g.time)}</span>
        ${homeCell}
        <span class="t-board">${scoreInner}<span class="status-chip status-${st}">${stLabel}</span></span>
        ${awayCell}
        <span class="t-rink">${esc(rink)}</span>
      </div>`;
    }

    function todayPageHtml(data) {
      let html = '<p class="board-howto">Today is the scoreboard. Live games sit up top. Tap a team for roster &amp; schedule. League / Team / Players / Analytics are in the bar.</p>';
      if (state.myTeam) {
        html += '<div class="card hero-card" id="myTeamHero"><div class="empty">Loading your team\u2026</div></div>';
      } else {
        html += '<div class="card hero-card hero-cta"><div class="hero-cta-text">Set your team to pin next game, last result, and record here</div>'
          + '<button class="small" onclick="setTab(\'team\')">Pick My Team</button></div>';
      }

      const liveNow = state.todayGames.filter(isLiveGame);
      const finals = state.todayGames.filter(g => gameLiveState(g) === 'final');
      const upcoming = state.todayGames.filter(g => gameLiveState(g) === 'upcoming');
      if (liveNow.length) html += scoreboardHtml(liveNow);
      if (!state.todayGames.length) {
        html += '<div class="card today-card"><h2>Today\'s Games</h2><div class="empty">No games posted yet.</div></div>';
      } else {
        if (finals.length) {
          html += '<div class="card today-card"><h2>Final</h2>'
            + '<div class="today-list today-list-cols"><div class="today-cols-head"><span>Time</span><span>Home</span><span>Score</span><span>Away</span><span>Rink</span></div>' + finals.map(todayRowHtml).join('') + '</div></div>';
        }
        if (upcoming.length) {
          html += '<div class="card today-card"><h2>Upcoming</h2>'
            + '<div class="today-list today-list-cols"><div class="today-cols-head"><span>Time</span><span>Home</span><span>Score</span><span>Away</span><span>Rink</span></div>' + upcoming.map(todayRowHtml).join('') + '</div></div>';
        }
      }
      return html;
    }

    // Fill scores from the separate (slower) scores endpoint and re-render.
    async function loadTodayScores(force=false) {
      const data = await api('/api/today/scores', force);
      if (data.error || !data.games) return;
      const byIds = {};
      data.games.forEach(g => { byIds[`${g.home_id}|${g.away_id}`] = g; });
      state.todayGames.forEach(g => {
        const s = byIds[`${g.home_id}|${g.away_id}`];
        if (!s) return;
        if (s.status) g.status = s.status;
        if (s.is_final) g.is_final = true;
        if (s.played) {
          g.home_score = s.home_score;
          g.away_score = s.away_score;
          g.home_periods = s.home_periods;
          g.away_periods = s.away_periods;
          g.played = true;
        }
      });
      syncLivePolling(state.todayGames);
      if (state.tab === 'today') {
        setMainHtml(todayPageHtml());
        if (state.myTeam) loadMyTeamHero(state.myTeam, false);
      }
    }

    async function renderToday(refresh) {
      const data = await api('/api/today', refresh);
      if (data.error) { $main.innerHTML = `<div class="error">${data.error}</div>`; return; }
      state.leagues = data.leagues;
      state.todayGames = data.today;
      syncLivePolling(state.todayGames);
      setMainHtml(todayPageHtml());
      loadTodayScores(refresh); // async — scores fill in after first paint

      if (state.myTeam) loadMyTeamHero(state.myTeam, refresh);
    }

    async function loadMyTeamHero(teamId, refresh=false) {
      const el = document.getElementById('myTeamHero');
      if (!el) return;
      const data = await api(`/api/team/${teamId}`, refresh);
      if (data.error) { el.remove(); return; }

      const over = data.overview, form = data.form || {};
      const standings = data.standings || [];
      const rankIdx = standings.findIndex(s => s.team_id === teamId);
      const rank = rankIdx >= 0 ? rankIdx + 1 : 0;
      const total = standings.length;

      let inner = `<div class="hero-top"><span class="hero-team link" onclick="setTab('team')">${esc(over.team_name)}</span>`;
      if (form.played) inner += `<span class="hero-record">${form.record}${form.streak ? ' · ' + form.streak : ''}</span>`;
      if (rank) inner += `<span class="hero-rank">${rank}${rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th'} of ${total}</span>`;
      inner += '</div>';

      if (over.recent_result) {
        const r = over.recent_result;
        const isHome = r.home_id === teamId;
        const us = isHome ? r.home_final : r.away_final;
        const them = isHome ? r.away_final : r.home_final;
        const res = us > them ? 'w' : (us < them ? 'l' : 't');
        inner += `<div class="hero-line"><span class="hero-label">Last</span><span class="form-chip ${res}" aria-label="${chipLabel(res)}">${res.toUpperCase()}</span> <b>${us}\u2013${them}</b> ${isHome ? 'vs' : '@'} ${esc(isHome ? r.away : r.home)}</div>`;
      }
      if (over.next_game) {
        const ng = over.next_game;
        inner += `<div class="hero-line"><span class="hero-label">Next</span> <b>${esc(ng.date || 'TBD')}</b> ${fmtTime(ng.time)} \u00b7 ${esc(ng.facility || 'TBD')} \u00b7 ${ng.home_away === 'Home' ? 'vs' : '@'} ${esc(ng.opponent)}</div>`;
      }
      el.innerHTML = inner;
    }

    async function renderLeague(refresh) {
      if (!state.leagues.length) {
        const home = await api('/api/today');
        state.leagues = home.leagues || [];
      }
      let html = '<div class="card">';
      html += '<h2>League / Scores</h2>';
      html += pickerHtml();
      html += '<div id="leagueContent"></div></div>';
      setMainHtml(html);

      if (state.leagueId) await loadLeagueContent(state.leagueId, refresh);
    }

    function playoffsHtml(playoffs) {
      let html = '';
      playoffs.forEach(r => {
        html += `<div class="card cmp-card"><h3>${esc(r.round)}</h3>`;
        r.games.forEach(g => {
          const homeW = g.played && g.home_score > g.away_score;
          const awayW = g.played && g.away_score > g.home_score;
          const mine = state.teamId && (g.home_id === state.teamId || g.away_id === state.teamId);
          html += `<div class="po-game${mine ? ' po-mine' : ''}">
            <div class="po-teams">
              <span class="po-team ${homeW ? 'po-win' : ''} ${g.home_id ? 'link' : 'po-tbd'}" ${g.home_id ? `onclick="selectTeam('${g.home_id}')"` : ''}>${esc(g.home)}</span>
              ${g.played ? `<span class="po-score">${g.home_score}\u2013${g.away_score}</span>` : '<span class="t-vs">vs</span>'}
              <span class="po-team ${awayW ? 'po-win' : ''} ${g.away_id ? 'link' : 'po-tbd'}" ${g.away_id ? `onclick="selectTeam('${g.away_id}')"` : ''}>${esc(g.away)}</span>
            </div>
            <div class="meta">${esc(g.date)} \u00b7 ${fmtTime(g.time)}${g.facility ? ' \u00b7 ' + esc(g.facility) : ''}</div>
          </div>`;
        });
        html += '</div>';
      });
      return html;
    }

    async function loadLeagueContent(leagueId, refresh=false) {
      const $content = $('#leagueContent');
      $content.innerHTML = skeletonHtml(3);
      const data = await api(`/api/league/${leagueId}`, refresh);
      if (data.error) { $content.innerHTML = `<div class="error">${data.error}</div>`; return; }

      // build team list from standings for the team tab
      state.teams = data.standings.map(s => ({ id: s.team_id, name: s.team })).filter(t => t.id);
      state.teamsLeague = leagueId;
      // Note: the saved team (state.teamId) persists even when browsing other leagues.

      // Reset sessions/calendar/compare state when the league changes
      if (state._sessions && state._sessions.leagueId !== leagueId) {
        state._sessions = null;
        state.sessionDate = '';
        state.calMonth = '';
        state.calDay = '';
      }
      if (state._cmpLeague !== leagueId) {
        state.cmpA = '';
        state.cmpB = '';
        state._cmpLeague = leagueId;
      }

      let html = `<h3 style="margin:18px 0 10px;color:var(--text)">${data.league_name} <span style="color:var(--muted);font-weight:400">${data.season}</span></h3>`;

      html += '<div class="pill-row">';
      const sections = [
        { key: 'Scores', label: 'Scores' },
        ...(data.playoffs && data.playoffs.length ? [{ key: 'Playoffs', label: 'Playoffs' }] : []),
        { key: 'Standings', label: 'Standings' },
        { key: 'Leaders', label: 'Leaders' },
        { key: 'Sessions', label: 'Game Nights' },
        { key: 'Calendar', label: 'Calendar' },
        { key: 'Compare', label: 'Compare' },
      ];
      const active = localStorage.getItem('cahl-league-section') || 'Scores';
      sections.forEach(s => html += `<span class="pill ${s.key===active?'active':''}" data-sec="${s.key}" tabindex="0" role="button">${s.label}</span>`);
      html += '</div>';

      if (data.playoffs && data.playoffs.length) {
        html += '<div id="leagueSecPlayoffs" class="league-sec" style="display:'+(active==='Playoffs'?'block':'none')+'">';
        html += playoffsHtml(data.playoffs);
        html += '</div>';
      }
      html += '<div id="leagueSecScores" class="league-sec" style="display:'+(active==='Scores'?'block':'none')+'">';
      html += '<h3>Latest Scores</h3>';
      if (!data.recent.length) html += '<div class="empty">No recent scores yet.</div>';
      html += '<div class="games-grid">' + data.recent.map(g => gameHtml(g)).join('') + '</div>';
      html += '<h3 style="margin-top:18px">Upcoming</h3>';
      if (!data.upcoming.length) html += '<div class="empty">No upcoming games.</div>';
      html += '<div class="games-grid">' + data.upcoming.map(g => gameHtml(g)).join('') + '</div>';
      html += '</div>';

      html += '<div id="leagueSecStandings" class="league-sec" style="display:'+(active==='Standings'?'block':'none')+'">';
      const st2 = state.standingsSort;
      html += '<table><thead><tr>'
        + sortTh('team', 'Team', st2, 'standings')
        + sortTh('gp', 'GP', st2, 'standings', true)
        + sortTh('w', 'W', st2, 'standings', true)
        + sortTh('l', 'L', st2, 'standings', true)
        + sortTh('otl', 'OTL', st2, 'standings', true)
        + sortTh('pts', 'PTS', st2, 'standings', true)
        + sortTh('gf', 'GF', st2, 'standings', true)
        + sortTh('ga', 'GA', st2, 'standings', true)
        + '</tr></thead><tbody>';
      html += sortRows(data.standings, st2.key, st2.dir, STANDINGS_VAL).map(s => `
        <tr class="link" onclick="selectTeam('${s.team_id}')">
          <td><span class="link">${esc(s.team)}</span></td>
          <td class="num">${s.gp}</td><td class="num">${s.w}</td><td class="num">${s.l}</td><td class="num">${s.otl}</td>
          <td class="num">${s.pts}</td><td class="num">${s.gf}</td><td class="num">${s.ga}</td>
        </tr>`).join('');
      html += '</tbody></table></div>';

      html += '<div id="leagueSecLeaders" class="league-sec" style="display:'+(active==='Leaders'?'block':'none')+'">';
      html += '<h3>Points</h3><table><thead><tr><th>Player</th><th>Team</th><th class="num">Pts</th></tr></thead><tbody>';
      html += data.leaders.points.map(p => `<tr onclick="selectPlayer('${p.team_id}','${p.player_id}')" class="link"><td><span class="link">${p.name}</span></td><td>${p.team}</td><td class="num">${p.value}</td></tr>`).join('');
      html += '</tbody></table>';
      html += '<h3 style="margin-top:14px">Goals</h3><table><thead><tr><th>Player</th><th>Team</th><th class="num">G</th></tr></thead><tbody>';
      html += data.leaders.goals.map(p => `<tr onclick="selectPlayer('${p.team_id}','${p.player_id}')" class="link"><td><span class="link">${p.name}</span></td><td>${p.team}</td><td class="num">${p.value}</td></tr>`).join('');
      html += '</tbody></table>';
      html += '<h3 style="margin-top:14px">Assists</h3><table><thead><tr><th>Player</th><th>Team</th><th class="num">A</th></tr></thead><tbody>';
      html += data.leaders.assists.map(p => `<tr onclick="selectPlayer('${p.team_id}','${p.player_id}')" class="link"><td><span class="link">${p.name}</span></td><td>${p.team}</td><td class="num">${p.value}</td></tr>`).join('');
      html += '</tbody></table>';
      html += '</div>';

      // Sessions: every game night of the season, pick one to view all scores
      html += '<div id="leagueSecSessions" class="league-sec" style="display:'+(active==='Sessions'?'block':'none')+'">';
      html += '<div class="empty">All game nights for the season…</div>';
      html += '</div>';

      // Calendar: month grid of game nights with result markers
      html += '<div id="leagueSecCalendar" class="league-sec" style="display:'+(active==='Calendar'?'block':'none')+'">';
      html += '<div class="empty">Season calendar…</div>';
      html += '</div>';

      // Compare: team vs team head-to-head + tale of the tape
      html += '<div id="leagueSecCompare" class="league-sec" style="display:'+(active==='Compare'?'block':'none')+'">';
      html += '<div class="empty">Pick two teams to compare…</div>';
      html += '</div>';

      $content.innerHTML = html;
      a11yFix($content);
      animateNumbers($content);

      if (active === 'Sessions') loadLeagueSessions(leagueId);
      if (active === 'Calendar') loadLeagueCalendar(leagueId);
      if (active === 'Compare') loadLeagueCompare(leagueId);
      // section pill clicks are handled by the delegated $main handler
    }

    async function ensureSessions(leagueId, force=false) {
      if (state._sessions && state._sessions.leagueId === leagueId && !force) return state._sessions;
      const data = await api(`/api/sessions/${leagueId}`, force);
      if (data.error) throw new Error(data.error);
      state._sessions = { leagueId, sessions: data.sessions, season: data.season };
      return state._sessions;
    }

    async function loadLeagueSessions(leagueId, force=false) {
      const $sec = $('#leagueSecSessions');
      if (!$sec) return;
      if (state._sessions && state._sessions.leagueId === leagueId && !force) {
        renderSessionsSection();
        return;
      }
      $sec.innerHTML = skeletonHtml(3);
      try {
        const pack = await ensureSessions(leagueId, force);
        if (!state.sessionDate) {
          // Default to the most recent night with final scores, else the last night
          const played = pack.sessions.filter(s => s.games.some(g => g.played));
          const fallback = played.length ? played[played.length - 1] : pack.sessions[pack.sessions.length - 1];
          state.sessionDate = fallback ? fallback.date : '';
        }
        renderSessionsSection();
      } catch (e) {
        $sec.innerHTML = `<div class="error">${e.message}</div>`;
      }
    }

    function renderSessionsSection() {
      const $sec = $('#leagueSecSessions');
      const pack = state._sessions;
      if (!$sec || !pack) return;
      const sessions = pack.sessions || [];
      if (!sessions.length) { $sec.innerHTML = '<div class="empty">No games found.</div>'; return; }

      const sel = sessions.some(s => s.date === state.sessionDate)
        ? state.sessionDate
        : sessions[sessions.length - 1].date;
      state.sessionDate = sel;

      // Date pills, most recent night first
      let html = '<div class="picker-days session-dates">';
      [...sessions].reverse().forEach(s => {
        const finals = s.games.filter(g => g.played).length;
        html += `<span class="pill date-pill ${s.date === sel ? 'active' : ''}" data-session="${s.date}" tabindex="0" role="button">${esc(s.date)}<span class="pill-count">${finals}/${s.games.length}</span></span>`;
      });
      html += '</div>';

      const cur = sessions.find(s => s.date === sel);
      const finals = cur.games.filter(g => g.played).length;
      html += `<div class="picker-hint">${cur.games.length} games · ${finals} final</div>`;
      html += '<div class="games-grid">' + cur.games.map(g => gameHtml(g)).join('') + '</div>';
      $sec.innerHTML = html;
      a11yFix($sec);
      animateNumbers($sec);
    }

    // ---- Season calendar (month grid over the sessions data) ----
    const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

    function parseGameDate(d) {
      // "May 13" -> Date; pick the year nearest to today (handles season/year boundaries)
      const now = new Date();
      let dt = new Date(`${d} ${now.getFullYear()}`);
      if (isNaN(dt)) return null;
      const diffDays = (dt - now) / 86400000;
      if (diffDays > 180) dt = new Date(`${d} ${now.getFullYear() - 1}`);
      else if (diffDays < -180) dt = new Date(`${d} ${now.getFullYear() + 1}`);
      return dt;
    }

    function dateKey(dt) {
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    }

    async function loadLeagueCalendar(leagueId, force=false) {
      const $sec = $('#leagueSecCalendar');
      if (!$sec) return;
      $sec.innerHTML = skeletonHtml(3);
      try {
        await ensureSessions(leagueId, force);
        if (!state.calMonth) {
          // Default to the month containing the most recent played night, else current month
          const played = state._sessions.sessions.filter(s => s.games.some(g => g.played));
          const ref = played.length ? played[played.length - 1] : state._sessions.sessions[state._sessions.sessions.length - 1];
          const dt = ref ? parseGameDate(ref.date) : null;
          const base = dt || new Date();
          state.calMonth = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}`;
        }
        renderCalendarSection();
      } catch (e) {
        $sec.innerHTML = `<div class="error">${e.message}</div>`;
      }
    }

    function renderCalendarSection() {
      const $sec = $('#leagueSecCalendar');
      const pack = state._sessions;
      if (!$sec || !pack) return;

      // Map dateKey -> { dateLabel, games }
      const byDay = {};
      pack.sessions.forEach(s => {
        const dt = parseGameDate(s.date);
        if (dt) byDay[dateKey(dt)] = s;
      });

      const [yy, mm] = state.calMonth.split('-').map(Number);
      const first = new Date(yy, mm - 1, 1);
      const daysInMonth = new Date(yy, mm, 0).getDate();
      const startDow = first.getDay(); // 0 = Sunday
      const todayKey = dateKey(new Date());

      let html = '<div class="cal-nav">'
        + '<button class="ghost small" data-cal-prev aria-label="Previous month">\u2039</button>'
        + `<span class="cal-title">${MONTH_NAMES[mm - 1]} ${yy}</span>`
        + '<span class="cal-nav-right">'
        + '<button class="ghost small" data-cal-today>Today</button>'
        + '<button class="ghost small" data-cal-next aria-label="Next month">\u203a</button>'
        + '</span>'
        + '</div>';

      html += '<div class="cal-grid">';
      ['S','M','T','W','T','F','S'].forEach(d => { html += `<span class="cal-dow">${d}</span>`; });
      for (let i = 0; i < startDow; i++) html += '<span class="cal-cell empty-cell"></span>';

      for (let day = 1; day <= daysInMonth; day++) {
        const key = `${yy}-${String(mm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const sess = byDay[key];
        let cellClass = 'cal-cell';
        if (key === todayKey) cellClass += ' today';
        let dots = '';
        if (sess) {
          cellClass += ' has-games';
          dots = '<span class="cal-dots">' + sess.games.map(g => {
            let cls = 'cal-dot';
            if (g.played && state.teamId && (g.home_id === state.teamId || g.away_id === state.teamId)) {
              const us = g.home_id === state.teamId ? g.home_score : g.away_score;
              const them = g.home_id === state.teamId ? g.away_score : g.home_score;
              cls += us > them ? ' w' : (us < them ? ' l' : ' t');
            } else if (g.played) {
              cls += ' played';
            } else {
              cls += ' upcoming';
            }
            return `<span class="${cls}"></span>`;
          }).join('') + '</span>';
        }
        html += `<span class="${cellClass}" ${sess ? `data-cal-day="${key}" tabindex="0" role="button" aria-label="${sess.date}: ${sess.games.length} games"` : ''}><span class="cal-num">${day}</span>${dots}</span>`;
      }
      html += '</div>';

      // Selected day's games
      const selKey = state.calDay && byDay[state.calDay] ? state.calDay : null;
      if (selKey) {
        const sess = byDay[selKey];
        const finals = sess.games.filter(g => g.played).length;
        html += `<div class="picker-hint" style="margin-top:12px">${sess.date} \u00b7 ${sess.games.length} games \u00b7 ${finals} final</div>`;
        html += '<div class="games-grid" style="margin-top:8px">' + sess.games.map(g => gameHtml(g)).join('') + '</div>';
      } else {
        html += '<div class="picker-hint" style="margin-top:12px">Tap a day with dots to see that night\u2019s scores. Dots are green/red for your team\u2019s W/L when a team is selected.</div>';
      }

      $sec.innerHTML = html;
      a11yFix($sec);
      animateNumbers($sec);
    }

    // ---- Team vs Team comparison ----
    async function loadLeagueCompare(leagueId) {
      const $sec = $('#leagueSecCompare');
      if (!$sec) return;

      if (!state.cmpA && state.teamId && state.teams.find(t => t.id === state.teamId)) state.cmpA = state.teamId;
      if (!state.cmpA && state.teams.length) state.cmpA = state.teams[0].id;
      if (!state.cmpB || state.cmpB === state.cmpA) {
        const other = state.teams.find(t => t.id !== state.cmpA);
        state.cmpB = other ? other.id : '';
      }

      let html = '<div class="cmp-picker">';
      html += `<select id="cmpA" aria-label="Team A">${state.teams.map(t => `<option value="${t.id}" ${t.id===state.cmpA?'selected':''}>${esc(t.name)}</option>`).join('')}</select>`;
      html += '<span class="t-vs">vs</span>';
      html += `<select id="cmpB" aria-label="Team B">${state.teams.map(t => `<option value="${t.id}" ${t.id===state.cmpB?'selected':''}>${esc(t.name)}</option>`).join('')}</select>`;
      html += '<button class="ghost small" id="cmpSwap" title="Swap teams" aria-label="Swap teams">\u21c4</button>';
      html += '</div><div id="cmpContent"></div>';
      $sec.innerHTML = html;

      $('#cmpA').onchange = e => { state.cmpA = e.target.value; renderComparison(); };
      $('#cmpB').onchange = e => { state.cmpB = e.target.value; renderComparison(); };
      $('#cmpSwap').onclick = () => { const t = state.cmpA; state.cmpA = state.cmpB; state.cmpB = t; loadLeagueCompare(leagueId); };

      await renderComparison();
    }

    function winProb(aS, bS) {
      // Fun logistic blend of points% and per-game goal diff
      const pa = (aS.pts || 0) / Math.max((aS.gp || 0) * 2, 1);
      const pb = (bS.pts || 0) / Math.max((bS.gp || 0) * 2, 1);
      const ga = ((aS.gf || 0) - (aS.ga || 0)) / Math.max(aS.gp || 1, 1);
      const gb = ((bS.gf || 0) - (bS.ga || 0)) / Math.max(bS.gp || 1, 1);
      const x = (pa - pb) * 2.2 + (ga - gb) * 0.35;
      return 1 / (1 + Math.exp(-x));
    }

    async function renderComparison() {
      const el = $('#cmpContent');
      if (!el) return;
      if (!state.cmpA || !state.cmpB || state.cmpA === state.cmpB) {
        el.innerHTML = '<div class="empty">Pick two different teams to compare.</div>';
        return;
      }
      el.innerHTML = skeletonHtml(3);
      const [a, b] = await Promise.all([api(`/api/team/${state.cmpA}`), api(`/api/team/${state.cmpB}`)]);
      if (a.error || b.error) { el.innerHTML = '<div class="error">Failed to load one of the teams.</div>'; return; }

      const aName = a.overview.team_name, bName = b.overview.team_name;
      const aS = a.standings.find(s => s.team_id === state.cmpA) || {};
      const bS = b.standings.find(s => s.team_id === state.cmpB) || {};
      const aRankIdx = a.standings.findIndex(s => s.team_id === state.cmpA);
      const bRankIdx = b.standings.findIndex(s => s.team_id === state.cmpB);
      const aRank = aRankIdx >= 0 ? aRankIdx + 1 : 0;
      const bRank = bRankIdx >= 0 ? bRankIdx + 1 : 0;
      const aForm = a.form || {}, bForm = b.form || {};

      // Head-to-head from A's schedule (meetings appear on both schedules)
      const todayK = dateKey(new Date());
      const meetings = a.schedule.filter(g => g.home_id === state.cmpB || g.away_id === state.cmpB);
      const past = meetings.filter(g => { const dt = parseGameDate(g.date); return dt && dateKey(dt) <= todayK && g.played; });
      const upcoming = meetings.filter(g => { const dt = parseGameDate(g.date); return dt && dateKey(dt) > todayK; });

      let aw = 0, bw = 0, ties = 0;
      past.forEach(g => {
        const us = g.home_id === state.cmpA ? g.home_score : g.away_score;
        const them = g.home_id === state.cmpA ? g.away_score : g.home_score;
        if (us > them) aw++; else if (us < them) bw++; else ties++;
      });

      let html = `<div class="cmp-title"><span class="cmp-team-a link" onclick="selectTeam('${state.cmpA}')">${esc(aName)}</span><span class="t-vs">vs</span><span class="cmp-team-b link" onclick="selectTeam('${state.cmpB}')">${esc(bName)}</span></div>`;

      // Head-to-head card
      html += '<div class="card cmp-card"><h3>Head to Head</h3>';
      if (past.length) {
        html += `<div class="cmp-h2h-record">${aw}\u2013${bw}${ties ? '\u2013' + ties : ''} <span class="picker-hint" style="display:inline;margin:0">this season</span></div>`;
        html += past.map(g => {
          const us = g.home_id === state.cmpA ? g.home_score : g.away_score;
          const them = g.home_id === state.cmpA ? g.away_score : g.home_score;
          const res = us > them ? 'w' : (us < them ? 'l' : 't');
          return `<div class="cmp-h2h-item"><span class="form-chip ${res}" aria-label="${chipLabel(res)}">${res.toUpperCase()}</span><span class="cmp-h2h-score">${us}\u2013${them}</span><span class="cmp-h2h-date">${esc(g.date)}${g.score_sheet ? ` <a class="link" href="${g.score_sheet}" target="_blank" rel="noopener" title="Score sheet">\u2197</a>` : ''}</span></div>`;
        }).join('');
      } else {
        html += '<div class="empty">No meetings yet this season.</div>';
      }
      if (upcoming.length) {
        const g = upcoming[0];
        html += `<div class="picker-hint" style="margin-top:8px">Next meeting: <b>${esc(g.date)}</b> ${fmtTime(g.time)} \u00b7 ${esc(g.facility || '')}</div>`;
      }
      html += '</div>';

      // Tale of the tape
      const rows = [
        { label: 'Rank', a: aRank ? `${aRank}${aRank===1?'st':aRank===2?'nd':aRank===3?'rd':'th'}` : '-', b: bRank ? `${bRank}${bRank===1?'st':bRank===2?'nd':bRank===3?'rd':'th'}` : '-', av: -aRank, bv: -bRank, better: 'high' },
        { label: 'Points', a: aS.pts ?? '-', b: bS.pts ?? '-', av: aS.pts ?? 0, bv: bS.pts ?? 0, better: 'high' },
        { label: 'Record', a: aForm.record || '-', b: bForm.record || '-', av: null, bv: null, better: null },
        { label: 'Pts %', a: aForm.played ? Math.round((aForm.pts_pct ?? aForm.win_pct) * 100) + '%' : '-', b: bForm.played ? Math.round((bForm.pts_pct ?? bForm.win_pct) * 100) + '%' : '-', av: aForm.pts_pct ?? aForm.win_pct ?? 0, bv: bForm.pts_pct ?? bForm.win_pct ?? 0, better: 'high' },
        { label: 'Goals For', a: aS.gf ?? '-', b: bS.gf ?? '-', av: aS.gf ?? 0, bv: bS.gf ?? 0, better: 'high' },
        { label: 'Goals Against', a: aS.ga ?? '-', b: bS.ga ?? '-', av: aS.ga ?? 0, bv: bS.ga ?? 0, better: 'low' },
        { label: 'Goal Diff', a: (aForm.goal_diff > 0 ? '+' : '') + (aForm.goal_diff ?? 0), b: (bForm.goal_diff > 0 ? '+' : '') + (bForm.goal_diff ?? 0), av: aForm.goal_diff ?? 0, bv: bForm.goal_diff ?? 0, better: 'high' },
        { label: 'Home', a: aForm.home_record || '-', b: bForm.home_record || '-', av: null, bv: null, better: null },
        { label: 'Away', a: aForm.away_record || '-', b: bForm.away_record || '-', av: null, bv: null, better: null },
        { label: 'Streak', a: aForm.streak || '-', b: bForm.streak || '-', av: null, bv: null, better: null },
      ];
      html += '<div class="card cmp-card"><h3>Tale of the Tape</h3><table class="tot"><thead><tr><th></th><th class="num cmp-team-a">' + esc(aName) + '</th><th class="num cmp-team-b">' + esc(bName) + '</th></tr></thead><tbody>';
      rows.forEach(r => {
        let aCls = '', bCls = '';
        if (r.better && r.av !== null && r.bv !== null && r.av !== r.bv) {
          const aWins = r.better === 'high' ? r.av > r.bv : r.av < r.bv;
          if (aWins) aCls = ' class="tot-win num"'; else bCls = ' class="tot-win num"';
        }
        html += `<tr><td>${r.label}</td><td class="num${aCls ? ' tot-win' : ''}">${r.a}</td><td class="num${bCls ? ' tot-win' : ''}">${r.b}</td></tr>`;
      });
      html += '</tbody></table></div>';

      // Fancied bar
      const p = winProb(aS, bS);
      const pctA = Math.round(p * 100), pctB = 100 - pctA;
      html += `<div class="card cmp-card"><h3>Fancied (for fun)</h3>
        <div class="prob-labels"><span class="cmp-team-a">${esc(aName)} ${pctA}%</span><span class="cmp-team-b">${pctB}% ${esc(bName)}</span></div>
        <div class="prob-bar"><div class="prob-a" style="width:${pctA}%"></div><div class="prob-b" style="width:${pctB}%"></div></div>
        <div class="picker-hint">Based on points % and goal differential — not science.</div>
      </div>`;

      // Top players + goalies side by side
      html += '<div class="cmp-grid">';
      html += '<div class="card cmp-card"><h3>Top Scorers \u00b7 ' + esc(aName) + '</h3><table><tbody>' +
        (a.overview.team_leaders.points || []).slice(0, 3).map(p => `<tr><td>${esc(p.name)}</td><td class="num">${p.points} pts</td></tr>`).join('') + '</tbody></table></div>';
      html += '<div class="card cmp-card"><h3>Top Scorers \u00b7 ' + esc(bName) + '</h3><table><tbody>' +
        (b.overview.team_leaders.points || []).slice(0, 3).map(p => `<tr><td>${esc(p.name)}</td><td class="num">${p.points} pts</td></tr>`).join('') + '</tbody></table></div>';
      const ga = (a.roster.goalies || [])[0], gb = (b.roster.goalies || [])[0];
      if (ga || gb) {
        html += '<div class="card cmp-card"><h3>Goalie \u00b7 ' + esc(aName) + '</h3>' +
          (ga ? `<table><tbody><tr><td>${esc(ga.name)}</td><td class="num">${ga.w}-${ga.l}-${ga.otl}</td><td class="num">${typeof ga.gaa === 'number' ? ga.gaa.toFixed(1) : ga.gaa} GAA</td></tr></tbody></table>` : '<div class="empty">No goalie stats</div>') + '</div>';
        html += '<div class="card cmp-card"><h3>Goalie \u00b7 ' + esc(bName) + '</h3>' +
          (gb ? `<table><tbody><tr><td>${esc(gb.name)}</td><td class="num">${gb.w}-${gb.l}-${gb.otl}</td><td class="num">${typeof gb.gaa === 'number' ? gb.gaa.toFixed(1) : gb.gaa} GAA</td></tr></tbody></table>` : '<div class="empty">No goalie stats</div>') + '</div>';
      }
      html += '</div>';

      el.innerHTML = html;
      a11yFix(el);
      animateNumbers(el);
    }

    async function renderTeam(refresh) {
      if (!state.leagues.length) {
        const home = await api('/api/today');
        state.leagues = home.leagues || [];
      }

      let html = '<div class="card"><h2>My Team</h2>' + teamSearchHtml();

      if (state.leagueId) {
        // Refetch when the cached team list belongs to a different league
        if (!state.teams.length || state.teamsLeague !== state.leagueId) {
          const data = await api(`/api/league/${state.leagueId}`);
          state.teams = data.standings.map(s => ({ id: s.team_id, name: s.team })).filter(t => t.id);
          state.teamsLeague = state.leagueId;
        }
        html += changeLeagueHtml();
        html += '<select id="teamSelect"><option value="">Choose your team</option>';
        state.teams.forEach(t => html += `<option value="${t.id}" ${t.id === state.teamId ? 'selected' : ''}>${t.name}</option>`);
        html += '</select>';
        html += '<div id="teamContent"></div></div>';
        setMainHtml(html);
        // typeahead is delegated globally — no per-render binding needed
        $('#teamSelect').onchange = async (e) => {
          state.teamId = e.target.value;
          localStorage.setItem('cahl-team', state.teamId);
          setMyTeam(e.target.value); // "Choose your team" is the explicit default-team action
          await loadTeamContent(state.teamId);
        };
        if (state.teamId) await loadTeamContent(state.teamId, refresh);
      } else if (state.teamId) {
        // Team tapped from a game card but league unknown — show the team, offer picker to switch
        html += '<div id="teamContent"></div>';
        html += '<div class="picker-hint" style="margin-top:16px">Pick your league to switch teams:</div>' + pickerHtml() + '</div>';
        setMainHtml(html);
        // typeahead is delegated globally — no per-render binding needed
        await loadTeamContent(state.teamId, refresh);
      } else {
        html += '<div class="picker-hint" style="margin:-4px 0 10px">Pick a day, then your league</div>' + pickerHtml();
        html += '<div id="teamContent"></div></div>';
        setMainHtml(html);
        // typeahead is delegated globally — no per-render binding needed
      }
      loadAllTeams();
    }

    async function loadTeamContent(teamId, refresh=false) {
      const $content = $('#teamContent');
      $content.innerHTML = skeletonHtml(3);
      const data = await api(`/api/team/${teamId}`, refresh);
      if (data.error) { $content.innerHTML = `<div class="error">${data.error}</div>`; return; }

      const over = data.overview;
      const standings = data.standings || [];
      const rankIdx = standings.findIndex(s => s.team_id === teamId);
      const rank = rankIdx >= 0 ? rankIdx + 1 : 0;
      const rankSuffix = rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th';
      const icalUrl = `https://www.chillerstats.com/team/calendar_export.cfm?TeamID=${teamId}`;

      // Playoff-race badge from the magic-number calculator
      const raceBadge = (() => {
        const r = data.race;
        if (!r) return '';
        if (r.status === 'clinched') return '<span class="race-badge clinched">Clinched</span>';
        if (r.status === 'eliminated') return '<span class="race-badge eliminated">Eliminated</span>';
        if (r.status === 'playoffs') return '<span class="race-badge playoffs">Playoffs</span>';
        if (r.status === 'help') return '<span class="race-badge help">Needs help</span>';
        if (r.status === 'alive' && r.magic > 0) return `<span class="race-badge alive">Magic # ${r.magic}</span>`;
        return '';
      })();

      const myTeamBadge = state.myTeam === teamId
        ? '<span class="hero-rank my-team-star" title="Your saved team">\u2605 My Team</span>'
        : `<button class="ghost small" onclick="makeMyTeam('${teamId}')" title="Save as your default team">Set as My Team</button>`;

      let html = `<div class="team-head">
        <h3 style="color:var(--text);margin:0">${esc(over.team_name)}</h3>
        <div class="team-head-actions">
          ${myTeamBadge}
          ${raceBadge}
          ${rank ? `<span class="hero-rank">${rank}${rankSuffix} of ${standings.length}</span>` : ''}
          <a class="ghost small btn-link" href="${icalUrl}" target="_blank" rel="noopener" title="Subscribe to this team's schedule in your calendar">iCal</a>
          <button class="ghost small" onclick="shareTeamResult('${teamId}')" title="Copy last result to share">Share</button>
        </div>
      </div>`;

      if (data.playoffs && data.playoffs.length) {
        html += playoffsHtml(data.playoffs);
      }

      html += '<div id="teamAwardsMount"></div>';

      // Current session record (labeled from ChillerStats breadcrumb) + published awards only
      const form = data.form || {};
      const sessionLabel = (data.current_session && data.current_session.label) || data.season || '';
      const awards = data.awards || [];
      if (awards.length) {
        html += '<div class="award-row">';
        awards.forEach(a => {
          html += `<span class="award-badge" title="${esc(a.detail || '')}">${esc(a.title || 'Session award')}${a.session && a.session !== sessionLabel ? ' \u00b7 ' + esc(a.session) : ''}</span>`;
        });
        html += '</div>';
      }

      html += '<div class="card session-card" style="padding:12px 14px;margin:0 0 12px"><h3 style="margin-bottom:8px">Session records</h3>';
      if (form.played) {
        html += `<div class="picker-hint" style="margin:-4px 0 8px">${esc(sessionLabel || 'Current session')} \u2014 W-L-OTL from ChillerStats standings</div>`;
        const s = form.streak || '';
        const streakClass = s.startsWith('W') ? 'win' : (s.startsWith('L') ? 'loss' : (s.startsWith('O') ? 'otl' : 'tie'));
        html += `<div class="record-row">
          <div class="stat-box"><div class="num">${form.record}</div><div class="label">${esc(sessionLabel || 'Record')}</div></div>
          <div class="stat-box"><div class="num">${form.points ?? '-'}</div><div class="label">Points</div></div>
          <div class="stat-box"><div class="num">${form.home_record}</div><div class="label">Home</div></div>
          <div class="stat-box"><div class="num">${form.away_record}</div><div class="label">Away</div></div>
          <div class="stat-box"><div class="num">${form.goal_diff > 0 ? '+' + form.goal_diff : form.goal_diff}</div><div class="label">Goal Diff</div></div>
          <div class="stat-box"><div class="num"><span class="streak-badge ${streakClass}">${form.streak || '—'}</span></div><div class="label">Streak</div></div>
        </div>`;

        html += '<div class="form-chips-label">Last 5</div><div class="form-chips">' +
          (form.form || []).map(r => `<span class="form-chip ${r.toLowerCase()}" aria-label="${chipLabel(r.toLowerCase())}">${r}</span>`).join('') +
          '</div>';

        html += '<div class="form-chips-label">Season Timeline</div><div class="timeline">' +
          (form.timeline || []).map(t =>
            `<span class="tl-game ${t.result.toLowerCase()}" title="${esc(t.date)} ${t.location === 'H' ? 'vs' : '@'} ${esc(t.opponent)} (${t.score})">${t.result}</span>`
          ).join('') +
          '</div>';
      } else if (sessionLabel) {
        html += `<div class="picker-hint">${esc(sessionLabel)} \u2014 no games played yet, so no record to show.</div>`;
      }
      html += '</div>';

      if (over.next_game) {
        const ng = over.next_game;
        html += `<div class="game-card"><div class="meta">Next Game ${ng.home_away}</div><div class="matchup"><div class="team">${esc(over.team_name)}</div><span class="vs">vs</span><div class="team">${esc(ng.opponent)}</div></div><div class="meta">${esc(ng.date || 'TBD')} · ${fmtTime(ng.time)} · ${esc(ng.facility || 'TBD')}</div></div>`;
      }

      if (over.recent_result) {
        const r = over.recent_result;
        html += `<div class="game-card"><div class="meta">Recent Result</div><div class="matchup"><div class="team">${esc(r.home)}</div><span class="score">${r.home_final}-${r.away_final}</span><div class="team">${esc(r.away)}</div></div></div>`;
      }

      html += '<div id="teamHistoryMount"></div>';

      html += '<h3 style="margin-top:18px">Team Leaders</h3><div class="stat-grid">';
      const leaderKeys = ['points','goals','assists','pim'];
      const leaderLabels = {points:'Points', goals:'Goals', assists:'Assists', pim:'PIM'};
      leaderKeys.forEach(k => {
        const top = over.team_leaders[k][0];
        html += `<div class="stat-box"><div class="num">${top ? (top.points || top.goals || top.assists || top.pim || 0) : '-'}</div><div class="label">${leaderLabels[k]} ${top ? '· ' + esc(top.name) : ''}</div></div>`;
      });
      html += '</div>';

      html += '<h3 style="margin-top:18px">Standings</h3>';
      const st = state.standingsSort;
      html += '<table><thead><tr>'
        + sortTh('team', 'Team', st, 'standings')
        + sortTh('gp', 'GP', st, 'standings', true)
        + sortTh('w', 'W', st, 'standings', true)
        + sortTh('l', 'L', st, 'standings', true)
        + sortTh('otl', 'OTL', st, 'standings', true)
        + sortTh('pts', 'PTS', st, 'standings', true)
        + sortTh('gf', 'GF', st, 'standings', true)
        + sortTh('ga', 'GA', st, 'standings', true)
        + '</tr></thead><tbody>';
      html += sortRows(data.standings, st.key, st.dir, STANDINGS_VAL).map(s => `
        <tr ${s.team_id === teamId ? 'style="color:var(--accent);font-weight:700"' : ''}>
          <td>${esc(s.team)}</td><td class="num">${s.gp}</td><td class="num">${s.w}</td><td class="num">${s.l}</td><td class="num">${s.otl}</td>
          <td class="num">${s.pts}</td><td class="num">${s.gf}</td><td class="num">${s.ga}</td>
        </tr>`).join('');
      html += '</tbody></table>';

      html += '<h3 style="margin-top:18px">Schedule</h3>';
      html += '<table><thead><tr><th>Date</th><th>Time</th><th>Facility</th><th>Opponent</th><th class="num">Score</th><th class="num">Sheet</th></tr></thead><tbody>';
      html += data.schedule.map(g => {
        const isHome = g.home_id === teamId;
        const opp = isHome ? g.away : g.home;
        const oppId = isHome ? g.away_id : g.home_id;
        const score = g.played ? `${g.home_score}-${g.away_score}` : '';
        const sheet = g.score_sheet ? `<a class="link" href="${g.score_sheet}" target="_blank" rel="noopener" title="View official score sheet">\u2197</a>` : '';
        return `<tr><td>${esc(g.date)}</td><td>${fmtTime(g.time)}</td><td>${esc(g.facility)}</td><td class="link" onclick="selectTeam('${oppId || ''}')">${isHome ? 'vs ' : '@ '}${esc(opp)}</td><td class="num">${score}</td><td class="num">${sheet}</td></tr>`;
      }).join('');
      html += '</tbody></table>';

      // Full roster: position-grouped sections + goalies
      const roster = data.roster || { sections: [], goalies: [] };
      const totalPlayers = roster.sections.reduce((n, s) => n + s.players.length, 0) + roster.goalies.length;
      html += `<h3 style="margin-top:18px">Full Roster${totalPlayers ? ` <span style="color:var(--muted);font-weight:600">${totalPlayers}</span>` : ''}</h3>`;

      const rs = state.rosterSort;
      const skaterHead = '<table><thead><tr>'
        + sortTh('jersey', '#', rs, 'skaters')
        + sortTh('name', 'Player', rs, 'skaters')
        + sortTh('position', 'Pos', rs, 'skaters')
        + sortTh('gp', 'GP', rs, 'skaters', true)
        + sortTh('g', 'G', rs, 'skaters', true)
        + sortTh('a', 'A', rs, 'skaters', true)
        + sortTh('pts', 'Pts', rs, 'skaters', true)
        + sortTh('ppg', 'P/GP', rs, 'skaters', true)
        + sortTh('ggp', 'G/GP', rs, 'skaters', true)
        + sortTh('pim', 'PIM', rs, 'skaters', true)
        + '</tr></thead><tbody>';
      roster.sections.forEach(sec => {
        html += `<div class="form-chips-label">${esc(sec.label)}</div>`;
        html += skaterHead + sortRows(sec.players, rs.key, rs.dir, SKATER_VAL).map(p => `
          <tr class="link roster-player" data-token="${p.token || ''}" data-tid="${teamId}" data-tname="${esc(over.team_name)}" data-pname="${esc(p.name)}">
            <td>${esc(p.jersey || '-')}</td><td><span class="link">${esc(p.name)}</span></td><td>${esc(p.position || '-')}</td>
            <td class="num">${p.gp}</td><td class="num">${p.g}</td><td class="num">${p.a}</td><td class="num">${p.pts}</td>
            <td class="num">${p.gp ? (p.pts / p.gp).toFixed(2) : '-'}</td><td class="num">${p.gp ? (p.g / p.gp).toFixed(2) : '-'}</td><td class="num">${p.pim}</td>
          </tr>`).join('') + '</tbody></table>';
      });

      if (roster.goalies.length) {
        const gs = state.goalieSort;
        html += '<div class="form-chips-label">Goalies</div>';
        html += '<table><thead><tr>'
          + sortTh('jersey', '#', gs, 'goalies')
          + sortTh('name', 'Goalie', gs, 'goalies')
          + sortTh('gp', 'GP', gs, 'goalies', true)
          + sortTh('w', 'W', gs, 'goalies', true)
          + sortTh('l', 'L', gs, 'goalies', true)
          + sortTh('otl', 'OTL', gs, 'goalies', true)
          + sortTh('winpct', 'Win%', gs, 'goalies', true)
          + sortTh('ga', 'GA', gs, 'goalies', true)
          + sortTh('gaa', 'GAA', gs, 'goalies', true)
          + '</tr></thead><tbody>';
        html += sortRows(roster.goalies, gs.key, gs.dir, GOALIE_VAL).map(p => `
          <tr class="link roster-player" data-token="${p.token || ''}" data-tid="${teamId}" data-tname="${esc(over.team_name)}" data-pname="${esc(p.name)}">
            <td>${esc(p.jersey || '-')}</td><td><span class="link">${esc(p.name)}</span></td>
            <td class="num">${p.gp}</td><td class="num">${p.w}</td><td class="num">${p.l}</td><td class="num">${p.otl}</td>
            <td class="num">${p.gp ? Math.round((p.w / p.gp) * 100) + '%' : '-'}</td>
            <td class="num">${p.ga}</td><td class="num">${typeof p.gaa === 'number' ? p.gaa.toFixed(1) : p.gaa}</td>
          </tr>`).join('');
        html += '</tbody></table>';
      }

      $content.innerHTML = html;
      a11yFix($content);
      animateNumbers($content);
      fillTeamHistory(teamId);
    }

    function awardsHtml(awards) {
      if (!awards || !awards.length) {
        return '<div class="picker-hint award-empty">No session championship or 1st-place award published for this team.</div>';
      }
      let html = '<div class="award-row" role="list">';
      awards.forEach(a => {
        const champ = a.kind === 'champion';
        const title = a.title || (champ ? 'Session champion' : '1st place');
        const meta = [a.season, a.league].filter(Boolean).join(' \u00b7 ');
        html += `<span class="award-badge ${champ ? 'champ' : 'place'}" role="listitem" title="${esc(a.detail || a.score || '')}">${esc(title)}${meta ? ' \u00b7 ' + esc(meta) : ''}</span>`;
      });
      html += '</div>';
      return html;
    }

    function previousSessionsHtml(rows, empty) {
      let html = '<h3 style="margin-top:18px">Previous sessions</h3>';
      if (!rows || !rows.length) {
        html += '<div class="empty-history">' + (empty || 'No previous sessions on ChillerStats for this team.') + '</div>';
        return html;
      }
      html += '<table class="history-table"><thead><tr><th>Session</th><th>League</th><th class="num">GP</th><th class="num">W-L-OTL</th><th class="num">PTS</th><th class="num">GF</th><th class="num">GA</th><th>Finish</th></tr></thead><tbody>';
      html += rows.map(r => {
        const finish = r.champion ? 'Champion' : (r.first_place ? '1st' : (r.rank ? r.rank + (r.teams ? ' of ' + r.teams : '') : '—'));
        const po = r.playoff_record ? ` <span class="hist-po">Playoffs ${esc(r.playoff_record)}</span>` : '';
        return `<tr>
          <td>${esc(r.season)}</td><td>${esc(r.league)}</td>
          <td class="num">${r.gp}</td><td class="num">${esc(r.record)}</td>
          <td class="num">${r.pts}</td><td class="num">${r.gf}</td><td class="num">${r.ga}</td>
          <td>${finish}${po}</td>
        </tr>`;
      }).join('');
      html += '</tbody></table>';
      return html;
    }

    async function fillTeamHistory(teamId) {
      const $aw = document.getElementById('teamAwardsMount');
      const $hi = document.getElementById('teamHistoryMount');
      if ($hi) $hi.innerHTML = '<div class="hist-loading">Loading session history…</div>';
      try {
        const data = await api(`/api/team/${teamId}/history`);
        if ($aw) {
          $aw.innerHTML = awardsHtml(data.awards || []);
        }
        if ($hi) {
          if (data.error && !(data.previous && data.previous.length) && !(data.awards && data.awards.length)) {
            $hi.innerHTML = previousSessionsHtml([], 'Session history is unavailable right now.');
          } else {
            $hi.innerHTML = previousSessionsHtml(data.previous || [], data.partial ? 'Still gathering older sessions from ChillerStats…' : undefined);
          }
        }
      } catch (e) {
        if ($hi) $hi.innerHTML = previousSessionsHtml([], 'Session history is unavailable right now.');
      }
    }

    async function renderPlayers(refresh) {
      if (!state.leagues.length) {
        const home = await api('/api/today');
        state.leagues = home.leagues || [];
      }

      loadAllPlayers();

      // Player lookup at the very top — search any player, tap for all-time stats
      let html = '<div class="card player-lookup-card"><h2>Player Lookup</h2>' + playerSearchHtml()
        + '<div class="picker-hint">Search any player across all CAHL teams — tap a name for their all-time stats</div></div>';

      // Full sortable leaderboard with level filters
      html += leaderboardHtml();

      html += '<div class="card">';
      if (state.playersLeague) {
        html += `<h2>Player Leaders · ${currentPlayersLeagueName()}</h2>`;
      } else {
        html += '<h2>CAHL Player Leaders</h2>';
      }
      html += playersPickerHtml();

      if (state.playersLeague) {
        const data = await api(`/api/league/${state.playersLeague}`, refresh);
        if (data.error) { setMainHtml(html + `<div class="error">${data.error}</div></div>`); return; }
        html += leaderSection('Pts', data.leaders.points, 'value');
        html += leaderSection('G', data.leaders.goals, 'value');
        html += leaderSection('A', data.leaders.assists, 'value');
        html += leaderSection('PIM', data.leaders.pim, 'value');
        html += '</div>';
        setMainHtml(html);
        return;
      }

      const data = await api('/api/leaders', refresh);
      if (data.error) { setMainHtml(html + `<div class="error">${data.error}</div></div>`); return; }
      html += leaderSection('Pts', data.points, 'points');
      html += leaderSection('G', data.goals, 'goals');
      html += leaderSection('A', data.assists, 'assists');
      html += '</div>';
      setMainHtml(html);
    }

    // Unified player opener: career profile + game log when team context exists
    window.openPlayer = (opts) => {
      if (!opts) return;
      state.profileReturn = state.tab;
      state.profileCtx = {
        teamId: opts.teamId || '',
        teamName: opts.teamName || '',
        playerName: opts.playerName || '',
      };
      if (opts.token) renderPlayerProfile(null, null, opts.token);
      else if (opts.playerId && opts.teamId) renderPlayerProfile(opts.teamId, opts.playerId, null);
      else showToast('No profile link for that player');
    };

    async function renderPlayerProfile(teamId, playerId, token) {
      $main.innerHTML = skeletonHtml(3);
      const path = token ? `/api/player-token/${encodeURIComponent(token)}` : `/api/player/${teamId}/${playerId}`;
      const data = await api(path);
      if (data.error) { $main.innerHTML = `<div class="error">${data.error}</div>`; return; }

      let html = `<div class="card"><h2>${esc(data.name)}</h2>`;
      if (data.history.length) {
        const totals = data.history.reduce((acc, h) => {
          acc.gp += h.gp; acc.g += h.g; acc.a += h.a; acc.pts += h.pts; acc.pim += h.pim;
          acc.esg += h.esg || 0; acc.ppg += h.ppg || 0; acc.shg += h.shg || 0; acc.sog += h.sog || 0;
          return acc;
        }, { gp: 0, g: 0, a: 0, pts: 0, pim: 0, esg: 0, ppg: 0, shg: 0, sog: 0 });
        const pgp = totals.gp ? (totals.pts / totals.gp).toFixed(2) : '-';
        const shPct = totals.sog ? Math.round((totals.g / totals.sog) * 100) + '%' : '-';
        html += '<h3>All-Time Totals</h3><div class="stat-grid">' +
          `<div class="stat-box"><div class="num">${totals.gp}</div><div class="label">Games</div></div>` +
          `<div class="stat-box"><div class="num">${totals.g}</div><div class="label">Goals</div></div>` +
          `<div class="stat-box"><div class="num">${totals.a}</div><div class="label">Assists</div></div>` +
          `<div class="stat-box"><div class="num">${totals.pts}</div><div class="label">Points</div></div>` +
          `<div class="stat-box"><div class="num">${pgp}</div><div class="label">P/GP</div></div>` +
          `<div class="stat-box"><div class="num">${shPct}</div><div class="label">Shooting %</div></div>` +
          `<div class="stat-box"><div class="num">${totals.pim}</div><div class="label">PIM</div></div>` +
          `<div class="stat-box"><div class="num">${data.history.length}</div><div class="label">Seasons</div></div>` +
          '</div>';

        html += '<div class="form-chips-label">Special teams (all-time)</div><div class="stat-grid">' +
          `<div class="stat-box"><div class="num">${totals.esg}</div><div class="label">Even Strength</div></div>` +
          `<div class="stat-box"><div class="num">${totals.ppg}</div><div class="label">Power Play</div></div>` +
          `<div class="stat-box"><div class="num">${totals.shg}</div><div class="label">Short Handed</div></div>` +
          `<div class="stat-box"><div class="num">${totals.sog}</div><div class="label">Shots</div></div>` +
          '</div>';

        html += '<h3 style="margin-top:18px">Season by Season</h3>';
      }
      html += '<table><thead><tr><th>Season</th><th>League</th><th>Team</th><th class="num">GP</th><th class="num">G</th><th class="num">A</th><th class="num">Pts</th><th class="num">P/GP</th><th class="num">ESG</th><th class="num">PPG</th><th class="num">SHG</th><th class="num">SOG</th><th class="num">PIM</th></tr></thead><tbody>';
      html += data.history.map(h => `
        <tr><td>${esc(h.season)}</td><td>${esc(h.league)}</td><td>${esc(h.team)}</td>
        <td class="num">${h.gp}</td><td class="num">${h.g}</td><td class="num">${h.a}</td><td class="num">${h.pts}</td>
        <td class="num">${h.gp ? (h.pts / h.gp).toFixed(2) : '-'}</td>
        <td class="num">${h.esg || 0}</td><td class="num">${h.ppg || 0}</td><td class="num">${h.shg || 0}</td><td class="num">${h.sog || 0}</td><td class="num">${h.pim}</td></tr>`).join('');
      html += '</tbody></table></div>';
      const backTab = state.profileReturn || 'players';
      const backLabels = { today: 'Today', league: 'League', team: 'Team', players: 'Leaders', analytics: 'Analytics' };
      html += `<button class="ghost" onclick="setTab('${backTab}')">\u2190 Back to ${backLabels[backTab] || 'Leaders'}</button>`;
      setMainHtml(html);

      // Game log from official score sheets when we have team context
      const ctx = state.profileCtx || {};
      if (ctx.teamId && ctx.playerName && ctx.teamName) loadGameLogSection(ctx);
    }

    async function loadGameLogSection(ctx) {
      const data = await api(`/api/game-log/${ctx.teamId}?player=${encodeURIComponent(ctx.playerName)}&team=${encodeURIComponent(ctx.teamName)}`);
      if (data.error || !data.games || !data.games.length) return;

      const totals = data.games.reduce((a, g) => {
        a.g += g.g; a.a += g.a; a.pim += g.pim;
        return a;
      }, { g: 0, a: 0, pim: 0 });

      let html = '<div class="card"><h3>Game Log \u00b7 This Season</h3>';
      html += '<div class="picker-hint" style="margin:-6px 0 10px">From official score sheets \u2014 totals may differ from the league table if a sheet is incomplete</div>';
      html += '<div class="stat-grid">' +
        `<div class="stat-box"><div class="num">${data.games.length}</div><div class="label">Games</div></div>` +
        `<div class="stat-box"><div class="num">${totals.g}</div><div class="label">Goals</div></div>` +
        `<div class="stat-box"><div class="num">${totals.a}</div><div class="label">Assists</div></div>` +
        `<div class="stat-box"><div class="num">${totals.g + totals.a}</div><div class="label">Points</div></div>` +
        `<div class="stat-box"><div class="num">${totals.pim}</div><div class="label">PIM</div></div>` +
        '</div>';
      html += '<table><thead><tr><th>Date</th><th>Opponent</th><th class="num">Result</th><th class="num">Score</th><th class="num">G</th><th class="num">A</th><th class="num">Pts</th><th class="num">PIM</th><th class="num">ESG</th><th class="num">PPG</th><th class="num">SHG</th></tr></thead><tbody>';
      html += data.games.slice().reverse().map(g => `
        <tr><td>${esc(g.date)}</td><td>${g.home_away} ${esc(g.opponent)}</td>
        <td class="num"><span class="form-chip ${g.result.toLowerCase()}" aria-label="${chipLabel(g.result.toLowerCase())}">${g.result}</span></td>
        <td class="num">${g.score}</td><td class="num">${g.g}</td><td class="num">${g.a}</td><td class="num">${g.pts}</td><td class="num">${g.pim}</td>
        <td class="num">${g.esg}</td><td class="num">${g.ppg}</td><td class="num">${g.shg}</td></tr>`).join('');
      html += '</tbody></table></div>';
      $main.insertAdjacentHTML('beforeend', html);
      a11yFix($main);
    }

    async function renderAnalytics(refresh) {
      if (!state.leagues.length) {
        const home = await api('/api/today');
        state.leagues = home.leagues || [];
      }

      if (!state.leagueId) {
        let html = '<div class="card"><h2>Analytics</h2>';
        html += '<div class="picker-hint" style="margin:-4px 0 10px">Pick a day, then a league</div>' + pickerHtml() + '</div>';
        setMainHtml(html);
        return;
      }

      const data = await api(`/api/league/${state.leagueId}`, refresh);
      await loadAnalyticsContent(data);
    }

    async function loadAnalyticsContent(data) {
      if (!data || data.error) { $main.innerHTML = `<div class="error">${(data||{}).error || 'No data'}</div>`; return; }

      let html = `<div class="card"><h2>Analytics · ${data.league_name}</h2>`;
      html += changeLeagueHtml();

      // Points leaders mini chart
      const maxPts = Math.max(...data.standings.map(s => s.pts), 1);
      html += '<h3>Standings by Points</h3>';
      html += data.standings.map(s => `
        <div style="margin-bottom:8px" onclick="selectTeam('${s.team_id}')">
          <div style="display:flex;justify-content:space-between;font-size:13px"><span class="link">${s.team}</span><span>${s.pts} pts</span></div>
          <div class="bar"><div class="fill gf" style="width:${(s.pts / maxPts * 100).toFixed(1)}%"></div></div>
        </div>`).join('');

      // Goals for vs against
      const maxG = Math.max(...data.standings.map(s => Math.max(s.gf, s.ga)), 1);
      html += '<h3 style="margin-top:18px">Goals For vs Against</h3>';
      html += data.standings.slice(0, 8).map(s => `
        <div style="margin-bottom:10px" onclick="selectTeam('${s.team_id}')">
          <div style="display:flex;justify-content:space-between;font-size:13px"><span class="link">${s.team}</span><span><span style="color:var(--accent-2)">GF ${s.gf}</span> / <span style="color:var(--danger)">GA ${s.ga}</span></span></div>
          <div class="bar" title="GF green, GA red"><div class="fill gf" style="width:${(s.gf / (s.gf + s.ga || 1) * 100).toFixed(1)}%"></div><div class="fill ga" style="width:${(s.ga / (s.gf + s.ga || 1) * 100).toFixed(1)}%"></div></div>
        </div>`).join('');

      // Top scorers
      html += '<h3 style="margin-top:18px">Top Scorers</h3><table><thead><tr><th>Player</th><th>Team</th><th class="num">Pts</th></tr></thead><tbody>';
      html += data.leaders.points.map(p => `<tr class="link" onclick="selectPlayer('${p.team_id}','${p.player_id}')"><td><span class="link">${p.name}</span></td><td>${p.team}</td><td class="num">${p.value}</td></tr>`).join('');
      html += '</tbody></table></div>';

      setMainHtml(html);
    }

    // Toast + screen-reader announcements
    function announce(message) {
      const announcer = document.getElementById('a11y-announcer');
      if (announcer) {
        announcer.textContent = message;
        setTimeout(() => { announcer.textContent = ''; }, 1000);
      }
    }

    let toastTimer = null;
    function showToast(message) {
      let toast = document.getElementById('toast');
      if (!toast) return;
      toast.textContent = message;
      toast.classList.add('show');
      // toast has role="status" (implicit live region) — no extra announce() needed
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
    }

    // Public helpers for inline event handlers
    window.setTab = setTab;
    // Browsing a team (game rows, standings, compare) — does NOT change your saved team
    window.selectTeam = (teamId) => {
      if (!teamId) return;
      state.teamId = teamId;
      setTab('team');
    };

    function setMyTeam(teamId) {
      state.myTeam = teamId;
      localStorage.setItem('cahl-myteam', teamId);
    }

    // Explicitly save a team as "your team" (star button on team pages)
    window.makeMyTeam = (teamId) => {
      if (!teamId) return;
      setMyTeam(teamId);
      state.teamId = teamId;
      localStorage.setItem('cahl-team', teamId);
      showToast('Saved as your team');
      loadTeamContent(teamId);
    };
    window.selectPlayer = (teamId, playerId) => {
      if (!teamId || !playerId) return;
      state.profileReturn = state.tab;
      renderPlayerProfile(teamId, playerId);
    };

    window.selectPlayerToken = (token) => {
      if (!token) return;
      state.profileReturn = state.tab;
      renderPlayerProfile(null, null, token);
    };

    // Share the selected team's last result to the clipboard
    window.shareTeamResult = async (teamId) => {
      const data = await api(`/api/team/${teamId}`);
      if (data.error) { showToast('Could not load team'); return; }
      const over = data.overview, r = over.recent_result, form = data.form || {};
      if (!r) { showToast('No recent result to share'); return; }
      const isHome = r.home_id === teamId;
      const us = isHome ? r.home_final : r.away_final;
      const them = isHome ? r.away_final : r.home_final;
      const res = us > them ? 'W' : (us < them ? 'L' : 'T');
      const text = `${over.team_name} ${res} ${us}\u2013${them} ${isHome ? 'vs' : '@'} ${isHome ? r.away : r.home}` +
        (form.played ? ` \u00b7 Season: ${form.record}` : '');
      try {
        await navigator.clipboard.writeText(text);
        showToast('Result copied \u2014 paste it anywhere');
      } catch (e) {
        showToast(text);
      }
    };

    // Navigation
    navLinks.forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      setTab(a.dataset.tab);
    }));

    // Brand takes you home (Today) and back to the top
    document.getElementById('brandHome').addEventListener('click', e => {
      e.preventDefault();
      setTab('today');
      $main.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // Keyboard operability for pill/cell controls (Enter/Space activates)
    $main.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const target = e.target.closest('[data-day], [data-lid], [data-sec], [data-session], [data-cal-day], [data-pl-all], [data-pl-day], [data-pl-lid], [data-change-league], [data-cal-today], [data-cal-prev], [data-cal-next], [data-level], th[data-sort], [data-showall]');
      if (target) {
        e.preventDefault();
        target.click();
      }
    });

    // Team/player search typeaheads — fully delegated (re-renders can't leak listeners)
    $main.addEventListener('focusin', e => {
      if (e.target.id === 'teamSearch') loadAllTeams();
      if (e.target.id === 'playerSearch' && e.target.value.trim().length >= 2) renderPlayerTypeahead(e.target);
    });

    $main.addEventListener('input', e => {
      if (e.target.id === 'teamSearch') renderTypeahead(e.target);
      if (e.target.id === 'playerSearch') renderPlayerTypeahead(e.target);
    });

    $main.addEventListener('keydown', e => {
      const isTeam = e.target.id === 'teamSearch';
      const isPlayer = e.target.id === 'playerSearch';
      if (!isTeam && !isPlayer) return;
      const input = e.target;
      const box = $(isTeam ? '#teamSuggest' : '#playerSuggest');
      const items = isTeam ? taItems() : paItems();
      const getIdx = () => isTeam ? taIndex : paIndex;
      const setIdx = v => { if (isTeam) taIndex = v; else paIndex = v; };
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIdx(Math.min(getIdx() + 1, items.length - 1));
        (isTeam ? taHighlight : paHighlight)(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIdx(Math.max(getIdx() - 1, 0));
        (isTeam ? taHighlight : paHighlight)(items);
      } else if (e.key === 'Enter') {
        const pick = items[getIdx()] || items[0];
        if (!pick) return;
        if (box) (isTeam ? taClose : paClose)(input, box);
        input.value = '';
        if (isTeam) pickSearchedTeam(pick.dataset.tid, pick.dataset.lid);
        else openPlayer({
          token: pick.dataset.ptoken,
          playerId: pick.dataset.pid,
          teamId: pick.dataset.tid,
          teamName: pick.dataset.tname,
          playerName: pick.dataset.pname,
        });
      } else if (e.key === 'Escape') {
        if (box) (isTeam ? taClose : paClose)(input, box);
        input.blur();
      }
    });

    // Outside click closes any open typeahead (bound once)
    document.addEventListener('click', e => {
      if (e.target.closest('.team-search')) return;
      const tBox = $('#teamSuggest');
      if (tBox && tBox.classList.contains('open')) taClose($('#teamSearch'), tBox);
      const pBox = $('#playerSuggest');
      if (pBox && pBox.classList.contains('open')) paClose($('#playerSearch'), pBox);
    });

    // Delegated league-picker + change-league clicks
    $main.addEventListener('click', async (e) => {
      // Player lookup item selection — must come BEFORE the team check,
      // because player items also carry data-tid for game-log context
      const paItem = e.target.closest('.typeahead-item[data-pname]');
      if (paItem) {
        const input = $('#playerSearch');
        const box = $('#playerSuggest');
        if (input) input.value = '';
        if (box) paClose(input, box);
        openPlayer({
          token: paItem.dataset.ptoken,
          playerId: paItem.dataset.pid,
          teamId: paItem.dataset.tid,
          teamName: paItem.dataset.tname,
          playerName: paItem.dataset.pname,
        });
        return;
      }
      const lookupRetry = e.target.closest('[data-plookupretry]');
      if (lookupRetry) {
        const input = $('#playerSearch');
        if (input) renderPlayerTypeahead(input);
        return;
      }

      // Team search typeahead item selection
      const taItem = e.target.closest('.typeahead-item[data-tid]');
      if (taItem) {
        const input = $('#teamSearch');
        const box = $('#teamSuggest');
        if (input) input.value = '';
        if (box) taClose(input, box);
        pickSearchedTeam(taItem.dataset.tid, taItem.dataset.lid);
        return;
      }

      // Roster row → profile with game-log context
      const rp = e.target.closest('.roster-player');
      if (rp) {
        openPlayer({
          token: rp.dataset.token,
          teamId: rp.dataset.tid,
          teamName: rp.dataset.tname,
          playerName: rp.dataset.pname,
        });
        return;
      }

      // Retry loading the player index after a failure
      const retryEl = e.target.closest('[data-pretry]');
      if (retryEl) {
        loadAllPlayers(true);
        return;
      }
      const tretry = e.target.closest('[data-tretry]');
      if (tretry) {
        loadAllTeams(true);
        return;
      }

      // Roster/standings column sorting (data-rt scoped; re-renders from client cache)
      const rtSortEl = e.target.closest('th[data-sort][data-rt]');
      if (rtSortEl) {
        const rt = rtSortEl.dataset.rt;
        const key = rtSortEl.dataset.sort;
        const st = rt === 'skaters' ? state.rosterSort : rt === 'goalies' ? state.goalieSort : state.standingsSort;
        if (st.key === key) st.dir = st.dir === 'desc' ? 'asc' : 'desc';
        else { st.key = key; st.dir = (key === 'name' || key === 'team' || key === 'position') ? 'asc' : 'desc'; }
        if (rt === 'standings' && state.tab === 'league') await loadLeagueContent(state.leagueId);
        else await loadTeamContent(state.teamId);
        return;
      }

      // Leaderboard level filters + column sorting
      const levelEl = e.target.closest('[data-level]');
      if (levelEl) {
        state.board.level = levelEl.dataset.level;
        state.board.showAll = false;
        await renderPlayers();
        return;
      }
      const sortEl = e.target.closest('th[data-sort]');
      if (sortEl) {
        const key = sortEl.dataset.sort;
        if (state.board.sortKey === key) state.board.sortDir = state.board.sortDir === 'desc' ? 'asc' : 'desc';
        else { state.board.sortKey = key; state.board.sortDir = key === 'name' || key === 'team' ? 'asc' : 'desc'; }
        await renderPlayers();
        return;
      }
      const showAllEl = e.target.closest('[data-showall]');
      if (showAllEl) {
        state.board.showAll = !state.board.showAll;
        await renderPlayers();
        return;
      }

      // League section pills (Scores/Standings/Leaders/Game Nights/Calendar/Compare)
      const secEl = e.target.closest('.pill[data-sec]');
      if (secEl) {
        const sec = secEl.dataset.sec;
        localStorage.setItem('cahl-league-section', sec);
        document.querySelectorAll('.pill[data-sec]').forEach(p => p.classList.toggle('active', p.dataset.sec === sec));
        document.querySelectorAll('.league-sec').forEach(s => s.style.display = s.id === 'leagueSec' + sec ? 'block' : 'none');
        if (sec === 'Sessions') loadLeagueSessions(state.leagueId);
        if (sec === 'Calendar') loadLeagueCalendar(state.leagueId);
        if (sec === 'Compare') loadLeagueCompare(state.leagueId);
        return;
      }

      // Players-tab division filter (separate state from main league picker)
      const plAll = e.target.closest('[data-pl-all]');
      if (plAll) {
        state.playersLeague = '';
        state.playersDay = '';
        localStorage.removeItem('cahl-players-league');
        await renderPlayers();
        return;
      }
      const plDay = e.target.closest('[data-pl-day]');
      if (plDay) {
        const day = plDay.dataset.plDay;
        state.playersDay = day;
        // Immediately filter to that day's first division so content always matches the picker
        const groups = leagueGroups();
        const first = (groups[day] || [])[0];
        if (first) {
          state.playersLeague = first.id;
          localStorage.setItem('cahl-players-league', first.id);
        }
        await renderPlayers();
        return;
      }
      const plLid = e.target.closest('[data-pl-lid]');
      if (plLid) {
        state.playersLeague = plLid.dataset.plLid;
        localStorage.setItem('cahl-players-league', state.playersLeague);
        const l = state.leagues.find(x => x.id === state.playersLeague);
        if (l) state.playersDay = leagueDay(l.name);
        await renderPlayers();
        return;
      }

      // Sessions date pills
      const sessEl = e.target.closest('[data-session]');
      if (sessEl) {
        state.sessionDate = sessEl.dataset.session;
        renderSessionsSection();
        return;
      }

      // Calendar controls
      const calToday = e.target.closest('[data-cal-today]');
      if (calToday) {
        const now = new Date();
        state.calMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        state.calDay = dateKey(now);
        renderCalendarSection();
        return;
      }
      const calPrev = e.target.closest('[data-cal-prev]');
      const calNext = e.target.closest('[data-cal-next]');
      if (calPrev || calNext) {
        const [yy, mm] = state.calMonth.split('-').map(Number);
        const dt = new Date(yy, mm - 1 + (calNext ? 1 : -1), 1);
        state.calMonth = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
        state.calDay = '';
        renderCalendarSection();
        return;
      }
      const calDay = e.target.closest('[data-cal-day]');
      if (calDay) {
        state.calDay = calDay.dataset.calDay;
        renderCalendarSection();
        return;
      }

      const chg = e.target.closest('[data-change-league]');
      if (chg) {
        state.leagueId = '';
        localStorage.removeItem('cahl-league');
        await loadActiveTab();
        return;
      }
      const dayEl = e.target.closest('.day-pill');
      if (dayEl) {
        state.leagueDay = dayEl.dataset.day;
        localStorage.setItem('cahl-league-day', state.leagueDay);
        await loadActiveTab();
        return;
      }
      const lidEl = e.target.closest('.league-pill');
      if (lidEl) {
        await chooseLeague(lidEl.dataset.lid);
      }
    });

    $refresh.addEventListener('click', refreshAll);

    $auto.addEventListener('change', () => {
      state.auto = $auto.checked;
      localStorage.setItem('cahl-auto', state.auto ? '1' : '');
      if (autoTimer) clearInterval(autoTimer);
      if (state.auto) {
        autoTimer = setInterval(async () => {
          await fetch('/api/refresh?scope=scores', { method: 'POST' }).catch(() => {});
          state.cache = {};
          loadActiveTab(true);
        }, 30000);
      }
    });

    // Init
    (() => {
      state.auto = !!localStorage.getItem('cahl-auto');
      $auto.checked = state.auto;
      if (state.auto) {
        autoTimer = setInterval(async () => {
          await fetch('/api/refresh?scope=scores', { method: 'POST' }).catch(() => {});
          state.cache = {};
          loadActiveTab(true);
        }, 30000);
      }
      setTab(state.tab);
      // Prefetch teams only. Player lookup uses /api/players/lookup so a
      // boot-time roster fan-out cannot starve a typed name search.
      loadAllTeams();
    })();

    /* ============================================================
       ⌘K COMMAND PALETTE — search players / teams / pages.
       Lives inside the IIFE so it can read state (allTeams,
       allPlayers) and call the same openers the UI uses.
       ============================================================ */
    const kpal = {
      ov: document.getElementById('kpalOv'),
      q: document.getElementById('kpalQ'),
      list: document.getElementById('kpalList'),
      items: [],
      sel: 0,
      open: false,
      playersTried: false,
    };

    function kpalEsc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }

    function kpalHi(s, query) {
      const i = query ? s.toLowerCase().indexOf(query.toLowerCase()) : -1;
      if (i < 0) return kpalEsc(s);
      return kpalEsc(s.slice(0, i)) + '<mark>' + kpalEsc(s.slice(i, i + query.length)) + '</mark>' + kpalEsc(s.slice(i + query.length));
    }

    function kpalEnsureData() {
      loadAllTeams();
      // Pull the full player index once (cron keeps it warm; ~5.9k players).
      if (!kpal.playersTried) {
        kpal.playersTried = true;
        loadAllPlayers().catch(() => {});
      }
    }

    function kpalNavItems() {
      return [
        { kind: 'page', icon: 'T', name: "Today's games", sb: 'page', act: () => setTab('today') },
        { kind: 'page', icon: 'L', name: 'League standings & scores', sb: 'page', act: () => setTab('league') },
        { kind: 'page', icon: 'P', name: 'Players & leaderboard', sb: 'page', act: () => setTab('players') },
        { kind: 'page', icon: 'A', name: 'Analytics', sb: 'page', act: () => setTab('analytics') },
        { kind: 'page', icon: '★', name: 'My team', sb: 'page', act: () => setTab('team') },
      ];
    }

    function kpalQuery(query) {
      const qq = (query || '').trim().toLowerCase();
      const teams = (state.allTeams || []);
      const players = (state.allPlayers || []);

      // index: name → {players, teams} built once per keystroke from caches
      let items = [];
      if (!qq) {
        items = kpalNavItems();
      } else {
        const pages = kpalNavItems().filter(p => p.name.toLowerCase().includes(qq));
        const teamHits = teams
          .filter(t => (t.name || '').toLowerCase().includes(qq))
          .slice(0, 6)
          .map(t => ({ kind: 'team', icon: '≡', name: t.name, id: t.id, sb: 'team page', act: () => window.selectTeam(t.id) }));
        const playerHits = players
          .filter(p => (p.name || '').toLowerCase().includes(qq))
          .sort((a, b) => a.name.toLowerCase().indexOf(qq) - b.name.toLowerCase().indexOf(qq))
          .slice(0, 8)
          .map(kpalPlayerItem);
        items = [...teamHits, ...playerHits, ...pages];

        // Index not loaded yet (cold start): fall back to the fast server
        // lookup so typed names still return results immediately.
        if (!playerHits.length && !players.length && qq.length >= 2) {
          kpalServerLookup(query);
          if (!kpal.list.querySelector('.pal-searching')) {
            items = items.concat([{ kind: 'searching', icon: '…', name: 'Searching the league…', sb: '', act: null }]);
          }
        }
      }

      kpal.items = items;
      kpal.sel = 0;
      kpalRender(qq);
    }

    function kpalPlayerItem(p) {
      const tok = p.token || '';
      const pid = p.player_id || '';
      const tid = p.team_id || '';
      return {
        kind: 'player', icon: (p.position || '').slice(0, 2).toUpperCase() || '•',
        name: p.name, team: p.team,
        sb: p.team || '',
        act: () => {
          if (tok) window.selectPlayerToken(tok);
          else if (pid && tid) window.selectPlayer(tid, pid);
          else showToast('No profile link for that player');
        },
      };
    }

    let kpalLookupSeq = 0;
    async function kpalServerLookup(query) {
      const seq = ++kpalLookupSeq;
      try {
        const result = await lookupPlayers(query);
        if (seq !== kpalLookupSeq || !kpal.open) return;
        if (kpal.q.value.trim().toLowerCase() !== query.trim().toLowerCase()) return;
        const hits = (result && result.players) || [];
        if (!hits.length) return;
        // Re-run the query — state.allPlayers may now have data; if not,
        // inject the lookup hits directly as player items.
        const qq = query.trim().toLowerCase();
        const idxPlayers = (state.allPlayers || [])
          .filter(p => (p.name || '').toLowerCase().includes(qq)).slice(0, 8);
        const playerItems = idxPlayers.length
          ? idxPlayers.map(kpalPlayerItem)
          : hits.map(kpalPlayerItem);
        const pages = kpalNavItems().filter(p => p.name.toLowerCase().includes(qq));
        const teamHits = (state.allTeams || [])
          .filter(t => (t.name || '').toLowerCase().includes(qq))
          .slice(0, 6)
          .map(t => ({ kind: 'team', icon: '≡', name: t.name, id: t.id, sb: 'team page', act: () => window.selectTeam(t.id) }));
        kpal.items = [...teamHits, ...playerItems, ...pages];
        kpal.sel = 0;
        kpalRender(qq);
      } catch (e) { /* palette still works with pages/teams */ }
    }

    function kpalRender(qq) {
      if (!kpal.items.length) {
        kpal.list.innerHTML = '<div class="pal-empty">No matches. Try a player or team name.</div>';
        return;
      }
      let html = '', last = '';
      kpal.items.forEach((it, i) => {
        const grp = it.kind === 'player' ? 'Players' : it.kind === 'team' ? 'Teams' : it.kind === 'page' ? 'Pages' : 'Tonight';
        if (grp !== last) { html += `<div class="pal-grp">${grp}</div>`; last = grp; }
        html += `<div class="pal-item" role="option" data-i="${i}" aria-selected="${i === 0}">
          <span class="pal-ic${it.kind === 'player' ? ' red' : ''}">${kpalEsc(it.icon)}</span>
          <span class="pal-nm">${kpalHi(it.name, qq)}</span>
          <span class="pal-sb">${kpalEsc(it.sb)}</span>
        </div>`;
      });
      kpal.list.innerHTML = html;
      kpalPaint();
    }

    function kpalPaint() {
      kpal.list.querySelectorAll('.pal-item').forEach(el => {
        el.setAttribute('aria-selected', String(+el.dataset.i === kpal.sel));
      });
      const on = kpal.list.querySelector('.pal-item[aria-selected="true"]');
      if (on) on.scrollIntoView({ block: 'nearest' });
    }

    function kpalOpen() {
      kpal.open = true;
      kpal.ov.classList.add('open');
      kpal.ov.setAttribute('aria-hidden', 'false');
      kpal.q.value = '';
      kpalEnsureData();
      kpalQuery('');
      setTimeout(() => kpal.q.focus(), 15);
    }

    function kpalClose() {
      kpal.open = false;
      kpal.ov.classList.remove('open');
      kpal.ov.setAttribute('aria-hidden', 'true');
    }

    function kpalToggle() { kpal.open ? kpalClose() : kpalOpen(); }

    function kpalRun() {
      const it = kpal.items[kpal.sel];
      kpalClose();
      if (it && it.act) it.act();
    }

    document.getElementById('kpalBtn').addEventListener('click', kpalToggle);
    kpal.ov.addEventListener('click', e => { if (e.target === kpal.ov) kpalClose(); });
    kpal.q.addEventListener('input', () => kpalQuery(kpal.q.value));
    kpal.q.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { kpal.sel = Math.min(kpal.sel + 1, kpal.items.length - 1); kpalPaint(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { kpal.sel = Math.max(kpal.sel - 1, 0); kpalPaint(); e.preventDefault(); }
      else if (e.key === 'Enter') { kpalRun(); }
    });
    kpal.list.addEventListener('click', e => {
      const el = e.target.closest('.pal-item');
      if (!el) return;
      kpal.sel = +el.dataset.i;
      kpalRun();
    });
    kpal.list.addEventListener('mousemove', e => {
      const el = e.target.closest('.pal-item');
      if (el) { kpal.sel = +el.dataset.i; kpalPaint(); }
    });
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        kpalToggle();
      } else if (e.key === 'Escape' && kpal.open) {
        kpalClose();
      }
    });
    window.__kpal = kpal;
