#!/usr/bin/env python3
"""Integration gate for post-swarm builds. Run before every deploy."""
import re
import subprocess
import sys

ROOT = "/Users/traviscurnutte/cahl-dashboard"
fails = []


def run(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=ROOT, **kw)


# 1. JS syntax
r = run("export PATH=/opt/homebrew/bin:$PATH && node --check static/js/app.js")
if r.returncode != 0:
    fails.append(f"app.js syntax: {r.stderr[:400]}")
else:
    print("[OK] app.js syntax")

# 2. Python compiles
for f in ("app.py", "scraper.py"):
    r = run(f".venv/bin/python -m py_compile {f}")
    if r.returncode != 0:
        fails.append(f"{f} compile: {r.stderr[:300]}")
    else:
        print(f"[OK] {f} compiles")

# 3. CSS brace balance
css = open(f"{ROOT}/static/css/style.css").read()
o, c = css.count("{"), css.count("}")
if o != c:
    fails.append(f"CSS braces unbalanced: {{={o} }}={c}")
else:
    print(f"[OK] CSS braces balanced ({o})")

# 4. Duplicate top-level function definitions in app.js (merge-artifact detector)
js = open(f"{ROOT}/static/js/app.js").read()
names = re.findall(r"^    function ([a-zA-Z_$][\w$]*)\(", js, re.M)
dups = {n for n in names if names.count(n) > 1}
if dups:
    fails.append(f"Duplicate function definitions (merge artifacts): {sorted(dups)[:8]}")
else:
    print(f"[OK] no duplicate functions ({len(names)} defs)")

# 5. Fix-pass markers present (expected sections from fix-swarm rounds)
for marker in ("FIX PASS R1-B", "FIX PASS R1-C", "FIX PASS R1-D", "FIX PASS R1-E", "FIX PASS R1-F"):
    if marker in css:
        print(f"[OK] CSS contains {marker}")
    else:
        print(f"[WARN] CSS missing {marker}")

# 6. esc() coverage spot-check: no raw ${p.name}/${s.team}/${t.name} in element text
bad = re.findall(r"> \$?\{(p|s|t)\.(name|team)\}", js)
if bad:
    fails.append(f"Unescaped interpolations in element text: {bad[:5]}")
else:
    print("[OK] esc() coverage spot-check")

print()
if fails:
    print("GATE: FAIL")
    for f in fails:
        print("  -", f)
    sys.exit(1)
print("GATE: PASS")
