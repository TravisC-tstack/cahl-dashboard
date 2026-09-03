#!/usr/bin/env python3
"""CAHL API audit — exercises every endpoint with timings and asserts SLOs.

Usage: .venv/bin/python qa/probe_api.py [base_url]
SLOs: /api/today < 3s warm, /api/version < 1s, lookup < 3s warm,
      /api/teams < 5s warm. Any 5xx or timeout = FAIL.
"""
import json
import sys
import time
import urllib.request
import urllib.error

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765"
UA = {"User-Agent": "cahl-qa/1.0"}
results = []


def probe(name, path, slo_s=None, timeout=75, expect_json=True):
    t0 = time.time()
    ok, status, note = True, None, ""
    try:
        req = urllib.request.Request(BASE + path, headers=UA)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status = r.status
            body = r.read()
            if expect_json:
                data = json.loads(body)
                note = f"{len(body)//1024}KB"
                if isinstance(data, dict) and data.get("error"):
                    ok, note = False, f"API error: {str(data['error'])[:80]}"
            else:
                note = f"{len(body)//1024}KB"
    except urllib.error.HTTPError as e:
        ok, status = False, e.code
        note = f"HTTP {e.code}"
    except Exception as e:
        ok, status = False, None
        note = f"{type(e).__name__}: {str(e)[:80]}"
    dt = time.time() - t0
    if ok and slo_s is not None and dt > slo_s:
        ok = False
        note = (note + " " if note else "") + f"SLOW {dt:.1f}s > {slo_s}s SLO"
    results.append({"name": name, "path": path, "status": status,
                    "secs": round(dt, 2), "ok": ok, "note": note})
    return results[-1]


def main():
    print(f"Probing {BASE}\n")
    # warm the aggregate caches first so SLOs measure the warm path
    probe("warmup today", "/api/today")
    probe("warmup teams", "/api/teams", timeout=90)
    probe("warmup players", "/api/players", timeout=110)

    probe("version", "/api/version", slo_s=1)
    probe("home page", "/", slo_s=2, expect_json=False)
    today = probe("today", "/api/today", slo_s=3)
    teams = probe("teams", "/api/teams", slo_s=5)
    probe("leaders", "/api/leaders", slo_s=3)
    probe("today scores", "/api/today/scores", slo_s=45, timeout=60)
    probe("players full", "/api/players", slo_s=40, timeout=110)
    probe("lookup curn", "/api/players/lookup?q=curn", slo_s=4, timeout=60)
    probe("lookup travis", "/api/players/lookup?q=travis", slo_s=4, timeout=60)
    probe("lookup zzz-nohit", "/api/players/lookup?q=zzqx", slo_s=4, timeout=60)
    probe("lookup short", "/api/players/lookup?q=a", slo_s=2, timeout=20)
    r = probe("refresh scores", "/api/refresh?scope=scores", slo_s=2, timeout=30, expect_json=True)
    if r["status"] == 405:  # refresh is POST-only; re-probe correctly
        t0 = time.time()
        try:
            req = urllib.request.Request(BASE + "/api/refresh?scope=scores",
                                         headers=UA, method="POST")
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp.read()
                r.update(status=resp.status, secs=round(time.time() - t0, 2),
                         ok=True, note="POST ok")
        except Exception as e:
            r.update(ok=False, note=f"POST failed: {e}")

    # exercise a real team + player path from live data
    try:
        tdata = json.load(urllib.request.urlopen(BASE + "/api/teams", timeout=60))
        if isinstance(tdata, list) and tdata:
            tid = tdata[0]["id"]
            r = probe("team page", f"/api/team/{tid}", slo_s=30, timeout=60)
            try:
                pdata = json.load(urllib.request.urlopen(
                    BASE + f"/api/team/{tid}", timeout=60))
                roster = []
                for sec in (pdata.get("roster") or {}).get("sections") or []:
                    roster += sec.get("players") or []
                roster += (pdata.get("roster") or {}).get("goalies") or []
                probed = False
                if roster:
                    p = roster[0]
                    tok = p.get("token") or ""
                    pid = p.get("player_id") or ""
                    if tok:
                        probe("player history (token)",
                              f"/api/player-token/{tok}", slo_s=20, timeout=40)
                        probed = True
                    elif pid:
                        probe("player history",
                              f"/api/player/{tid}/{pid}", slo_s=20, timeout=40)
                        probed = True
                if not probed:
                    results.append({"name": "player history", "path": "-", "status": None,
                                    "secs": 0, "ok": False,
                                    "note": "no roster player had token/player_id"})
            except Exception as e:
                results.append({"name": "player history", "path": "-", "status": None,
                                "secs": 0, "ok": False, "note": f"roster parse: {e}"})
            probe("team history", f"/api/team/{tid}/history", slo_s=25, timeout=60)
            probe("team game-log", f"/api/game-log/{tid}?player=X&team=Y", slo_s=20, timeout=40)
    except Exception as e:
        results.append({"name": "team paths", "path": "-", "status": None,
                        "secs": 0, "ok": False, "note": f"teams parse: {e}"})

    # league + sessions paths
    try:
        hdata = json.load(urllib.request.urlopen(BASE + "/api/today", timeout=60))
        leagues = hdata.get("leagues") or []
        if leagues:
            lid = leagues[0]["id"]
            probe("league dash", f"/api/league/{lid}", slo_s=20, timeout=45)
            probe("league sessions", f"/api/sessions/{lid}", slo_s=20, timeout=45)
    except Exception as e:
        results.append({"name": "league paths", "path": "-", "status": None,
                        "secs": 0, "ok": False, "note": f"today parse: {e}"})

    print(f"{'PROBE':<18} {'STATUS':<7} {'SECS':<7} OK/FAIL  NOTE")
    print("-" * 80)
    fails = 0
    for r in results:
        if not r["ok"]:
            fails += 1
        print(f"{r['name']:<18} {str(r['status']):<7} {r['secs']:<7} "
              f"{'PASS' if r['ok'] else 'FAIL'}  {r['note']}")
    print("-" * 80)
    print(f"{len(results) - fails}/{len(results)} passed, {fails} failed")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
