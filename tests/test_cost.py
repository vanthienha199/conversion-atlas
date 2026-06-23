#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "server.py")
PORT = 8794
BASE = f"http://127.0.0.1:{PORT}"

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  [PASS] {name}  {detail}")
    else:
        failed += 1
        print(f"  [FAIL] {name}  {detail}")


def write(p, txt):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        f.write(txt)


def build(root):
    mod = os.path.join(root, "serv_demo")
    os.makedirs(os.path.join(mod, "history", "001"))
    write(os.path.join(mod, "wip.tlv"), "\\TLV\n   $x = 1;\n")
    write(os.path.join(mod, "feved.tlv"), "\\TLV\n   $x = 1;\n")
    write(os.path.join(mod, "status.json"), json.dumps({"task": "Setup", "fev.sh": 0}))
    write(os.path.join(mod, "history", "001", "status.json"), json.dumps({"task": "Setup", "fev.sh": "0: ok"}))
    write(os.path.join(mod, "history", "001", "wip.tlv"), "\\TLV\n   $x = 1;\n")
    lines = [
        {"type": "assistant", "timestamp": "t1", "message": {"role": "assistant", "model": "claude-sonnet-4-6",
         "usage": {"input_tokens": 1000, "output_tokens": 500, "cache_read_input_tokens": 2000, "cache_creation_input_tokens": 0},
         "content": [{"type": "text", "text": "step one"}]}},
        {"type": "assistant", "timestamp": "t2", "message": {"role": "assistant", "model": "claude-sonnet-4-6",
         "usage": {"input_tokens": 0, "output_tokens": 100, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 400},
         "content": [{"type": "text", "text": "step two"}]}},
    ]
    write(os.path.join(mod, "transcripts", "run.jsonl"), "\n".join(json.dumps(x) for x in lines) + "\n")
    return root


def get(path):
    return json.loads(urllib.request.urlopen(BASE + path, timeout=10).read())


def main():
    tmp = tempfile.mkdtemp(prefix="atlas_cost_")
    build(tmp)
    proc = subprocess.Popen([sys.executable, SERVER, tmp, "--port", str(PORT)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        up = False
        for _ in range(50):
            try:
                get("/api/scan")
                up = True
                break
            except Exception:
                time.sleep(0.1)
        check("server starts", up)
        if not up:
            return 1
        sj = get("/api/sessions?mod=0")
        check("transcript discovered", len(sj["sessions"]) == 1)
        sid = sj["sessions"][0]["id"]
        mj = get("/api/session?mod=0&id=" + urllib.parse.quote(sid))
        c = mj.get("cost", {})
        check("input tokens summed", c.get("input") == 1000, f"input={c.get('input')}")
        check("output tokens summed", c.get("output") == 600, f"output={c.get('output')}")
        check("cache read summed", c.get("cache_read") == 2000, f"cache_read={c.get('cache_read')}")
        expect = (1000 * 3 + 400 * 3 * 1.25 + 2000 * 3 * 0.1 + 600 * 15) / 1e6
        check("usd computed with sonnet rate + cache weighting",
              abs(c.get("usd", 0) - round(expect, 4)) < 1e-6, f"usd={c.get('usd')} expect={round(expect, 4)}")
        check("per-model breakdown present", "claude-sonnet-4-6" in (c.get("by_model") or {}))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except Exception:
            proc.kill()
    print(f"\n  {passed}/{passed + failed} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
