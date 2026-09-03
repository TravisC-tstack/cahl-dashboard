"""CAHL cache-warming cron script.

Runs every 30 minutes via GitHub Actions. Decides what to do based on whether
a game is currently active (started in the last ~2.5h or starting within 30 min):

- Game active  -> refresh (this is the every-30-minutes path, for live scoring)
- No game      -> refresh only on the ~hourly baseline run (the :00 half of the
                  half-hourly schedule), keeping scrape volume low

The refresh is scoped to "scores": it clears page-level scrape caches and then
re-warms only the light endpoints (homepage w/ live scores + leaders). The big
aggregates (7k-player index, team index) are intentionally left alone — they
have their own long TTLs and on-demand rebuilds.
"""

import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta

try:
    from zoneinfo import ZoneInfo

    ET = ZoneInfo("America/New_York")  # CAHL games are in Columbus, OH
except Exception:  # very old python / missing tzdata
    ET = None

BASE = os.environ.get("BASE_URL", "https://cahl.neural-forge.io")
ACTIVE_BEFORE_MIN = 30   # treat games starting within 30 min as active
ACTIVE_AFTER_MIN = 150   # and for ~2.5h after puck drop


def get(path, timeout=90):
    req = urllib.request.Request(BASE + path, headers={"User-Agent": "cahl-cron/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def post(path):
    req = urllib.request.Request(BASE + path, method="POST", headers={"User-Agent": "cahl-cron/1.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.status


def game_minutes(t):
    """'7:10 PM' -> minutes since midnight (ET)."""
    m = re.match(r"(\d{1,2}):(\d{2})\s*(AM|PM)", t or "", re.IGNORECASE)
    if not m:
        return None
    hh = int(m.group(1)) % 12
    if m.group(3).upper() == "PM":
        hh += 12
    return hh * 60 + int(m.group(2))


def main():
    now = datetime.now(ET) if ET else datetime.utcnow() - timedelta(hours=4)
    now_min = now.hour * 60 + now.minute

    data = get("/api/today")
    games = data.get("today", [])

    active = False
    for g in games:
        m = game_minutes(g.get("time"))
        if m is not None and (m - ACTIVE_BEFORE_MIN) <= now_min <= (m + ACTIVE_AFTER_MIN):
            active = True
            break

    # The cron fires every 30 min (~:00 and ~:30 + jitter). The ~:00 run is the
    # hourly baseline; the ~:30 run only fires when a game is active.
    baseline_due = (now_min % 60) < 30

    if not active and not baseline_due:
        print(f"no active game & not baseline (ET {now:%Y-%m-%d %H:%M}) - skipping")
        return

    print(
        f"refreshing caches (active={active}, baseline_due={baseline_due}, "
        f"ET {now:%H:%M}, games today={len(games)})"
    )

    post("/api/refresh?scope=scores")

    warm = ["/api/today", "/api/leaders"]
    if active:
        warm.append("/api/today/scores")  # keep the live-scores path warm too
    if baseline_due:
        # Rebuild the all-players index hourly so name search answers instantly
        # instead of re-scraping every roster on Vercel's next cold start.
        # full=1 extends the server's fan-out window past the UI's 18s soft cap.
        warm.append("/api/players?full=1")
    for path in warm:
        t0 = datetime.now()
        try:
            # /api/players fans out to every roster and can run minutes cold;
            # give it headroom so the hourly warm actually completes.
            get(path, timeout=420 if path == "/api/players" else 90)
            print(f"warmed {path} in {(datetime.now() - t0).total_seconds():.1f}s")
        except Exception as e:  # keep going; next run will retry
            print(f"warm {path} failed: {e}")


if __name__ == "__main__":
    main()
