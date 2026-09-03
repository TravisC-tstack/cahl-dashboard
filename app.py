import os
import socket
import concurrent.futures
from flask import Flask, jsonify, render_template, request

import scraper

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
    static_url_path="/static",
)


def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _jsonify(data, err):
    if err:
        return jsonify({"error": err}), 502
    return jsonify(data)


@app.after_request
def no_cache_html(resp):
    # Always serve the shell fresh; static assets are versioned with ?v=N.
    if resp.content_type and resp.content_type.startswith("text/html"):
        resp.headers["Cache-Control"] = "no-store"
    # Live scores must not sit behind a CDN/browser cache.
    path = request.path or ""
    if path.startswith("/api/today"):
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["Pragma"] = "no-cache"
    return resp


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/today")
def today():
    # Fast path: homepage only. Scores come from /api/today/scores so the page
    # paints immediately instead of waiting on 30 dashboard fetches.
    data, err = scraper.parse_homepage()
    if err:
        return jsonify({"error": err}), 502
    return jsonify(data)


@app.route("/api/today/scores")
def today_scores():
    """Live/final scores for today's games (separate slower path).
    Uses the warm teams cache to fetch only game-night dashboards; cold starts
    fall back to all leagues, soft-timed so the endpoint always answers."""
    data, err = scraper.parse_homepage()
    if err:
        return jsonify({"error": err}), 502
    try:
        league_ids = None
        if _TEAMS_CACHE["data"]:
            by_id = {t["id"]: t["league_id"] for t in _TEAMS_CACHE["data"]}
            league_ids = set()
            for g in data.get("today", []):
                for tid in (g.get("home_id"), g.get("away_id")):
                    if tid in by_id:
                        league_ids.add(by_id[tid])
            if not league_ids:
                league_ids = None
        scraper.enrich_today_scores(data, league_ids=league_ids, timeout=45, fresh=True)
    except Exception as e:
        print(f"[today_scores] enrich failed: {e}")  # never swallow silently
    return jsonify({"games": data.get("today", [])})


@app.route("/api/leaders")
def leaders():
    data, err = scraper.parse_all_leaders()
    return _jsonify(data, err)


@app.route("/api/league/<league_id>")
def league(league_id):
    data, err = scraper.parse_dashboard(league_id)
    return _jsonify(data, err)


@app.route("/api/team/<team_id>")
def team(team_id):
    # Fetch team sub-pages in parallel to keep the dashboard snappy.
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        f_over = ex.submit(scraper.parse_team_overview, team_id)
        f_sched = ex.submit(scraper.parse_team_schedule, team_id)
        f_stats = ex.submit(scraper.parse_team_stats, team_id)
        f_stand = ex.submit(scraper.parse_team_standings, team_id)
        f_sessions = ex.submit(_sessions_for_team, team_id)

        over, e1 = f_over.result()
        sched, e2 = f_sched.result()
        stats, e3 = f_stats.result()
        stand, e4 = f_stand.result()
        sessions_data, e5 = f_sessions.result()

    err = e1 or e2 or e3 or e4
    if err:
        return jsonify({"error": err}), 502

    team_row = next((s for s in (stand or []) if s.get("team_id") == team_id), None)

    race = {}
    team_race = None
    playoffs = []
    championship = None
    season = (over or {}).get("season") or ""
    league_name = ""
    if not e5 and sessions_data:
        cutoff = sessions_data.get("playoff_cutoff")
        race = scraper.compute_playoff_race(stand or [], len(sched or []), cutoff)
        team_race = race.get(team_id)
        playoffs = sessions_data.get("playoffs", [])
        championship = sessions_data.get("championship")
        season = sessions_data.get("season") or season
        league_name = sessions_data.get("league_name") or ""

    form = scraper.compute_team_form(sched or [], team_id, team_row)
    team_name = (over or {}).get("team_name") or ""
    awards = scraper.awards_for_team(team_id, team_name, championship, stats)
    previous_sessions = []  # ChillerStats does not publish prior session W-L on team pages

    current_session = None
    if season or (form and form.get("played")):
        current_session = {
            "label": season or "Current session",
            "record": form.get("record") if form else None,
            "w": form.get("wins") if form else None,
            "l": form.get("losses") if form else None,
            "otl": form.get("otl") if form else None,
            "ties": form.get("ties") if form else None,
            "points": form.get("points") if form else None,
        }

    return jsonify({
        "overview": over,
        "schedule": sched,
        "roster": stats,
        "standings": stand,
        "form": form,
        "race": team_race,
        "playoffs": playoffs,
        "season": season,
        "league_name": league_name,
        "championship": championship,
        "awards": awards,
        "current_session": current_session,
        "previous_sessions": previous_sessions,
    })


_HISTORY_CACHE = {}
_HISTORY_TTL = 21600  # 6 hours; past sessions rarely change


