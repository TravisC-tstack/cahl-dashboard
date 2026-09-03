import re
import time
import unicodedata
import requests
from bs4 import BeautifulSoup
from datetime import datetime, timedelta
from html import unescape

BASE_URL = "https://www.chillerstats.com"  # site now 302-redirects http -> https; go direct
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
}

session = requests.Session()
session.headers.update(HEADERS)
# Fan-out searches run up to 24 concurrent workers; the default 10-connection
# pool discards connections under that load (slow lookups, warning spam).
try:
    from requests.adapters import HTTPAdapter
    _pool = HTTPAdapter(pool_connections=32, pool_maxsize=32)
    session.mount("https://", _pool)
    session.mount("http://", _pool)
except Exception:
    pass


class Cache:
    def __init__(self, ttl=60):
        self.ttl = ttl
        self.store = {}

    def _effective_ttl(self):
        """Shorter TTL during evening game hours (ET) so live scores stay fresh.
        Still capped to keep scrape volume gentle on the source site."""
        try:
            from zoneinfo import ZoneInfo
            et_hour = datetime.now(ZoneInfo("America/New_York")).hour
        except Exception:
            et_hour = (datetime.utcnow().hour - 4) % 24  # EDT fallback
        # Game nights often start ~5pm ET; keep scrape cache very short so
        # /api/today/scores doesn't serve a minute-old scoreboard.
        return 8 if et_hour >= 17 else self.ttl

    def get(self, key):
        if key in self.store:
            value, exp = self.store[key]
            if time.time() < exp:
                return value
            del self.store[key]
        return None

    def set(self, key, value):
        self.store[key] = (value, time.time() + self._effective_ttl())

    def clear(self):
        self.store.clear()


cache = Cache(ttl=60)


def _url(path):
    if path.startswith("http"):
        return path
    return f"{BASE_URL}/{path.lstrip('/')}"


def get_soup(path, fresh=False, timeout=30):
    key = f"html:{path}"
    text = None if fresh else cache.get(key)
    if text is None:
        try:
            resp = session.get(_url(path), timeout=timeout)
            resp.raise_for_status()
            text = resp.text
            # Throttle/error pages are tiny; real pages are tens of KB.
            # Never cache a suspicious page — that poisons every downstream parse.
            if len(text) < 2000:
                return None, f"Suspiciously short page ({len(text)} bytes): {path}"
            cache.set(key, text)
        except Exception as e:
            return None, str(e)
    return BeautifulSoup(text, "html.parser"), None


def clear_cache():
    cache.clear()


def _text(el):
    if not el:
        return ""
    return unescape(el.get_text(strip=True))


def _extract_id(href, field):
    if not href:
        return None
    m = re.search(rf"{field}=([^&\"]+)", href)
    if not m:
        return None
    val = m.group(1)
    # IDs flow into onclick="selectTeam('...')" templates in app.js; only
    # alphanumerics ever appear in real chillerstats IDs (opaque tokens run
    # 32-128 chars). Dropping anything else keeps quotes/HTML out of
    # attribute context at the source.
    return val if re.fullmatch(r"[A-Za-z0-9_-]{1,200}", val) else None


def _query_token(href):
    """Bare opaque token after ? (chillerstats dropped named LeagueID/TeamID params)."""
    if not href or "?" not in href:
        return None
    q = href.split("?", 1)[1].split("#", 1)[0]
    first = q.split("&")[0].strip()
    if first and "=" not in first and re.fullmatch(r"[A-Za-z0-9_-]{1,200}", first):
        return first
    return None


def _is_opaque_id(ident):
    return bool(re.fullmatch(r"[A-Fa-f0-9]{32,}", str(ident or "")))


def _resource_qs(legacy_param, ident):
    ident = str(ident or "")
    if _is_opaque_id(ident):
        return ident
    return f"{legacy_param}={ident}"


def _team_id(href):
    named = _extract_id(href, "TeamID")
    if named:
        return named
    if not href:
        return None
    low = href.lower()
    if "/team/" in low or low.startswith("team/") or "team/index.cfm" in low:
        return _query_token(href)
    return None


def _league_id(href):
    named = _extract_id(href, "LeagueID")
    if named:
        return named
    if href and "dashboard.cfm" in href.lower():
        return _query_token(href)
    return None


def _player_id(href):
    named = _extract_id(href, "PlayerID")
    if named:
        return named
    if href and "player_history.cfm" in href.lower():
        return _query_token(href)
    return None


def _score_to_int(s):
    s = s.strip() if s else ""
    return int(s) if s.isdigit() else 0


def _norm_team_name(name):
    """Accent/punctuation-insensitive team-name normalization for matching."""
    if not name:
        return ""
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    n = re.sub(r"[^\w\s]", "", n)
    n = re.sub(r"\b(hockey|hc)\b", "", n, flags=re.IGNORECASE)
    return " ".join(n.lower().split())


def parse_homepage():
    soup, err = get_soup("/")
    if err:
        return None, err

    today = []
    leagues = []

    # Find Today's Games carousel article
    article = None
    for a in soup.find_all("article", class_="item"):
        h2 = a.find("h2")
        if h2 and "Today" in h2.get_text():
            article = a
            break

    if article:
        # Game pairs are inside .row elements directly under .carousel-caption.
        caption = article.find("div", class_="carousel-caption")
        if caption:
            rows = caption.find_all("div", class_="row", recursive=False)
            for row in rows:
                for blk in row.find_all("div", class_="col-sm-4", recursive=False):
                    info_divs = blk.find_all("div", recursive=False)
                    if len(info_divs) < 2:
                        continue
                    meta = _text(info_divs[0])
                    m = re.match(r"(\d{1,2}:\d{2}\s*(?:AM|PM))\s*-\s*(.+)", meta, re.IGNORECASE)
                    gametime = m.group(1) if m else meta
                    facility = m.group(2).strip() if m else ""

                    matchup = info_divs[1]
                    links = matchup.find_all("a", href=True)
                    if len(links) >= 2:
                        home = _text(links[0])
                        home_id = _team_id(links[0]["href"])
                        away = _text(links[1])
                        away_id = _team_id(links[1]["href"])
                    else:
                        text = _text(matchup)
                        parts = [p.strip() for p in text.split("vs.")]
                        home = parts[0] if len(parts) > 0 else ""
                        away = parts[1] if len(parts) > 1 else ""
                        home_id = away_id = None

                    # Deduplicate; the site sometimes repeats the last game row.
                    key = (gametime, facility, home, away)
                    if any((g["time"], g["facility"], g["home"], g["away"]) == key for g in today):
                        continue

                    today.append({
                        "time": gametime,
                        "facility": facility,
                        "home": home,
                        "home_id": home_id,
                        "away": away,
                        "away_id": away_id,
                    })

    # All dashboard links from the league selectors
    seen = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "dashboard.cfm?" in href:
            lid = _league_id(href)
            if lid and lid not in seen:
                seen.add(lid)
                txt = _text(a)
                leagues.append({
                    "id": lid,
                    "name": txt,
                })

    return {"today": today, "leagues": leagues}, None


def parse_all_leaders():
    soup, err = get_soup("/all_leaders.cfm")
    if err:
        return None, err

    result = {"points": [], "goals": [], "assists": []}
    table_map = {
        "pts": ("points", "points"),
        "goals": ("goals", "goals"),
        "asst": ("assists", "assists"),
    }

    for table_id, (key, val_key) in table_map.items():
        table = soup.find("table", {"id": table_id})
        if not table:
            continue
        rows = table.find("tbody").find_all("tr") if table.find("tbody") else []
        for i, row in enumerate(rows, 1):
            cells = row.find_all("td")
            if len(cells) < 3:
                continue
            name_link = cells[0].find("a", href=True)
            team_link = cells[1].find("a", href=True)
            player_id = _player_id(name_link["href"]) if name_link else None
            team_id = _team_id(team_link["href"]) if team_link else None
            result[key].append({
                "rank": i,
                "name": _text(name_link) if name_link else _text(cells[0]),
                "team": _text(team_link) if team_link else _text(cells[1]),
                "team_id": team_id,
                "player_id": player_id,
                val_key: _score_to_int(_text(cells[2])),
            })

    return result, None


def _team_from_link(link):
    return {"name": _text(link), "id": _team_id(link.get("href", ""))} if link else {"name": "", "id": None}


