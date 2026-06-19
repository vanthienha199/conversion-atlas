#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
import urllib.parse

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TLV = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/projects/research/redwood-eda/serv/tlv")
PORT = 8799
BASE = f"http://127.0.0.1:{PORT}"

hard, soft = [], []


def check(cond, name, detail=""):
    hard.append((bool(cond), name, detail))


def info(cond, name, detail=""):
    soft.append((bool(cond), name, detail))


def get(path, expect_ok=True):
    try:
        with urllib.request.urlopen(BASE + path, timeout=20) as r:
            return r.getcode(), json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, (json.load(e) if e.headers.get("content-type", "").startswith("application/json") else {})


def main():
    if not os.path.isdir(TLV):
        print(f"FATAL: conversion dir not found: {TLV}")
        sys.exit(2)

    srv = subprocess.Popen(
        [sys.executable, os.path.join(REPO, "server.py"), TLV, "--port", str(PORT)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        up = False
        for _ in range(40):
            try:
                code, _ = get("/api/scan")
                if code == 200:
                    up = True
                    break
            except Exception:
                time.sleep(0.25)
        check(up, "server starts and answers /api/scan")
        if not up:
            return

        _, scan = get("/api/scan")
        mods = scan["modules"]
        guided = [m for m in mods if m.get("has_guide")]
        check(len(mods) >= 1, "scan returns modules", f"{len(mods)} found")
        check(any(m["name"] == "serv_aligner" for m in guided),
              "serv_aligner is a guided module (shows in Lesson)")
        check(all(m["name"] == "serv_aligner" for m in guided),
              "ONLY serv_aligner is guided (no stray lessons)",
              "guided=" + ",".join(m["name"] for m in guided))

        aligner = next(m for m in mods if m["name"] == "serv_aligner")
        mid = aligner["id"]

        unguided = next((m for m in mods if not m.get("has_guide")), None)
        info(unguided is not None, "at least one unguided module exists (Explore-only)")

        _, gj = get(f"/api/guide?mod={mid}")
        guide = gj.get("guide")
        check(guide is not None, "guide loads for serv_aligner")
        check(guide and "intro" in guide and guide["intro"].get("md"),
              "guide has an intro (shown on step 1)")

        _, mod = get(f"/api/module?mod={mid}")
        steps = mod["steps"]
        check(len(steps) == 15, "serv_aligner has 15 steps", f"{len(steps)} found")

        gsteps = (guide or {}).get("steps", {})
        missing = [s["n"] for s in steps if str(s["n"]) not in gsteps]
        check(not missing, "every step (1-15) has a guide narrative",
              f"missing: {missing}")
        for s in steps:
            g = gsteps.get(str(s["n"]), {})
            info(g.get("title") and g.get("md"),
                 f"step {s['n']} guide has title+body")

        if unguided:
            _, g2 = get(f"/api/guide?mod={unguided['id']}")
            check(g2.get("guide") is None, "guide is null for unguided module")

        for i, s in enumerate(steps):
            if i == 0:
                code, dj = get(f"/api/diff?mod={mid}&a_step=root&a_name=prepared.sv"
                               f"&b_step={s['key']}&b_name=wip.tlv")
            else:
                prev = steps[i - 1]
                code, dj = get(f"/api/diff?mod={mid}&a_step={prev['key']}&a_name=wip.tlv"
                               f"&b_step={s['key']}&b_name=wip.tlv")
            check(code == 200 and "rows" in dj,
                  f"diff resolves for step {s['n']}", f"code={code}")
            if code == 200:
                check(len(dj["rows"]) > 0,
                      f"step {s['n']} diff has rows (never a blank pane)",
                      f"{len(dj['rows'])} rows, {dj.get('changed')} changed")

        _, d1 = get(f"/api/diff?mod={mid}&a_step=root&a_name=prepared.sv"
                    f"&b_step={steps[0]['key']}&b_name=wip.tlv")
        check(d1.get("changed") == 0,
              "step 1 has 0 changed lines (setup step, expected)",
              f"changed={d1.get('changed')}")

        s5 = next((s for s in steps if s["n"] == 5), None)
        if s5:
            _, d5 = get(f"/api/diff?mod={mid}&a_step={steps[3]['key']}&a_name=wip.tlv"
                        f"&b_step={s5['key']}&b_name=wip.tlv")
            check(d5.get("changed", 0) > 10,
                  "step 5 (TLV File Format) shows a substantial diff",
                  f"changed={d5.get('changed')}")

        code, fj = get(f"/api/file?mod={mid}&step={steps[4]['key']}&name=wip.tlv")
        check(code == 200 and fj.get("content"),
              "file content loads at a checkpoint")

        resolved = 0
        for s in steps:
            _, tj = get(f"/api/task?mod={mid}&name={urllib.parse.quote(s['task'])}")
            if tj.get("markdown"):
                resolved += 1
            info(bool(tj.get("markdown")),
                 f"task '{s['task']}' resolves instructions",
                 "fuzzy" if not tj.get("exact") else "exact")
        check(resolved >= len(steps) - 2,
              "most task instructions resolve (fuzzy ok)",
              f"{resolved}/{len(steps)}")

        code, sj = get(f"/api/sessions?mod={mid}")
        check(code == 200 and isinstance(sj.get("sessions"), list),
              "sessions endpoint returns a list (empty is fine)",
              f"{len(sj.get('sessions', []))} sessions")

        code, _ = get(f"/api/module?mod=99999")
        check(code in (403, 404, 500) and code != 200,
              "out-of-range module id is rejected, not 200", f"code={code}")
        code, _ = get(f"/api/file?mod={mid}&step=history/001&name=..%2F..%2Fserver.py")
        check(code == 403, "path traversal in file name is blocked", f"code={code}")
        code, _ = get(f"/api/file?mod={mid}&step=..%2F..%2F..%2Fetc&name=passwd")
        check(code == 403, "path traversal in step is blocked", f"code={code}")

    finally:
        srv.terminate()
        try:
            srv.wait(timeout=5)
        except Exception:
            srv.kill()

    print("\n=== HARD CHECKS ===")
    npass = 0
    for ok, name, detail in hard:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  ({detail})" if detail else ""))
        npass += ok
    print(f"\n  {npass}/{len(hard)} hard checks passed")

    fails_soft = [(n, d) for ok, n, d in soft if not ok]
    print(f"\n=== SOFT CHECKS ===  {len(soft) - len(fails_soft)}/{len(soft)} ok")
    for name, detail in fails_soft:
        print(f"  [warn] {name}" + (f"  ({detail})" if detail else ""))

    sys.exit(0 if npass == len(hard) else 1)


if __name__ == "__main__":
    main()