@app.route("/api/team/<team_id>/history")
def team_history(team_id):
    """Previous-session W-L-OTL and championship/1st-place awards.

    Separate from /api/team so the main team page is never blocked on
    roster fan-out. Cached aggressively; partial results are not stored.
    """
    import time
    now = time.time()
    cached = _HISTORY_CACHE.get(team_id)
    if cached and now - cached["ts"] < _HISTORY_TTL:
        return jsonify(cached["data"])
    data, err = scraper.parse_team_history(team_id, timeout=20)
    if err:
        return jsonify({"error": err, "previous": [], "awards": [], "sessions": []}), 502
    payload = data or {"previous": [], "awards": [], "sessions": []}
    if data and not data.get("partial"):
        _HISTORY_CACHE[team_id] = {"data": payload, "ts": now}
    return jsonify(payload)


def _all_teams_cached(timeout=None):
    """The /api/teams aggregate, using its 5-minute cache."""
    import time
    now = time.time()
    if _TEAMS_CACHE["data"] is not None and now - _TEAMS_CACHE["ts"] < _TEAMS_TTL:
        return _TEAMS_CACHE["data"], None
    kw = {} if timeout is None else {"timeout": timeout}
    data, err = scraper.parse_all_teams(**kw)
    if err:
        return None, err
    if data:
        _TEAMS_CACHE["data"] = data
        _TEAMS_CACHE["ts"] = now
    return data, None


def _sessions_for_team(team_id):
    """Sessions for the team's league (for race calc); league found via the teams cache."""
    teams_data, err = _all_teams_cached()
    if err:
        return None, err
    match = next((t for t in teams_data if t["id"] == team_id), None)
    if not match:
        return None, "league not found for team"
    league_id = match["league_id"]
    sessions_data, e2 = scraper.parse_league_sessions(league_id)
    if e2:
        return None, e2
    dash, e3 = scraper.parse_dashboard(league_id)
    if not e3:
        sessions_data["playoffs"] = dash.get("playoffs", [])
        sessions_data["playoff_cutoff"] = dash.get("playoff_cutoff")
        sessions_data["championship"] = dash.get("championship")
        sessions_data["season"] = dash.get("season") or sessions_data.get("season")
        sessions_data["league_name"] = dash.get("league_name") or sessions_data.get("league_name")
    return sessions_data, None


_TEAMS_CACHE = {"data": None, "ts": 0}
_TEAMS_TTL = 900  # 15 minutes; aggregating 30 league pages is expensive


@app.route("/api/teams")
def teams():
    import time
    now = time.time()
    if _TEAMS_CACHE["data"] is not None and now - _TEAMS_CACHE["ts"] < _TEAMS_TTL:
        return jsonify(_TEAMS_CACHE["data"])
    data, err = scraper.parse_all_teams()
    if err:
        return jsonify({"error": err}), 502
    if data:
        _TEAMS_CACHE["data"] = data
        _TEAMS_CACHE["ts"] = now
    return jsonify(data or [])


_PLAYERS_CACHE = {"data": None, "ts": 0, "partial": False}
_PLAYERS_TTL = 3600  # 1 hour; matches the hourly cron baseline that re-warms it.


def _merge_player_index(entries):
    """Warm the players cache with whatever rosters we have so far."""
    import time
    if not entries:
        return
    existing = {f"{p['name'].lower()}|{p.get('team_id')}": p for p in (_PLAYERS_CACHE["data"] or [])}
    existing.update(entries)
    data = sorted(existing.values(), key=lambda p: p["name"].lower())
    _PLAYERS_CACHE["data"] = data
    _PLAYERS_CACHE["ts"] = time.time()
    _PLAYERS_CACHE["partial"] = True


@app.route("/api/players/lookup")
def players_lookup():
    """Name search that must return without a 50s roster fan-out."""
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"players": [], "partial": False})
    ql = q.lower()
    cached = _PLAYERS_CACHE.get("data")
    if cached:
        hits = [p for p in cached if ql in (p.get("name") or "").lower() or ql in (p.get("team") or "").lower()]
        if hits:
            return jsonify({"players": hits[:25], "partial": bool(_PLAYERS_CACHE.get("partial"))})
        if not _PLAYERS_CACHE.get("partial") and cached:
            return jsonify({"players": [], "partial": False})

    teams_data, err = _all_teams_cached(timeout=20)
    if err:
        return jsonify({"error": err, "players": []}), 502
    hits, partial, indexed, serr = scraper.search_players(q, teams_data, timeout=32)
    if indexed:
        _merge_player_index(indexed)
        if not partial:
            _PLAYERS_CACHE["partial"] = False
    if serr and not hits:
        return jsonify({"error": serr, "players": []}), 502
    return jsonify({
        "players": hits[:25],
        "partial": partial,
        "fetched": len(indexed),
        "total": len(teams_data or []),
    })