def _parse_games_section(soup, section_heading):
    games = []
    # Find a section by heading text
    headings = soup.find_all(lambda t: t.name in ("h1", "h2") and section_heading in t.get_text())
    for h in headings:
        section = h.find_parent("section") or h.find_parent("div", class_="row")
        if not section:
            section = h.parent
        # Look for repeated game blocks
        for row in section.find_all("div", class_="row"):
            cells = row.find_all("div")
            if len(cells) < 2:
                continue
            # One of the divs may contain an icon and another the text
            text_div = None
            for c in cells:
                if c.find("i", class_=re.compile("fa-calendar|fa-clock")) or c.find("a"):
                    text_div = c
                    break
            if text_div is None:
                text_div = cells[-1]
            info = text_div.find_all("div", recursive=False)
            if len(info) < 2:
                continue
            meta = _text(info[0])
            m = re.match(r"(.+)\s*-\s*(\d{1,2}:\d{2}\s*(?:AM|PM))", meta, re.IGNORECASE)
            if m:
                date = m.group(1).strip()
                gametime = m.group(2)
            else:
                m = re.match(r"(\d{1,2}:\d{2}\s*(?:AM|PM))\s*-\s*(.+)", meta, re.IGNORECASE)
                date = None
                gametime = m.group(1) if m else ""
                # Try to find date from heading
                date = h.get_text(strip=True).replace("Upcoming Games", "").replace("Recent Results", "").strip()

            matchup = info[1]
            links = matchup.find_all("a", href=True)
            home = _team_from_link(links[0]) if len(links) > 0 else {"name": "", "id": None}
            away = _team_from_link(links[1]) if len(links) > 1 else {"name": "", "id": None}

            games.append({
                "date": date,
                "time": gametime,
                "facility": "",
                "home": home["name"],
                "home_id": home["id"],
                "away": away["name"],
                "away_id": away["id"],
            })
    return games


def parse_dashboard(league_id, fresh=False):
    soup, err = get_soup("/dashboard.cfm?" + _resource_qs("LeagueID", league_id), fresh=fresh)
    if err:
        return None, err

    title = soup.find("h1")
    league_name = _text(title) if title else ""
    season = ""
    breadcrumb = soup.find("ol", class_="breadcrumb")
    if breadcrumb:
        season = _text(breadcrumb.find("li", class_="active") or breadcrumb.find("li"))

    # Standings
    standings = []
    standings_heading = soup.find(lambda t: t.name in ("h1", "h2") and "Standings" in t.get_text())
    if standings_heading:
        table = standings_heading.find_parent("div", class_="row")
        if table:
            table = table.find("table")
    else:
        table = soup.find("table")

    if table:
        rows = table.find("tbody").find_all("tr") if table.find("tbody") else []
        for row in rows:
            cells = row.find_all("td")
            if len(cells) < 8:
                continue
            team_link = cells[0].find("a", href=True)
            standings.append({
                "team": _text(team_link) if team_link else _text(cells[0]),
                "team_id": _team_id(team_link["href"]) if team_link else None,
                "gp": _score_to_int(_text(cells[1])),
                "w": _score_to_int(_text(cells[2])),
                "l": _score_to_int(_text(cells[3])),
                "otl": _score_to_int(_text(cells[4])),
                "pts": _score_to_int(_text(cells[5])),
                "gf": _score_to_int(_text(cells[6])),
                "ga": _score_to_int(_text(cells[7])),
            })

    # League leaders (pts, goals, asst, pim)
    leaders = {"points": [], "goals": [], "assists": [], "pim": []}
    table_map = {
        "pts": "points",
        "goals": "goals",
        "asst": "assists",
        "pim": "pim",
    }
    for table_id, key in table_map.items():
        table = soup.find("table", {"id": table_id})
        if not table:
            continue
        rows = table.find("tbody").find_all("tr") if table.find("tbody") else []
        for i, row in enumerate(rows, 1):
            cells = row.find_all("td")
            if len(cells) < 3:
                continue
            name_link = cells[0].find("a", href=True)
            team_link = cells[1].find("a", href=True)
            player_id = _player_id(name_link["href"]) if name_link else None
            team_id = _team_id(team_link["href"]) if team_link else None
            leaders[key].append({
                "rank": i,
                "name": _text(name_link) if name_link else _text(cells[0]),
                "team": _text(team_link) if team_link else _text(cells[1]),
                "team_id": team_id,
                "player_id": player_id,
                "value": _score_to_int(_text(cells[2])),
            })

    # Upcoming games and recent results
    upcoming = []
    recent = []

    upcoming_heading = soup.find(lambda t: t.name in ("h1", "h2") and "Upcoming Games" in t.get_text())
    if upcoming_heading:
        section = upcoming_heading.find_parent("section")
        if section:
            for row in section.find_all("div", class_="row", recursive=False):
                # Each row: icon col, text col
                text_div = row.find("div", class_=re.compile(r"col-(?:lg|md|sm|xs)-(?:9|10|12)"))
                if not text_div:
                    # Fallback: choose the div that contains the game links
                    for c in row.find_all("div", recursive=False):
                        if c.find("a", href=re.compile(r"TeamID=|/team/|team/index\.cfm", re.I)):
                            text_div = c
                            break
                if not text_div:
                    continue

                # Date is a text node, time/facility and matchup are child divs
                date_match = text_div.find(string=re.compile(r"[A-Za-z]+, [A-Za-z]+ \d+"))
                date = _text(date_match) if date_match else ""

                info_divs = text_div.find_all("div", recursive=False)
                # Filter out any nested row used just for the section heading
                info_divs = [d for d in info_divs if not d.find("h2")]

                gametime = ""
                facility = ""
                matchup = None
                for d in info_divs:
                    txt = _text(d)
                    if re.search(r"vs\.", txt):
                        matchup = d
                    elif re.match(r"\d{1,2}:\d{2}\s*(?:AM|PM)", txt, re.IGNORECASE):
                        m = re.match(r"(\d{1,2}:\d{2}\s*(?:AM|PM))\s*-\s*(.+)", txt, re.IGNORECASE)
                        gametime = m.group(1) if m else txt
                        facility = m.group(2).strip() if m else ""

                if not matchup:
                    continue
                links = matchup.find_all("a", href=True)
                home = _team_from_link(links[0]) if len(links) > 0 else {"name": "", "id": None}
                away = _team_from_link(links[1]) if len(links) > 1 else {"name": "", "id": None}
                upcoming.append({
                    "date": date,
                    "time": gametime,
                    "facility": facility,
                    "home": home["name"],
                    "home_id": home["id"],
                    "away": away["name"],
                    "away_id": away["id"],
                })

    recent_heading = soup.find(lambda t: t.name in ("h1", "h2") and "Recent Results" in t.get_text())
    if recent_heading:
        section = recent_heading.find_parent("section")
        if section:
            # Each game is a table with header having date/time and body with two rows
            for table in section.find_all("table", class_="table"):
                header = table.find("thead")
                if not header:
                    continue
                header_cells = header.find_all("th", recursive=False)
                header_text = _text(header_cells[0]) if len(header_cells) > 0 else ""
                m = re.match(r"([A-Za-z]+ \d+)\s*-\s*(\d{1,2}:\d{2}\s*(?:AM|PM))", header_text)
                date = m.group(1) if m else ""
                gametime = m.group(2) if m else ""

                rows = table.find("tbody").find_all("tr") if table.find("tbody") else []
                if len(rows) < 2:
                    continue
                home_link = rows[0].find("a", href=True)
                away_link = rows[1].find("a", href=True)
                home_cells = rows[0].find_all("td")
                away_cells = rows[1].find_all("td")

                def get_periods(cells):
                    vals = [_score_to_int(_text(c)) for c in cells[1:]]
                    # Last two may be F and F-SO; keep if short list
                    return vals

                home_vals = get_periods(home_cells)
                away_vals = get_periods(away_cells)

                # Final score: find last numeric value that is not zero? Use last cell text.
                home_final = _score_to_int(_text(home_cells[-1])) if home_cells else 0
                away_final = _score_to_int(_text(away_cells[-1])) if away_cells else 0

                recent.append({
                    "date": date,
                    "time": gametime,
                    "home": _text(home_link) if home_link else _text(home_cells[0]),
                    "home_id": _team_id(home_link["href"]) if home_link else None,
                    "away": _text(away_link) if away_link else _text(away_cells[0]),
                    "away_id": _team_id(away_link["href"]) if away_link else None,
                    "home_periods": home_vals,
                    "away_periods": away_vals,
                    "home_final": home_final,
                    "away_final": away_final,
                })

    # Playoffs — parse every round table (ROUND 1, ROUND 2, CHAMPIONSHIP, ...)
    playoffs = []
    for table in soup.find_all("table"):
        divider = table.find("th", colspan=re.compile(r"^\d+$"))
        if not divider or not re.search(r"ROUND|SEMI|FINAL|CHAMPIONSHIP", divider.get_text(), re.I):
            continue
        round_name = divider.get_text(strip=True)
        games = []
        tbody = table.find("tbody")
        for row in (tbody.find_all("tr") if tbody else []):
            cells = row.find_all("td")
            if len(cells) < 5:
                continue
            date = _text(cells[0])
            gametime = _text(cells[1])
            # Matchup rows only (date + time) — skips standings rows that bleed in
            if not re.search(r"[A-Za-z]+ \d+", date) or not re.match(r"\d{1,2}:\d{2}", gametime):
                continue
            home_link = cells[3].find("a", href=True)
            away_link = cells[4].find("a", href=True)
            home = _text(home_link) if home_link else _text(cells[3])
            away = _text(away_link) if away_link else _text(cells[4])
            # Optional 6th score column ("5 - 3") once a game is played
            home_score = away_score = None
            if len(cells) > 5:
                m = re.match(r"(\d+)\s*-\s*(\d+)", _text(cells[5]))
                if m:
                    home_score, away_score = int(m.group(1)), int(m.group(2))
            games.append({
                "date": date,
                "time": gametime,
                "facility": _text(cells[2]),
                "home": home,
                "home_id": _team_id(home_link["href"]) if home_link else None,
                "away": away,
                "away_id": _team_id(away_link["href"]) if away_link else None,
                "home_score": home_score,
                "away_score": away_score,
                "played": home_score is not None,
            })
        if games:
            playoffs.append({"round": round_name, "games": games})

    # Playoff qualifier note, e.g. "*The top 6 teams will qualify for playoffs*"
    playoff_cutoff = None
    m = re.search(r"top (\d+) teams? will qualify", soup.get_text(" ", strip=True), re.I)
    if m:
        playoff_cutoff = int(m.group(1))

    championship = extract_championship(playoffs, season, league_name)

    return {
        "league_name": league_name,
        "season": season,
        "standings": standings,
        "leaders": leaders,
        "upcoming": upcoming,
        "recent": recent,
        "playoffs": playoffs,
        "playoff_cutoff": playoff_cutoff,
        "championship": championship,
    }, None


