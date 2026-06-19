#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "server.py")
PORT = 8791
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
    with open(p, "w") as f:
        f.write(txt)


def make_module(root):
    m = os.path.join(root, "serv_demo")
    os.makedirs(os.path.join(m, "history", "001"))
    write(os.path.join(m, "wip.tlv"), "\\TLV\n   $x = 1;\n")
    write(os.path.join(m, "feved.tlv"), "\\TLV\n   $x = 1;\n")
    write(os.path.join(m, "status.json"), json.dumps({"task": "Setup", "fev.sh": 0, "fev_cnt": 0}))
    write(os.path.join(m, "history", "001", "status.json"), json.dumps({"task": "Setup", "fev.sh": 0}))
    write(os.path.join(m, "history", "001", "wip.tlv"), "\\TLV\n   $x = 1;\n")
    return m


def wait_up():
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + "/api/scan", timeout=1).read()
            return True
        except Exception:
            time.sleep(0.1)
    return False


def read_one_event(resp, timeout=6):
    resp.fp.raw._sock.settimeout(timeout)
    ev, data = None, None
    deadline = time.time() + timeout
    while time.time() < deadline:
        raw = resp.readline()
        if not raw:
            break
        line = raw.decode("utf-8").rstrip("\n")
        if line.startswith("event:"):
            ev = line[6:].strip()
        elif line.startswith("data:"):
            data = line[5:].strip()
        elif line == "" and ev == "state" and data is not None:
            return json.loads(data)
    return None


def main():
    tmp = tempfile.mkdtemp(prefix="atlas_live_")
    mod = make_module(tmp)
    proc = subprocess.Popen([sys.executable, SERVER, tmp, "--port", str(PORT)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_up():
            print("  [FAIL] server did not start")
            return 1

        scan = json.loads(urllib.request.urlopen(BASE + "/api/scan").read())
        check("module discovered", len(scan["modules"]) == 1, scan["modules"][0]["name"] if scan["modules"] else "")

        resp = urllib.request.urlopen(BASE + "/api/events?mod=0", timeout=10)
        first = read_one_event(resp)
        check("initial SSE state arrives", first is not None)
        check("initial steps == 1", first and first["steps"] == 1, f"steps={first and first.get('steps')}")
        check("initial activity idle", first and first["activity"] == "idle", first and first.get("activity"))

        time.sleep(1.2)
        os.makedirs(os.path.join(mod, "history", "002"))
        write(os.path.join(mod, "history", "002", "status.json"), json.dumps({"task": "Pipeline", "fev.sh": 0}))
        write(os.path.join(mod, "history", "002", "wip.tlv"), "\\TLV\n   $x = 1;\n   $y = 2;\n")
        write(os.path.join(mod, "history", "002", "fev.eqy"), "[gold]\nread -sv orig.sv\n")
        ev = read_one_event(resp)
        check("new-checkpoint event pushed", ev is not None and ev["steps"] == 2, f"steps={ev and ev.get('steps')}")

        ch = json.loads(urllib.request.urlopen(BASE + "/api/changes?mod=0&step=history/002").read())
        byname = {f["name"]: f for f in ch["files"]}
        check("changes: status.json excluded", "status.json" not in byname)
        check("changes: wip.tlv reported modified", byname.get("wip.tlv", {}).get("status") == "M",
              byname.get("wip.tlv"))
        check("changes: wip.tlv added-line count", byname.get("wip.tlv", {}).get("added") == 1,
              f"added={byname.get('wip.tlv', {}).get('added')}")
        check("changes: fev.eqy reported added", byname.get("fev.eqy", {}).get("status") == "A",
              byname.get("fev.eqy"))
        check("changes: changed count is 2", ch["changed"] == 2, f"changed={ch['changed']}")
        check("changes: changed files sort before unchanged",
              all(f["status"] != "U" for f in ch["files"][:ch["changed"]]))

        time.sleep(1.2)
        write(os.path.join(mod, "wip.tlv"), "\\TLV\n   $x = 2;\n")
        write(os.path.join(mod, "status.json"), json.dumps({"task": "Pipeline", "fev.sh": 2, "fev_cnt": 7}))
        os.utime(os.path.join(mod, "status.json"), None)
        stuck = None
        for _ in range(4):
            e = read_one_event(resp)
            if e and e["activity"] == "stuck":
                stuck = e
                break
        check("stuck detection fires on high fev_cnt", stuck is not None,
              stuck and stuck.get("stuck_reason"))
        resp.close()

        ad = subprocess.Popen([sys.executable, "-u", SERVER, "--port", str(PORT + 1)], cwd=tmp,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        time.sleep(1.5)
        ad.terminate()
        try:
            adout = ad.communicate(timeout=3)[0]
        except Exception:
            ad.kill(); adout = ad.communicate()[0]
        check("auto-detect finds the cwd module",
              "auto-detected conversion root" in adout,
              (adout.strip().splitlines() or [""])[0])

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