@app.route("/api/players")
def players():
    """Every player on every team across all leagues (for the full leaderboard)."""
    import time
    from concurrent.futures import ThreadPoolExecutor
    now = time.time()
    if (_PLAYERS_CACHE["data"] is not None
            and now - _PLAYERS_CACHE["ts"] < _PLAYERS_TTL
            and not _PLAYERS_CACHE.get("partial")):
        return jsonify({"players": _PLAYERS_CACHE["data"], "partial": False})

    teams_data, err = _all_teams_cached()
    if err:
        return jsonify({"error": err}), 502

    index = {}
    errors = []

    def fetch(team):
        try:
            roster, e = scraper.parse_team_stats(team["id"])
        except Exception as ex:
            errors.append(str(ex))
            return
        if e:
            errors.append(e)
            return
        scraper.index_roster(team, roster, index)

    # Keep this well under the function limit so the UI can clear loading.
    # ?full=1 (cron warm) gets a much longer window to finish every roster.
    SOFT_TIMEOUT = 90 if request.args.get("full") else 18
    ex = ThreadPoolExecutor(max_workers=16)
    futures = [ex.submit(fetch, team) for team in teams_data]
    done, pending = concurrent.futures.wait(futures, timeout=SOFT_TIMEOUT)
    complete = not pending
    ex.shutdown(wait=False, cancel_futures=True)

    if not index and errors and not done:
        cached = _PLAYERS_CACHE.get("data") or []
        if cached:
            return jsonify({"players": cached, "partial": True, "error": "; ".join(errors[:3])})
        return jsonify({"error": "; ".join(errors[:3]), "players": []}), 502

    data = sorted(index.values(), key=lambda p: p["name"].lower())
    _PLAYERS_CACHE["data"] = data
    _PLAYERS_CACHE["ts"] = now
    _PLAYERS_CACHE["partial"] = not complete
    return jsonify({
        "players": data,
        "partial": not complete,
        "fetched": len(done),
        "total": len(teams_data),
    })


_SESSIONS_CACHE = {}
_SESSIONS_TTL = 300  # 5 minutes; aggregating every team's schedule is expensive


@app.route("/api/sessions/<league_id>")
def sessions(league_id):
    import time
    now = time.time()
    cached = _SESSIONS_CACHE.get(league_id)
    if cached and now - cached["ts"] < _SESSIONS_TTL:
        return jsonify(cached["data"])
    data, err = scraper.parse_league_sessions(league_id)
    if err:
        return jsonify({"error": err}), 502
    _SESSIONS_CACHE[league_id] = {"data": data, "ts": now}
    return jsonify(data)


@app.route("/api/player/<team_id>/<player_id>")
def player(team_id, player_id):
    data, err = scraper.parse_player_history(team_id, player_id)
    return _jsonify(data, err)


@app.route("/api/game-log/<team_id>")
def game_log(team_id):
    """Per-game G/A/Pts/PIM log for one player, built from score sheets."""
    from urllib.parse import unquote
    player = unquote(request.args.get("player", "")).strip()
    team_name = unquote(request.args.get("team", "")).strip()
    if not player or not team_name:
        return jsonify({"error": "player and team query params required"}), 400
    sched, err = scraper.parse_team_schedule(team_id)
    if err:
        return jsonify({"error": err}), 502
    entries, err2 = scraper.compute_player_game_log(sched or [], player, team_name)
    if err2:
        return jsonify({"error": err2}), 502
    return jsonify({"player": player, "team": team_name, "games": entries})


@app.route("/api/player-token/<token>")
def player_token(token):
    data, err = scraper.parse_player_history_by_token(token)
    return _jsonify(data, err)


@app.route("/api/version")
def version():
    """Frontend version for the self-heal freshness check (parsed from app.js)."""
    import re as _re
    try:
        src = open(os.path.join(BASE_DIR, "static", "js", "app.js")).read()
        m = _re.search(r"JS_VERSION\s*=\s*(\d+)", src)
        return jsonify({"js": int(m.group(1)) if m else 0})
    except Exception:
        return jsonify({"js": 0})


@app.route("/api/refresh", methods=["POST"])
def refresh():
    """scope=scores (cron): light refresh of page-level caches only, leaving the big
    aggregates (players/teams indexes) intact. scope=all (manual): full force refresh."""
    scope = request.args.get("scope", "all")
    scraper.clear_cache()
    _SESSIONS_CACHE.clear()
    _HISTORY_CACHE.clear()
    if scope == "all":
        _TEAMS_CACHE["data"] = None
        _TEAMS_CACHE["ts"] = 0
        _PLAYERS_CACHE["data"] = None
        _PLAYERS_CACHE["ts"] = 0
        _PLAYERS_CACHE["partial"] = False
    return jsonify({"ok": True, "scope": scope})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 0)) or find_free_port()
    print(f"\nCAHL Dashboard running at http://127.0.0.1:{port}\n")
    app.run(host="127.0.0.1", port=port, threaded=True, debug=False)