def parse_team_overview(team_id):
    soup, err = get_soup("/team/?" + _resource_qs("TeamID", team_id))
    if err:
        return None, err

    h1 = soup.find("h1")
    team_name = _text(h1) if h1 else ""
    team_name_core = team_name.replace(" Hockey", "").strip()
    season = ""
    breadcrumb = soup.find("ol", class_="breadcrumb")
    if breadcrumb:
        season = _text(breadcrumb.find("li", class_="active") or breadcrumb.find("li"))

    def _team_or_self(cell, team_id):
        link = cell.find("a", href=True)
        if link:
            return _text(link), _team_id(link["href"])
        # The current team is shown in bold without a link.
        return _text(cell), team_id

    next_game = None
    next_heading = soup.find(lambda t: t.name in ("h2", "h3") and "Next Game" in t.get_text())
    if next_heading:
        container = next_heading.find_parent("div", class_="sidebar-post-item")
        if container:
            big = container.find("div", class_=re.compile(r"col-lg-10|col-md-9|col-sm-10|col-xs-12"))

            date = ""
            gametime = ""
            facility = ""
            opponent = ""
            opp_id = None

            if big:
                # Date is a text node; time/facility and matchup are child divs
                date_match = big.find(string=re.compile(r"[A-Za-z]+, [A-Za-z]+ \d+"))
                date = _text(date_match) if date_match else ""

                for d in big.find_all("div", recursive=False):
                    if d.find("h2") or d.find("h3"):
                        continue
                    txt = _text(d)
                    if re.search(r"vs\.", txt):
                        opp_link = d.find("a", href=True)
                        if opp_link:
                            opponent = _text(opp_link)
                            opp_id = _team_id(opp_link["href"])
                    else:
                        m = re.match(r"(\d{1,2}:\d{2}\s*(?:AM|PM))\s*-\s*(.+)", txt, re.IGNORECASE)
                        if m:
                            gametime = m.group(1)
                            facility = m.group(2).strip()

            home_away = "Away" if "we are away" in container.get_text(" ", strip=True).lower() else "Home"

            next_game = {
                "date": date,
                "time": gametime,
                "facility": facility,
                "opponent": opponent,
                "opponent_id": opp_id,
                "home_away": home_away,
            }

    recent = None
    recent_heading = soup.find(lambda t: t.name in ("h2", "h3") and "Recent Results" in t.get_text())
    if recent_heading:
        container = recent_heading.find_parent("div", class_="sidebar-post-item")
        if container:
            table = container.find("table")
        if table:
            rows = table.find("tbody").find_all("tr") if table.find("tbody") else []
            if len(rows) >= 2:
                hcells = rows[0].find_all("td")
                acells = rows[1].find_all("td")
                home, home_id = _team_or_self(hcells[0], team_id)
                away, away_id = _team_or_self(acells[0], team_id)
                home_vals = [_score_to_int(_text(c)) for c in hcells[1:]]
                away_vals = [_score_to_int(_text(c)) for c in acells[1:]]
                recent = {
                    "home": home,
                    "home_id": home_id,
                    "away": away,
                    "away_id": away_id,
                    "home_periods": home_vals,
                    "away_periods": away_vals,
                    "home_final": home_vals[-1] if home_vals else 0,
                    "away_final": away_vals[-1] if away_vals else 0,
                }

    # Team leaders points/goals/assists/pim
    team_leaders = {"points": [], "goals": [], "assists": [], "pim": []}
    leader_value_map = {
        "pts": ("points", "points"),
        "goals": ("goals", "goals"),
        "asst": ("assists", "assists"),
        "pim": ("pim", "pim"),
    }
    for table_id, (key, val_key) in leader_value_map.items():
        table = soup.find("table", {"id": table_id})
        if not table:
            continue
        rows = table.find("tbody").find_all("tr") if table.find("tbody") else []
        for row in rows:
            cells = row.find_all("td")
            if len(cells) < 2:
                continue
            team_leaders[key].append({
                "name": _text(cells[0]),
                val_key: _score_to_int(_text(cells[1])),
            })

    return {
        "team_name": team_name,
        "team_name_core": team_name_core,
        "season": season,
        "next_game": next_game,
        "recent_result": recent,
        "team_leaders": team_leaders,
    }, None


def parse_team_schedule(team_id, fresh=False):
    soup, err = get_soup("/team/schedule.cfm?" + _resource_qs("TeamID", team_id), fresh=fresh)
    if err:
        return None, err

    h1 = soup.find("h1")
    team_name = _text(h1) if h1 else ""
    team_name_core = team_name.replace(" Hockey", "").strip()

    games = []
    table = soup.find("table", class_=re.compile("table"))
    if table:
        rows = table.find("tbody").find_all("tr") if table.find("tbody") else []
        for row in rows:
            cells = row.find_all("td")
            if len(cells) < 7:
                continue
            date = _text(cells[0])
            gametime = _text(cells[1])
            facility = _text(cells[2])
            rink = _text(cells[3])

            def _is_current_team(name):
                # Accent/punct-insensitive exact match — substring matching causes
                # false positives (e.g. "Red" matching both "Red Wings" and "Red Sox")
                return _norm_team_name(name) == _norm_team_name(team_name_core)

            home_link = cells[4].find("a", href=True)
            away_link = cells[5].find("a", href=True)
            home = _text(home_link) if home_link else _text(cells[4])
            away = _text(away_link) if away_link else _text(cells[5])
            home_id = _team_id(home_link["href"]) if home_link else (team_id if _is_current_team(home) else None)
            away_id = _team_id(away_link["href"]) if away_link else (team_id if _is_current_team(away) else None)

            score_text = _text(cells[6])
            # Postponed/TBD placeholders must not count as played 0-0 games
            if score_text.strip().upper() in ("PPD", "TBD", "TBA", "-", ""):
                score_text = ""
            m = re.match(r"(\d+)\s*-\s*(\d+)", score_text)
            home_score = _score_to_int(m.group(1)) if m else 0
            away_score = _score_to_int(m.group(2)) if m else 0

            score_sheet = None
            if len(cells) > 7:
                ssa = cells[7].find("a", href=True)
                if ssa:
                    href = ssa["href"]
                    if href.startswith("../"):
                        href = href[3:]
                    if not href.startswith("http"):
                        href = BASE_URL + "/" + href.lstrip("/")
                    score_sheet = href

            games.append({
                "date": date,
                "time": gametime,
                "facility": facility,
                "rink": rink,
                "home": home,
                "home_id": home_id,
                "away": away,
                "away_id": away_id,
                "home_score": home_score,
                "away_score": away_score,
                "score_sheet": score_sheet,
                "played": bool(m),
            })

    return games, None


