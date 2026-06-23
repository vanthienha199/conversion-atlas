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
PORT = 8793
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
    flow = os.path.join(root, "LLM_TLV", "desktop_agent_verilog_conversion")
    write(os.path.join(flow, "instructions", "conversion_tasks.md"),
          "## Task: Setup\nPrepare the module.\n\n## Task: Pipeline\nConvert signals to pipesignals.\n\n# EOF\n")
    mod = os.path.join(root, "serv", "tlv", "serv_demo")
    os.makedirs(os.path.join(mod, "history", "001"))
    write(os.path.join(mod, "wip.tlv"), "\\TLV\n   $x = 1;\n")
    write(os.path.join(mod, "feved.tlv"), "\\TLV\n   $x = 1;\n")
    write(os.path.join(mod, "status.json"), json.dumps({"task": "Pipeline", "fev.sh": 0}))
    write(os.path.join(mod, "history", "001", "status.json"), json.dumps({"task": "Pipeline", "fev.sh": "0: ok"}))
    write(os.path.join(mod, "history", "001", "wip.tlv"), "\\TLV\n   $x = 1;\n")
    os.symlink("/home/steve/repos/LLM_TLV/desktop_agent_verilog_conversion", os.path.join(mod, "scripts"))
    return os.path.join(root, "serv", "tlv")


def get(path):
    return json.loads(urllib.request.urlopen(BASE + path, timeout=10).read())


def main():
    tmp = tempfile.mkdtemp(prefix="atlas_tasks_")
    scan_root = build(tmp)
    proc = subprocess.Popen([sys.executable, SERVER, scan_root, "--port", str(PORT)],
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
        check("broken scripts symlink does not crash", os.path.islink(os.path.join(scan_root, "serv_demo", "scripts")))
        tj = get("/api/task?mod=0&name=" + urllib.parse.quote("Pipeline"))
        check("tasks-md found via upward search (broken symlink)", bool(tj.get("markdown")),
              tj.get("source", "")[-60:])
        check("correct task body resolved", "pipesignals" in (tj.get("markdown") or ""),
              repr((tj.get("markdown") or "")[:50]))
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