def _num(s):
    """Parse an int, falling back to float (e.g. GAA '2.4'), else 0."""
    s = (s or "").strip()
    try:
        return int(s)
    except ValueError:
        try:
            return float(s)
        except ValueError:
            return 0


def parse_team_stats(team_id, timeout=30):
    """Full roster: every stat table on the page, grouped by section heading.

    The stats page groups players into sections (e.g. an unlabeled skaters
    table, FORWARDS, DEFENSE) and a GOALIES table with W/L/OTL/GA/GAA.
    Returns {"sections": [{label, players}], "goalies": [...]}.
    """
    soup, err = get_soup("/team/stats.cfm?" + _resource_qs("TeamID", team_id), timeout=timeout)
    if err:
        return None, err

    result = {"sections": [], "goalies": []}
    current_label = None

    skater_cols = ["gp", "g", "a", "pts", "pim", "esg", "ppg", "shg", "psg", "sog"]
    goalie_cols = ["gp", "w", "l", "otl", "ga", "gaa"]

    for el in soup.find_all(["h2", "table"]):
        if el.name == "h2":
            txt = _text(el)
            if txt:
                current_label = txt
            continue

        thead = el.find("thead")
        if not thead:
            continue
        headers = [c.get_text(strip=True).lower() for c in thead.find_all("th")]
        if "jersey" not in headers or "gp" not in headers:
            continue  # skip unrelated tables (stick & puck / drop-in schedules)

        is_goalie = "gaa" in headers
        cols = goalie_cols if is_goalie else skater_cols
        tbody = el.find("tbody")
        rows = tbody.find_all("tr") if tbody else []

        for row in rows:
            cells = row.find_all("td")
            if len(cells) < 4:
                continue
            link = cells[1].find("a", href=True)
            token = None
            if link:
                q = link.get("href", "").split("?")[-1]
                if re.match(r"^[0-9A-Fa-f]+$", q):
                    token = q

            player = {
                "jersey": _text(cells[0]) or "-",
                "name": _text(link) if link else _text(cells[1]),
                "position": _text(cells[2]),
                "token": token,
            }
            for i, col in enumerate(cols, start=3):
                player[col] = _num(_text(cells[i])) if i < len(cells) else 0

            if is_goalie:
                result["goalies"].append(player)
            else:
                label = current_label or "Skaters"
                sec = next((s for s in result["sections"] if s["label"] == label), None)
                if not sec:
                    sec = {"label": label, "players": []}
                    result["sections"].append(sec)
                sec["players"].append(player)

    return result, None


def parse_team_standings(team_id):
    soup, err = get_soup("/team/standings.cfm?" + _resource_qs("TeamID", team_id))
    if err:
        return None, err

    h1 = soup.find("h1")
    team_name = _text(h1) if h1 else ""
    team_name_core = team_name.replace(" Hockey", "").strip()

    def _is_current_team(name):
        return _norm_team_name(name) == _norm_team_name(team_name_core)

    standings = []
    table = soup.find("table", class_=re.compile("table"))
    if table:
        rows = table.find("tbody").find_all("tr") if table.find("tbody") else []
        for row in rows:
            cells = row.find_all("td")
            if len(cells) < 8:
                continue
            team_link = cells[0].find("a", href=True)
            name = _text(team_link) if team_link else _text(cells[0])
            standings.append({
                "team": name,
                "team_id": _team_id(team_link["href"]) if team_link else (team_id if _is_current_team(name) else None),
                "gp": _score_to_int(_text(cells[1])),
                "w": _score_to_int(_text(cells[2])),
                "l": _score_to_int(_text(cells[3])),
                "otl": _score_to_int(_text(cells[4])),
                "pts": _score_to_int(_text(cells[5])),
                "gf": _score_to_int(_text(cells[6])),
                "ga": _score_to_int(_text(cells[7])),
            })

    return standings, None


def _parse_player_history_soup(soup):
    h1 = soup.find("h1")
    name = _text(h1) if h1 else ""

    history = []
    table = soup.find("table", {"id": "playerTable"})
    if table:
        rows = table.find("tbody").find_all("tr") if table.find("tbody") else []
        for row in rows:
            cells = row.find_all("td")
            if len(cells) < 11:
                continue
            team_link = cells[2].find("a", href=True)
            team_token = _query_token(team_link["href"]) if team_link else None
            season_sort = 0
            ds = cells[0].get("data-sort")
            if ds:
                try:
                    season_sort = int(str(ds).split(".")[0])
                except ValueError:
                    season_sort = 0
            history.append({
                "season": _text(cells[0]),
                "league": _text(cells[1]),
                "team": _text(cells[2]),
                "team_token": team_token,
                "season_sort": season_sort,
                "gp": _score_to_int(_text(cells[3])),
                "g": _score_to_int(_text(cells[4])),
                "a": _score_to_int(_text(cells[5])),
                "pts": _score_to_int(_text(cells[6])),
                "pim": _score_to_int(_text(cells[7])),
                "esg": _score_to_int(_text(cells[8])),
                "ppg": _score_to_int(_text(cells[9])),
                "shg": _score_to_int(_text(cells[10])) if len(cells) > 10 else 0,
                "psg": _score_to_int(_text(cells[11])) if len(cells) > 11 else 0,
                "sog": _score_to_int(_text(cells[12])) if len(cells) > 12 else 0,
            })

    return {"name": name, "history": history}


def parse_all_teams(max_workers=8, timeout=50):
    """Aggregate every team across all leagues (for global team search).

    Fetches each league dashboard in parallel and pulls teams from standings.
    Returns a list of {id, name, league_id, league_name}.
    Soft-times out so /api/teams always answers inside the function limit.
    """
    from concurrent.futures import ThreadPoolExecutor, wait, ALL_COMPLETED

    home, err = parse_homepage()
    if err:
        return None, err

    leagues = home.get("leagues", [])
    if not leagues:
        return None, "No leagues listed on the homepage"

    teams = {}
    errors = []

    def fetch(league):
        dash, e = parse_dashboard(league["id"])
        if e:
            errors.append(f"{league['name']}: {e}")
            return
        for s in dash.get("standings", []):
            tid = s.get("team_id")
            name = s.get("team", "").strip()
            if tid and name and tid not in teams:
                teams[tid] = {
                    "id": tid,
                    "name": name,
                    "league_id": league["id"],
                    "league_name": league["name"],
                }

    ex = ThreadPoolExecutor(max_workers=max_workers)
    futures = [ex.submit(fetch, league) for league in leagues]
    wait(futures, timeout=timeout, return_when=ALL_COMPLETED)
    ex.shutdown(wait=False, cancel_futures=True)

    if not teams and errors:
        return None, "; ".join(errors[:3])
    if not teams:
        return None, "No teams found (league standings empty or still loading)"

    # Sort alphabetically for stable UI
    return sorted(teams.values(), key=lambda t: t["name"].lower()), None


def _et_now():
    """Current time in America/New_York (games are ET; server clocks may be UTC)."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/New_York"))
    except Exception:
        return datetime.utcnow() - timedelta(hours=4)  # EDT fallback


def _md_label(dt):
    """Portable 'Aug 5' label (strftime %-d is POSIX-only)."""
    return dt.strftime("%b ") + str(dt.day)


def _game_start_et(time_str, now):
    m = re.match(r"(\d{1,2}):(\d{2})\s*(AM|PM)", time_str or "", re.IGNORECASE)
    if not m:
        return None
    hh = int(m.group(1)) % 12
    if m.group(3).upper() == "PM":
        hh += 12
    return now.replace(hour=hh, minute=int(m.group(2)), second=0, microsecond=0)


def classify_game_status(g, now=None):
    """upcoming | live | final. Beer-league ice slots are ~60-75 min.

    Finished games must not stay LIVE: scores from a team schedule are finals,
    and anything past ~85 minutes with a posted score (or ~100 min hard cap)
    is treated as final even if Recent Results still lists it.
    """
    now = now or _et_now()
    start = _game_start_et(g.get("time"), now)
    if g.get("is_final"):
        return "final"
    if start is None:
        return "final" if g.get("played") else "upcoming"
    mins = (now - start).total_seconds() / 60.0
    scored = bool(g.get("played")) and g.get("home_score") is not None
    if mins < -10:
        return "upcoming"
    if mins >= 100:
        return "final"
    if scored and mins >= 85:
        return "final"
    return "live"


def enrich_today_scores(home_data, max_workers=8, league_ids=None, timeout=None, fresh=False):
    """Fill scores for today's games.

    Primary source: league dashboard Recent Results, which update LIVE as
    scorekeepers enter goals (real-time scoring). Fallback: team schedule pages
    (finals only). Matches by today's date + both team IDs. Games that haven't
    started yet are left without scores. league_ids optionally scopes which
    dashboards to fetch (only leagues with games today); None = all leagues.
    fresh=True bypasses the HTML cache (used by /api/today/scores).
    """
    from concurrent import futures as cf

    games = home_data.get("today", [])
    if not games:
        return

    now = _et_now()
    today_label = _md_label(now)

    def game_started(g):
        start = _game_start_et(g.get("time"), now)
        if start is None:
            return True  # unknown time — don't block scores
        return now >= start

    started = [g for g in games if game_started(g)]

    def _attach(src_g, hs, as_, *, is_final=False):
        src_g["home_score"] = hs
        src_g["away_score"] = as_
        src_g["played"] = True
        if is_final:
            src_g["is_final"] = True

    # 1) Live source: recent results from dashboards of leagues with games today.
    # Soft-timed so the endpoint always answers; whatever completed gets matched.
    if league_ids is None:
        league_ids = {l["id"] for l in home_data.get("leagues", [])}
    dashboards = {}

    def fetch_dash(lid):
        d, e = parse_dashboard(lid, fresh=fresh)
        if not e:
            dashboards[lid] = d

    if started and league_ids:
        ex = cf.ThreadPoolExecutor(max_workers=max_workers)
        futs = [ex.submit(fetch_dash, lid) for lid in league_ids]
        done, pending = cf.wait(futs, timeout=timeout)
        ex.shutdown(wait=False, cancel_futures=True)

        for g in started:
            ids = {g.get("home_id"), g.get("away_id")}
            for d in dashboards.values():
                for r in d.get("recent", []):
                    if r.get("date") != today_label:
                        continue
                    if {r.get("home_id"), r.get("away_id")} == ids:
                        hs, as_ = r.get("home_final", 0), r.get("away_final", 0)
                        # Attach even 0-0 — Recent Results listing means scoring started.
                        _attach(g, hs, as_)
                        g["home_periods"] = r.get("home_periods")
                        g["away_periods"] = r.get("away_periods")
                        break

    # 2) Fallback for finals the dashboards don't cover: team schedule pages
    missing = [g for g in started if not g.get("played")]
    if missing:
        team_ids = {tid for g in missing for tid in (g.get("home_id"), g.get("away_id")) if tid}
        schedules = {}
        import threading as _threading
        sched_lock = _threading.Lock()

        def fetch(tid):
            sched, e = parse_team_schedule(tid, fresh=fresh)
            if not e and sched:
                with sched_lock:
                    schedules[tid] = sched

        # Soft-timed like phase 1 — `list(ex.map(...))` joined every worker
        # with no cap, so one slow wave of schedule pages could stall the
        # whole scores endpoint past Vercel's function limit.
        phase2_timeout = min(timeout, 25) if timeout else 25
        ex = cf.ThreadPoolExecutor(max_workers=max_workers)
        futs = [ex.submit(fetch, tid) for tid in team_ids]
        cf.wait(futs, timeout=phase2_timeout)
        ex.shutdown(wait=False, cancel_futures=True)
        with sched_lock:
            schedules_snapshot = dict(schedules)

        for g in missing:
            for tid in (g.get("home_id"), g.get("away_id")):
                for sch in schedules_snapshot.get(tid, []):
                    if sch["date"] != today_label or not sch.get("played"):
                        continue
                    if {sch.get("home_id"), sch.get("away_id")} == ids_of(g):
                        _attach(g, sch["home_score"], sch["away_score"], is_final=True)
                        break

    for g in games:
        g["status"] = classify_game_status(g, now)


def ids_of(g):
    return {g.get("home_id"), g.get("away_id")}


def _normalize_session_date(s):
    """'Monday, August 10' -> 'Aug 10' (matches schedule-page date labels)."""
    s = (s or "").strip()
    for fmt in ("%A, %B %d", "%B %d", "%b %d"):
        try:
            return datetime.strptime(s, fmt).strftime("%b %-d")
        except ValueError:
            continue
    return s


def _dedupe_name(nm):
    """Score-sheet name cells repeat the name twice concatenated, optionally with a
    captain letter suffix: 'Austin GrycaAustin Gryca', 'Gianni EvangelistiGianni EvangelistiC'."""
    nm = nm.strip()
    n = len(nm)
    for k in range(n // 2, 1, -1):
        if nm[:k] == nm[k:2 * k]:
            rest = nm[2 * k:]
            if not rest or (len(rest) == 1 and rest.isalpha()):
                return nm[:k]
    return nm


def parse_score_sheet(path):
    """Parse a scoresheet_new.cfm page.

    Returns {"roster": {jersey: full_name},
             "goals": [{team, scorer_jersey, assists:[jersey...], strength, time}],
             "penalties": [{team, player_jersey, infraction, length, time}]}
    """
    soup, err = get_soup(path)
    if err:
        return None, err

    roster = {}
    goals = []
    penalties = []

    for table in soup.find_all("table"):
        headers = [c.get_text(strip=True) for c in table.find_all("th")]
        if headers[:2] == ["#", "Name"]:
            for row in table.find_all("tr"):
                cells = row.find_all("td")
                if len(cells) < 2:
                    continue
                num = _text(cells[0])
                if not num.isdigit():
                    continue
                a = cells[1].find("a")
                nm = _dedupe_name(_text(a) if a else _text(cells[1]))
                roster[num] = nm
        elif headers[:3] == ["P", "Team", "Goal"]:
            for row in table.find_all("tr"):
                cells = row.find_all("td")
                if len(cells) < 6:
                    continue
                scorer = _text(cells[2])  # "25 - Evangelisti"
                assists_raw = _text(cells[3])  # "3 - Breslin" or "3 - Breslin, 24 - Steranko"
                scorer_jersey = scorer.split("-")[0].strip() if "-" in scorer else ""
                assists = [a.split("-")[0].strip() for a in assists_raw.split(",") if "-" in a]
                goals.append({
                    "team": _text(cells[1]),
                    "scorer_jersey": scorer_jersey,
                    "assists": assists,
                    "strength": _text(cells[4]),
                    "time": _text(cells[5]),
                })
        elif headers[:3] == ["P", "Team", "Player"]:
            for row in table.find_all("tr"):
                cells = row.find_all("td")
                if len(cells) < 6:
                    continue
                player = _text(cells[2])
                penalties.append({
                    "team": _text(cells[1]),
                    "player_jersey": player.split("-")[0].strip() if "-" in player else "",
                    "infraction": _text(cells[3]),
                    "length": _text(cells[4]),
                    "time": _text(cells[5]),
                })

    return {"roster": roster, "goals": goals, "penalties": penalties}, None


def compute_player_game_log(schedule, player_name, team_name, max_workers=8):
    """Build a per-game log for one player from score sheets.

    schedule: entries from parse_team_schedule (has date, opponent context, score_sheet).
    player_name / team_name: strings to match. Returns a list of game entries,
    oldest first, with g/a/pts/pim/strengths per game.
    """
    from concurrent.futures import ThreadPoolExecutor

    target = player_name.lower().strip()
    surname = target.split()[-1] if target else ""
    entries = []

    def fetch(game):
        sheet = game.get("score_sheet")
        if not sheet or not game.get("played"):
            return
        path = sheet.replace(BASE_URL, "")
        data, e = parse_score_sheet(path)
        if e or not data:
            return
        roster = data["roster"]
        g = a = pim = 0
        esg = ppg = shg = other = 0

        exact_names = {(nm or "").lower().strip() for nm in roster.values()}
        has_exact_anchor = target in exact_names

        def name_matches(nm):
            n = (nm or "").lower().strip()
            if not n:
                return False
            if n == target:
                return True
            # Surname fallback only when the sheet has no exact-name anchor
            # (prevents matching same-surname teammates, e.g. the Evangelistis)
            return (not has_exact_anchor) and bool(surname) and n.endswith(surname)

        def jersey_of(person_jersey):
            return name_matches(roster.get(person_jersey, ""))

        # Dressed = appears on either roster table in the sheet
        dressed = any(name_matches(nm) for nm in roster.values())

        for goal in data["goals"]:
            if goal["team"].lower().strip() != team_name.lower().strip():
                continue
            if goal["scorer_jersey"] and jersey_of(goal["scorer_jersey"]):
                g += 1
                s = goal["strength"].lower()
                if "pp" in s or "power" in s:
                    ppg += 1
                elif "sh" in s or "short" in s:
                    shg += 1
                elif "even" in s:
                    esg += 1
                else:
                    other += 1
            for aj in goal["assists"]:
                if aj and jersey_of(aj):
                    a += 1

        for pen in data["penalties"]:
            if pen["team"].lower().strip() != team_name.lower().strip():
                continue
            if pen["player_jersey"] and jersey_of(pen["player_jersey"]):
                m = re.match(r"(\d+)", pen["length"])
                pim += int(m.group(1)) if m else 2

        # Include every game the player dressed for (even scoreless ones)
        if dressed or g or a or pim:
            is_home = game.get("home_id") and game.get("home", "").lower().strip() == team_name.lower().strip()
            us = game["home_score"] if is_home else game["away_score"]
            them = game["away_score"] if is_home else game["home_score"]
            res = "W" if us > them else ("L" if us < them else "T")
            entries.append({
                "date": game["date"],
                "opponent": game["away"] if is_home else game["home"],
                "home_away": "vs" if is_home else "@",
                "result": res,
                "score": f"{us}-{them}",
                "g": g,
                "a": a,
                "pts": g + a,
                "pim": pim,
                "esg": esg,
                "ppg": ppg,
                "shg": shg,
            })

    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        list(ex.map(fetch, schedule))

    return entries, None


def parse_league_sessions(league_id, max_workers=8):
    """Aggregate every game in a league's season, grouped by date ("session").

    Each team's schedule page lists the same games, so we dedupe by
    (date, time, home, away, facility). The schedule pages only cover games
    up to now, so future games are merged in from the dashboard's Upcoming
    section. Returns sessions in chronological order.
    """
    from concurrent.futures import ThreadPoolExecutor

    dash, err = parse_dashboard(league_id)
    if err:
        return None, err

    team_ids = [s["team_id"] for s in dash.get("standings", []) if s.get("team_id")]
    games = {}
    errors = []

    def fetch(tid):
        sched, e = parse_team_schedule(tid)
        if e:
            errors.append(e)
            return
        for g in sched:
            # Facility included: simultaneous games at different rinks must not collide
            key = (g["date"], g["time"], g["home"].strip().lower(), g["away"].strip().lower(),
                   (g.get("facility") or "").strip().lower())
            if key not in games:
                games[key] = g

    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        list(ex.map(fetch, team_ids))

    # Schedule pages only run up to now — merge future games from the
    # dashboard's Upcoming Games section (playoffs, next game nights).
    for g in dash.get("upcoming", []):
        norm = _normalize_session_date(g.get("date", ""))
        if not norm:
            continue
        key = (norm, g["time"], g["home"].strip().lower(), g["away"].strip().lower(),
               (g.get("facility") or "").strip().lower())
        if key not in games:
            games[key] = {
                "date": norm,
                "time": g["time"],
                "facility": g.get("facility", ""),
                "rink": "",
                "home": g["home"],
                "home_id": g.get("home_id"),
                "away": g["away"],
                "away_id": g.get("away_id"),
                "home_score": 0,
                "away_score": 0,
                "score_sheet": None,
                "played": False,
            }

    if not games and errors:
        return None, "; ".join(errors[:3])

    def game_date(g):
        try:
            d = datetime.strptime(f"{g['date']} {datetime.now().year}", "%b %d %Y")
            # If a parsed date lands far in the future, it belongs to last year
            if (d - datetime.now()).days > 200:
                d = d.replace(year=d.year - 1)
            return d
        except Exception:
            return datetime.min

    by_date = {}
    for g in sorted(games.values(), key=game_date):
        by_date.setdefault(g["date"], []).append(g)

    sessions = [{"date": date, "games": gs} for date, gs in by_date.items()]

    return {
        "league_name": dash.get("league_name", ""),
        "season": dash.get("season", ""),
        "sessions": sessions,
        "playoff_cutoff": dash.get("playoff_cutoff"),
    }, None


def compute_playoff_race(standings, total_games, cutoff=None):
    """Magic numbers: clinch/alive/needs-help/eliminated status per team.

    standings: display-ordered rows with team_id, gp, pts (pts desc as shown).
    total_games: scheduled regular-season games per team (balanced leagues).
    cutoff: qualifiers (from the league's qualifier note), default 4.
    Returns {team_id: {status, magic, remaining}} keyed by team_id.
    """
    if not standings:
        return {}
    cutoff = cutoff or 4
    cutoff = min(cutoff, len(standings))

    ordered = list(standings)
    last_in = ordered[cutoff - 1]
    first_out = ordered[cutoff] if cutoff < len(ordered) else None

    race = {}
    for s in ordered:
        tid = s.get("team_id")
        if not tid:
            continue
        remaining = max(0, total_games - s.get("gp", 0))
        pts = s.get("pts", 0)
        max_possible = pts + 2 * remaining

        if remaining == 0:
            status, magic = "playoffs", 0
        elif first_out is None:
            status, magic = "clinched", 0
        else:
            out_max = first_out.get("pts", 0) + 2 * max(0, total_games - first_out.get("gp", 0))
            if pts > out_max:
                status, magic = "clinched", 0
            elif max_possible < last_in.get("pts", 0):
                status, magic = "eliminated", 0
            else:
                magic = max(0, out_max + 1 - pts)
                status = "alive" if magic <= 2 * remaining else "help"
        race[tid] = {"status": status, "magic": magic, "remaining": remaining}

    return race


def compute_team_form(games, team_id, standings_row=None):
    """Derive a team's season record, form, and streaks from its schedule.

    The schedule page is already in chronological order, so played games in
    list order == game order. Results are from the team's perspective.

    Overtime losses matter in hockey: the standings table is authoritative for
    W/L/OTL (points = 2*W + OTL). Final scores alone can't distinguish an OT
    loss from a regulation loss, so we reconcile: mark 1-goal-margin losses as
    OT losses until the count matches the standings OTL total. If no standings
    row is supplied, records fall back to pure score-derived counts.
    """
    results = []
    timeline = []
    gf = ga = 0
    split = {"H": {"w": 0, "l": 0, "otl": 0}, "A": {"w": 0, "l": 0, "otl": 0}}

    for g in games:
        if not g.get("played"):
            continue
        if g.get("home_id") == team_id:
            us, them, loc, opp = g["home_score"], g["away_score"], "H", g.get("away", "")
        elif g.get("away_id") == team_id:
            us, them, loc, opp = g["away_score"], g["home_score"], "A", g.get("home", "")
        else:
            continue

        if us > them:
            res = "W"
            split[loc]["w"] += 1
        elif us < them:
            res = "L"
            split[loc]["l"] += 1
        else:
            res = "T"

        results.append(res)
        timeline.append({
            "result": res,
            "score": f"{us}-{them}",
            "margin": abs(us - them),
            "location": loc,
            "opponent": opp,
            "date": g.get("date", ""),
        })
        gf += us
        ga += them

    # Reconcile OTL against the authoritative standings row
    otl_total = (standings_row or {}).get("otl", 0)
    if otl_total:
        loss_idx = [i for i, r in enumerate(results) if r == "L"]
        # OT games are always decided by one goal — prefer 1-goal losses
        loss_idx.sort(key=lambda i: (timeline[i]["margin"], i))
        for i in loss_idx[: max(0, min(otl_total, len(loss_idx)))]:
            results[i] = "OTL"
            timeline[i]["result"] = "OTL"
            loc = timeline[i]["location"]
            split[loc]["l"] -= 1
            split[loc]["otl"] += 1

    if standings_row:
        wins = standings_row.get("w", results.count("W"))
        losses = standings_row.get("l", results.count("L"))
        otl = otl_total
    else:
        wins = results.count("W")
        losses = results.count("L")
        otl = results.count("OTL")
    ties = results.count("T")
    played = wins + losses + otl + ties
    points = (standings_row or {}).get("pts", 2 * wins + otl + ties)
    pts_pct = round(points / (2 * played), 3) if played else 0

    streak_type = streak_len = None
    if results:
        streak_type = results[-1]
        streak_len = 0
        for r in reversed(results):
            if r == streak_type:
                streak_len += 1
            else:
                break

    def _split_rec(s):
        return f"{s['w']}-{s['l']}-{s['otl']}" if s["otl"] else f"{s['w']}-{s['l']}"

    return {
        "played": played,
        "wins": wins,
        "losses": losses,
        "otl": otl,
        "ties": ties,
        "record": f"{wins}-{losses}-{otl}",
        "points": points,
        "pts_pct": pts_pct,
        "win_pct": round(wins / played, 3) if played else 0,
        "gf": gf,
        "ga": ga,
        "goal_diff": gf - ga,
        "home_record": _split_rec(split["H"]),
        "away_record": _split_rec(split["A"]),
        "form": results[-5:],
        "streak": f"{streak_type}{streak_len}" if streak_type else "",
        "timeline": timeline,
    }


def parse_player_history(team_id, player_id):
    if _is_opaque_id(player_id):
        soup, err = get_soup("/team/player_history.cfm?" + player_id)
    else:
        soup, err = get_soup(f"/team/player_history.cfm?TeamID={team_id}&PlayerID={player_id}")
    if err:
        return None, err
    return _parse_player_history_soup(soup), None


def parse_player_history_by_token(token):
    soup, err = get_soup(f"/team/player_history.cfm?{token}")
    if err:
        return None, err
    return _parse_player_history_soup(soup), None


def parse_team_playoff_results(team_id):
    """Playoff games from a team schedule page (historical tokens work).

    Result W/L/T is from this team's perspective (ChillerStats last column).
    Returns [] when the source has no Playoff Schedule table.
    """
    soup, err = get_soup("/team/schedule.cfm?" + _resource_qs("TeamID", team_id))
    if err:
        return [], err

    heading = soup.find(lambda t: t.name in ("h2", "h3") and "Playoff" in t.get_text())
    if not heading:
        return [], None
    table = heading.find_next("table")
    if not table:
        return [], None

    games = []
    tbody = table.find("tbody")
    rows = tbody.find_all("tr") if tbody else []
    for row in rows:
        cells = row.find_all("td")
        if len(cells) < 7:
            continue
        score_text = _text(cells[6])
        result = _text(cells[7]).strip().upper() if len(cells) > 7 else ""
        if result not in ("W", "L", "T", "OTL"):
            result = ""
        m = re.match(r"(\d+)\s*-\s*(\d+)", score_text)
        games.append({
            "date": _text(cells[0]),
            "time": _text(cells[1]),
            "facility": _text(cells[2]),
            "home": _text(cells[4]),
            "away": _text(cells[5]),
            "home_score": int(m.group(1)) if m else None,
            "away_score": int(m.group(2)) if m else None,
            "result": result,
            "played": bool(result) or bool(m),
        })
    return games, None


def parse_team_history(team_id, timeout=18):
    """Previous-session records + championship/1st-place awards for a team.

    Source: current roster player_history.cfm rows whose TEAM matches this
    club, then that session's team standings.cfm (W/L/OTL) and schedule
    playoff table. Never invents 0-0-0 placeholders.
    """
    from concurrent.futures import ThreadPoolExecutor, wait as _wait

    over, e1 = parse_team_overview(team_id)
    if e1:
        return None, e1
    roster, e2 = parse_team_stats(team_id)
    if e2:
        return None, e2

    team_name = (over or {}).get("team_name_core") or (over or {}).get("team_name") or ""
    want = _norm_team_name(team_name)

    tokens = []
    seen = set()
    for sec in (roster or {}).get("sections", []):
        for p in sec.get("players", []):
            tok = p.get("token")
            if tok and tok not in seen:
                seen.add(tok)
                tokens.append(tok)
    for g in (roster or {}).get("goalies", []):
        tok = g.get("token")
        if tok and tok not in seen:
            seen.add(tok)
            tokens.append(tok)

    histories = []

    def fetch_hist(tok):
        data, err = parse_player_history_by_token(tok)
        if not err and data:
            return data
        return None

    if tokens:
        ex = ThreadPoolExecutor(max_workers=8)
        futs = [ex.submit(fetch_hist, tok) for tok in tokens]
        done, _pending = _wait(futs, timeout=max(6, timeout * 0.55))
        for f in done:
            try:
                data = f.result()
            except Exception:
                continue
            if data:
                histories.append(data)
        ex.shutdown(wait=False, cancel_futures=True)

    seasons = {}
    for hist in histories:
        for row in hist.get("history") or []:
            if _norm_team_name(row.get("team")) != want:
                continue
            season = (row.get("season") or "").strip()
            league = (row.get("league") or "").strip()
            if not season:
                continue
            key = (season, league)
            prev = seasons.get(key)
            token = row.get("team_token")
            sort = row.get("season_sort") or 0
            if not prev or (token and not prev.get("team_token")):
                seasons[key] = {
                    "season": season,
                    "league": league,
                    "team_token": token,
                    "season_sort": sort,
                }
            elif sort and sort > prev.get("season_sort", 0):
                prev["season_sort"] = sort

    current_stand, _ = parse_team_standings(team_id)
    current_row = None
    if current_stand:
        current_row = next((s for s in current_stand if s.get("team_id") == team_id), None)
        if not current_row:
            current_row = next(
                (s for s in current_stand if _norm_team_name(s.get("team")) == want),
                None,
            )

    def _same_record(a, b):
        if not a or not b:
            return False
        return (a.get("gp"), a.get("w"), a.get("l"), a.get("otl"), a.get("pts")) == (
            b.get("gp"), b.get("w"), b.get("l"), b.get("otl"), b.get("pts"),
        )

    items = [s for s in seasons.values() if s.get("team_token")]
    records = []
    awards = []

    def fetch_season(item):
        rec_out = None
        award_list = []
        tok = item["team_token"]
        stand, _e_s = parse_team_standings(tok)
        playoffs, _e_p = parse_team_playoff_results(tok)
        row = None
        rank = None
        if stand:
            for i, s in enumerate(stand, 1):
                if _norm_team_name(s.get("team")) == want:
                    row = s
                    rank = i
                    break
        # Skip unpublished / empty sessions (do not emit fake 0-0-0).
        if not row or not row.get("gp"):
            return None, []
        rec = {
            "season": item["season"],
            "league": item["league"],
            "gp": row.get("gp", 0),
            "w": row.get("w", 0),
            "l": row.get("l", 0),
            "otl": row.get("otl", 0),
            "pts": row.get("pts", 0),
            "gf": row.get("gf", 0),
            "ga": row.get("ga", 0),
            "rank": rank,
            "teams": len(stand) if stand else None,
            "record": f"{row.get('w', 0)}-{row.get('l', 0)}-{row.get('otl', 0)}",
            "is_current": _same_record(row, current_row),
            "season_sort": item.get("season_sort") or 0,
        }
        playoffs = playoffs or []
        played_po = [g for g in playoffs if g.get("played")]
        rec["playoff_games"] = len(played_po)
        rec["playoff_record"] = None
        if played_po:
            pw = sum(1 for g in played_po if g.get("result") == "W")
            pl = sum(1 for g in played_po if g.get("result") == "L")
            pt = sum(1 for g in played_po if g.get("result") in ("T", "OTL"))
            rec["playoff_record"] = f"{pw}-{pl}-{pt}" if pt else f"{pw}-{pl}"
        complete = bool(playoffs) and all(g.get("played") for g in playoffs)
        last = played_po[-1] if played_po else None
        champion = bool(complete and last and last.get("result") == "W")
        first_place = rank == 1
        rec["champion"] = champion
        rec["first_place"] = first_place
        rec_out = rec
        if champion:
            last_opp = None
            score = None
            if last:
                hs, aws = last.get("home_score"), last.get("away_score")
                if _norm_team_name(last.get("home")) == want:
                    last_opp = last.get("away")
                    if hs is not None and aws is not None:
                        score = f"{hs}-{aws}"
                else:
                    last_opp = last.get("home")
                    if hs is not None and aws is not None:
                        score = f"{aws}-{hs}"
            award_list.append({
                "kind": "champion",
                "title": "Session champion",
                "season": item["season"],
                "league": item["league"],
                "source": "playoff",
                "detail": (
                    f"Won final playoff game vs {last_opp}"
                    if last_opp else "Won the session playoff"
                ),
                "score": score,
            })
        if first_place:
            award_list.append({
                "kind": "first_place",
                "title": "1st place",
                "season": item["season"],
                "league": item["league"],
                "source": "standings",
                "detail": f"Finished 1st of {len(stand)} in regular-season standings",
                "score": None,
            })
        return rec_out, award_list

    if items:
        remain = max(4, timeout * 0.4)
        ex = ThreadPoolExecutor(max_workers=6)
        futs = [ex.submit(fetch_season, it) for it in items]
        done, _pending = _wait(futs, timeout=remain)
        for f in done:
            try:
                rec, award_list = f.result()
            except Exception:
                continue
            if rec:
                records.append(rec)
            if award_list:
                awards.extend(award_list)
        ex.shutdown(wait=False, cancel_futures=True)

    records.sort(key=lambda r: r.get("season_sort") or 0, reverse=True)
    seen_aw = set()
    uniq_awards = []
    for a in awards:
        k = (a.get("kind"), a.get("season"), a.get("league"))
        if k in seen_aw:
            continue
        seen_aw.add(k)
        uniq_awards.append(a)
    uniq_awards.sort(key=lambda a: a.get("season") or "", reverse=True)

    previous = [r for r in records if not r.get("is_current")]
    return {
        "team_name": team_name,
        "previous": previous,
        "sessions": records,
        "awards": uniq_awards,
        "partial": bool(tokens) and len(histories) < len(tokens),
    }, None


def extract_championship(playoffs, season="", league_name=""):
    """Champion only from a played CHAMPIONSHIP/FINAL game. Never invent a title."""
    if not playoffs:
        return None
    champ_round = None
    for rnd in playoffs:
        name = rnd.get("round") or ""
        if re.search(r"CHAMPIONSHIP", name, re.I):
            champ_round = rnd
            break
    if champ_round is None:
        for rnd in playoffs:
            name = rnd.get("round") or ""
            if re.search(r"\bFINAL\b", name, re.I) and not re.search(r"SEMI", name, re.I):
                champ_round = rnd
    if not champ_round:
        return None
    played = [g for g in champ_round.get("games") or [] if g.get("played")
              and g.get("home_score") is not None and g.get("away_score") is not None]
    if not played:
        return None
    g = played[-1]
    hs, aws = g["home_score"], g["away_score"]
    if hs == aws:
        return None
    if hs > aws:
        winner, winner_id, loser = g.get("home"), g.get("home_id"), g.get("away")
    else:
        winner, winner_id, loser = g.get("away"), g.get("away_id"), g.get("home")
    session = (season or "").strip()
    league = (league_name or "").strip()
    title_bits = [b for b in (session, league, "Champion") if b]
    return {
        "session": session,
        "league": league,
        "title": " ".join(title_bits),
        "winner": winner,
        "winner_id": winner_id,
        "opponent": loser,
        "score": f"{hs}-{aws}",
        "date": g.get("date") or "",
        "round": champ_round.get("round") or "Championship",
    }


def awards_for_team(team_id, team_name, championship, roster=None):
    """Badge if this team won the published championship. No invented trophies."""
    awards = []
    if not championship:
        return awards
    tid = str(team_id or "")
    win_id = str(championship.get("winner_id") or "")
    win_name = _norm_team_name(championship.get("winner") or "")
    us = _norm_team_name((team_name or "").replace(" Hockey", ""))
    team_won = bool(tid and win_id and tid == win_id) or (bool(us) and us == win_name)
    if team_won:
        awards.append({
            "kind": "champion",
            "title": championship.get("title") or "Session champion",
            "session": championship.get("session") or "",
            "detail": championship.get("score") or "",
        })
    return awards


def _index_player(team, p, position):
    return {
        "name": p.get("name") or "",
        "team": team.get("name") or "",
        "team_id": team.get("id"),
        "league_id": team.get("league_id"),
        "league_name": team.get("league_name") or "",
        "position": p.get("position") or position or "",
        "jersey": p.get("jersey", "-"),
        "token": p.get("token"),
        "player_id": p.get("token") or p.get("player_id"),
        "gp": p.get("gp", 0),
        "g": p.get("g", 0),
        "a": p.get("a", 0),
        "pts": p.get("pts", 0),
        "pim": p.get("pim", 0),
        "w": p.get("w", 0),
        "l": p.get("l", 0),
        "otl": p.get("otl", 0),
        "ga": p.get("ga", 0),
        "gaa": p.get("gaa", 0),
    }


def index_roster(team, roster, dest):
    if not roster:
        return
    for sec in roster.get("sections") or []:
        for p in sec.get("players") or []:
            if not p.get("name"):
                continue
            key = f"{p['name'].lower()}|{team['id']}"
            dest[key] = _index_player(team, p, sec.get("label") or "")
    for g in roster.get("goalies") or []:
        if not g.get("name"):
            continue
        key = f"{g['name'].lower()}|{team['id']}"
        dest[key] = _index_player(team, g, "Goalie")


def _name_matches_query(name, team, q):
    n = (name or "").lower()
    t = (team or "").lower()
    return q in n or q in t


def search_players(query, teams, timeout=32, max_workers=24):
    """Find players by name without waiting for a full roster fan-out.

    Returns (hits, partial, indexed_all, error).
    """
    from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED

    q = (query or "").strip().lower()
    if len(q) < 2:
        return [], False, {}, None
    if not teams:
        return [], False, {}, "No teams to search"

    index = {}
    errors = []
    lock = __import__("threading").Lock()

    try:
        leaders, lerr = parse_all_leaders()
        if not lerr and leaders:
            for key in ("points", "goals", "assists"):
                for row in leaders.get(key) or []:
                    team = {
                        "id": row.get("team_id"),
                        "name": row.get("team") or "",
                        "league_id": None,
                        "league_name": "",
                    }
                    if not row.get("name") or not team["id"]:
                        continue
                    p = {
                        "name": row["name"],
                        "token": row.get("player_id") if _is_opaque_id(row.get("player_id")) else None,
                        "player_id": row.get("player_id"),
                        "gp": 0,
                        "g": row.get("goals", 0) if key == "goals" else 0,
                        "a": row.get("assists", 0) if key == "assists" else 0,
                        "pts": row.get("points", 0) if key == "points" else 0,
                        "pim": 0, "jersey": "-", "position": "",
                    }
                    k = f"{p['name'].lower()}|{team['id']}"
                    if k not in index:
                        entry = _index_player(team, p, "")
                        entry["player_id"] = row.get("player_id")
                        if _is_opaque_id(row.get("player_id")):
                            entry["token"] = row.get("player_id")
                        index[k] = entry
                    else:
                        if key == "points":
                            index[k]["pts"] = row.get("points", index[k].get("pts", 0))
                        elif key == "goals":
                            index[k]["g"] = row.get("goals", index[k].get("g", 0))
                        elif key == "assists":
                            index[k]["a"] = row.get("assists", index[k].get("a", 0))
    except Exception as ex:
        errors.append(str(ex))

    def fetch(team):
        try:
            roster, e = parse_team_stats(team["id"], timeout=6)
        except Exception as ex:
            with lock:
                errors.append(str(ex))
            return
        if e:
            with lock:
                errors.append(e)
            return
        with lock:
            index_roster(team, roster, index)

    named_ids = {tm["id"] for tm in teams if q in (tm.get("name") or "").lower()}
    ordered = [tm for tm in teams if tm["id"] in named_ids] + [tm for tm in teams if tm["id"] not in named_ids]
    specific = len(q.split()) >= 2

    ex = ThreadPoolExecutor(max_workers=max_workers)
    pending = set(ex.submit(fetch, tm) for tm in ordered)
    deadline = time.time() + timeout
    extra_until = None
    try:
        while pending and time.time() < deadline:
            remain = deadline - time.time()
            if extra_until is not None:
                remain = min(remain, extra_until - time.time())
                if remain <= 0:
                    break
            done, pending = wait(pending, timeout=max(0.15, remain), return_when=FIRST_COMPLETED)
            # Workers mutate `index` concurrently — iterate a snapshot under the
            # lock or CPython raises "dictionary changed size during iteration".
            with lock:
                hits_now = [
                    p for p in list(index.values())
                    if _name_matches_query(p.get("name"), p.get("team"), q)
                ]
            if specific and hits_now:
                if extra_until is None:
                    extra_until = time.time() + 2.2
            elif hits_now:
                # Some hits already exist: give a short grace window to collect
                # a few more rosters, then answer — don't scan all ~60 teams.
                if extra_until is None:
                    extra_until = time.time() + 0.8
            if named_ids and hits_now and not specific:
                extra_until = time.time() + 0.4
        complete = not pending
    finally:
        ex.shutdown(wait=False, cancel_futures=True)

    with lock:
        hits = [
            p for p in list(index.values())
            if _name_matches_query(p.get("name"), p.get("team"), q)
        ]
    hits.sort(key=lambda p: p["name"].lower())
    err = None
    if not index and errors:
        err = "; ".join(errors[:3])
    return hits, (not complete), index, err
