#!/usr/bin/env python3
import argparse
import difflib
import json
import mimetypes
import os
import sys
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")
SKIP_DIRS = {".git", "node_modules", "tmp", "unsuccessful", "full_sv", "__pycache__", ".venv", "venv", "current"}
MAX_FILE = 2_500_000

STUCK_FEV = 5
STUCK_MINUTES = 8

AUTODETECT = (
    "~/projects/LLM_TLV/desktop_agent_verilog_conversion",
    "~/projects/research/redwood-eda/serv/tlv",
    "~/projects/conversion-to-TLV",
)

PRICES = {"opus": (15.0, 75.0), "sonnet": (3.0, 15.0), "haiku": (1.0, 5.0)}

ARGS = None
MODULES = []


def read_text(path, limit=MAX_FILE):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(limit)
    except OSError:
        return None


def read_json(path):
    t = read_text(path)
    if t is None:
        return None
    try:
        return json.loads(t)
    except Exception:
        return None


def safe_mtime(path):
    try:
        return os.lstat(path).st_mtime
    except OSError:
        return None


def human_duration(sec):
    if sec is None or sec < 1:
        return None
    if sec > 7 * 24 * 3600:
        return None
    sec = int(sec)
    if sec < 60:
        return f"{sec}s"
    if sec < 3600:
        return f"{sec // 60}m {sec % 60}s"
    return f"{sec // 3600}h {(sec % 3600) // 60}m"


def is_gen2(d):
    return os.path.isfile(os.path.join(d, "wip.tlv")) and os.path.isfile(os.path.join(d, "status.json"))


def is_gen1(d):
    h = os.path.join(d, "history")
    if not os.path.isdir(h):
        return False
    try:
        kids = sorted([k for k in os.listdir(h) if k.isdigit()], key=int)
    except OSError:
        return False
    if not kids:
        return False
    k0 = os.path.join(h, kids[0])
    if not os.path.isdir(k0):
        return False
    try:
        return any(m.startswith("mod_") for m in os.listdir(k0))
    except OSError:
        return False


def gen2_steps_count(d):
    h = os.path.join(d, "history")
    if not os.path.isdir(h):
        return 0
    try:
        return len([k for k in os.listdir(h) if k.isdigit()])
    except OSError:
        return 0


def scan(roots):
    mods = []
    for root in roots:
        root = os.path.abspath(root)
        for dirpath, dirnames, _ in os.walk(root, followlinks=False):
            dirnames[:] = [x for x in dirnames if x not in SKIP_DIRS and not x.startswith(".")]
            flavor = None
            if is_gen1(dirpath):
                flavor = "gen1"
            elif is_gen2(dirpath):
                flavor = "gen2"
            if flavor:
                st = read_json(os.path.join(dirpath, "status.json")) or {}
                name = os.path.basename(dirpath.rstrip("/"))
                mods.append({
                    "name": name,
                    "has_guide": os.path.isfile(os.path.join(HERE, "guides", name + ".json")),
                    "path": dirpath,
                    "rel": os.path.relpath(dirpath, root),
                    "root": root,
                    "flavor": flavor,
                    "task": st.get("task"),
                    "fev": st.get("fev.sh"),
                    "steps": gen2_steps_count(dirpath),
                    "mtime": safe_mtime(dirpath),
                })
                dirnames[:] = []
    mods.sort(key=lambda m: (m["root"], m["name"]))
    for i, m in enumerate(mods):
        m["id"] = i
    return mods


INTERESTING_ROOT = (
    "wip.tlv", "feved.tlv", "fully_feved.tlv", "prepared.sv", "orig.sv", "wip.sv", "feved.sv",
    "fev.eqy", "fev_full.eqy", "config.json", "status.json", "tracker.md", "tracker_final.md",
    "CONVERSION_COMPLETE.md",
)


def list_step_files(sd):
    out = []
    try:
        for f in sorted(os.listdir(sd)):
            p = os.path.join(sd, f)
            if os.path.isfile(p) or (os.path.islink(p) and os.path.isfile(os.path.realpath(p))):
                out.append(f)
    except OSError:
        pass
    return out


def gen2_detail(mod):
    d = mod["path"]
    hist = os.path.join(d, "history")
    steps = []
    nums = []
    if os.path.isdir(hist):
        nums = sorted([k for k in os.listdir(hist) if k.isdigit()], key=int)
    prev_mtime = None
    for k in nums:
        sd = os.path.join(hist, k)
        st = read_json(os.path.join(sd, "status.json")) or {}
        mtime = safe_mtime(sd)
        dur = human_duration(mtime - prev_mtime) if (mtime and prev_mtime) else None
        prev_mtime = mtime or prev_mtime
        steps.append({
            "key": f"history/{k}",
            "n": int(k),
            "task": st.get("task"),
            "fev": st.get("fev.sh"),
            "fev_cnt": st.get("fev_cnt"),
            "model": st.get("model"),
            "llm": st.get("llm"),
            "files": list_step_files(sd),
            "mtime": mtime,
            "duration": dur,
        })
    cur = read_json(os.path.join(d, "status.json")) or {}
    wip = read_text(os.path.join(d, "wip.tlv"))
    feved = read_text(os.path.join(d, "feved.tlv"))
    pending = (wip is not None and feved is not None and wip != feved)
    root_files = []
    try:
        for f in sorted(os.listdir(d)):
            p = os.path.join(d, f)
            if os.path.isfile(p) and (f in INTERESTING_ROOT or f.startswith("fev_full") or f.endswith((".tlv", ".sv", ".eqy", ".md", ".json"))):
                root_files.append(f)
    except OSError:
        pass
    tasks = []
    seen = None
    for s in steps:
        if s["task"] != seen:
            tasks.append({"task": s["task"], "from": s["n"]})
            seen = s["task"]
    return {
        "module": {k: mod[k] for k in ("id", "name", "rel", "root", "flavor", "path")},
        "flavor": "gen2",
        "current": cur,
        "pending_changes": pending,
        "steps": steps,
        "root_files": root_files,
        "task_lanes": tasks,
        "has_tracker": os.path.isfile(os.path.join(d, "tracker.md")),
    }


def gen1_detail(mod):
    d = mod["path"]
    hist = os.path.join(d, "history")
    steps = []
    snums = sorted([k for k in os.listdir(hist) if k.isdigit()], key=int)
    prev_mtime = None
    for k in snums:
        sd = os.path.join(hist, k)
        pid = read_json(os.path.join(sd, "prompt_id.txt"))
        desc = None
        if isinstance(pid, dict):
            desc = pid.get("desc")
        elif isinstance(pid, int):
            desc = f"prompt {pid}"
        try:
            mods = sorted([m for m in os.listdir(sd) if m.startswith("mod_")], key=lambda x: int(x.split("_")[1]))
        except (OSError, ValueError):
            mods = []
        for mname in mods:
            md = os.path.join(sd, mname)
            reverted = os.path.islink(md)
            target = os.readlink(md) if reverted else None
            st = read_json(os.path.join(md, "status.json")) or {}
            mtime = safe_mtime(md)
            dur = human_duration(mtime - prev_mtime) if (mtime and prev_mtime) else None
            prev_mtime = mtime or prev_mtime
            steps.append({
                "key": f"history/{k}/{mname}",
                "n": len(steps) + 1,
                "task": desc,
                "fev": st.get("fev"),
                "by": st.get("by"),
                "model": st.get("model"),
                "incomplete": st.get("incomplete"),
                "llm": st.get("plan") or "",
                "reverted_to": target,
                "files": [] if reverted else list_step_files(md),
                "mtime": mtime,
                "duration": dur,
            })
    cur = read_json(os.path.join(d, "status.json")) or {}
    root_files = []
    try:
        for f in sorted(os.listdir(d)):
            if os.path.isfile(os.path.join(d, f)) and f.endswith((".v", ".sv", ".tlv", ".json", ".md", ".txt")):
                root_files.append(f)
    except OSError:
        pass
    tasks = []
    seen = None
    for s in steps:
        if s["task"] != seen:
            tasks.append({"task": s["task"], "from": s["n"]})
            seen = s["task"]
    return {
        "module": {k: mod[k] for k in ("id", "name", "rel", "root", "flavor", "path")},
        "flavor": "gen1",
        "current": cur,
        "pending_changes": False,
        "steps": steps,
        "root_files": root_files,
        "task_lanes": tasks,
        "has_tracker": os.path.isfile(os.path.join(d, "tracker.md")),
    }


def resolve_in_module(mod, step_key, name):
    d = mod["path"]
    if "/" in name or name.startswith("."):
        raise PermissionError("bad file name")
    if step_key in ("root", "current", ""):
        p = os.path.join(d, name)
    else:
        parts = [s for s in step_key.split("/") if s and s != ".."]
        if parts[0] != "history":
            raise PermissionError("bad step")
        p = os.path.join(d, *parts, name)
    rp = os.path.realpath(p)
    base = os.path.realpath(d)
    if not (rp == base or rp.startswith(base + os.sep)):
        raise PermissionError("outside module")
    return p


def diff_rows(a_lines, b_lines):
    sm = difflib.SequenceMatcher(None, a_lines, b_lines, autojunk=False)
    rows = []
    changed = 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for o in range(i2 - i1):
                rows.append(["eq", i1 + o + 1, a_lines[i1 + o], j1 + o + 1, b_lines[j1 + o]])
        elif tag == "delete":
            for i in range(i1, i2):
                rows.append(["del", i + 1, a_lines[i], None, None])
                changed += 1
        elif tag == "insert":
            for j in range(j1, j2):
                rows.append(["add", None, None, j + 1, b_lines[j]])
                changed += 1
        else:
            n = max(i2 - i1, j2 - j1)
            for o in range(n):
                ai = i1 + o if i1 + o < i2 else None
                bj = j1 + o if j1 + o < j2 else None
                if ai is not None and bj is not None:
                    rows.append(["chg", ai + 1, a_lines[ai], bj + 1, b_lines[bj]])
                elif ai is not None:
                    rows.append(["del", ai + 1, a_lines[ai], None, None])
                else:
                    rows.append(["add", None, None, bj + 1, b_lines[bj]])
                changed += 1
    return rows, changed


def _count_changes(a_txt, b_txt):
    if a_txt is None and b_txt is None:
        return "U", 0, 0
    if a_txt is None:
        return "A", len(b_txt.splitlines()), 0
    if b_txt is None:
        return "D", 0, len(a_txt.splitlines())
    if a_txt == b_txt:
        return "U", 0, 0
    rows, _ = diff_rows(a_txt.splitlines(), b_txt.splitlines())
    add = sum(1 for r in rows if r[0] in ("add", "chg"))
    rem = sum(1 for r in rows if r[0] in ("del", "chg"))
    return "M", add, rem


def step_changes(mod, step_key):
    det = gen1_detail(mod) if mod["flavor"] == "gen1" else gen2_detail(mod)
    idx = next((i for i, s in enumerate(det["steps"]) if s["key"] == step_key), -1)
    if idx < 0:
        return {"files": [], "changed": 0, "step": step_key}
    s = det["steps"][idx]
    prev = det["steps"][idx - 1] if idx > 0 else None
    prev_key = None
    if prev:
        prev_key = prev["key"]
        if prev.get("reverted_to"):
            prev_key = "/".join(prev["key"].split("/")[:-1] + [prev["reverted_to"]])
    out = []
    for f in s.get("files", []):
        if f == "status.json":
            continue
        try:
            b_txt = read_text(resolve_in_module(mod, step_key, f))
        except PermissionError:
            continue
        if idx == 0:
            base = (mod["flavor"] == "gen2" and f == "wip.tlv"
                    and "prepared.sv" in det["root_files"])
            a_txt = read_text(resolve_in_module(mod, "root", "prepared.sv")) if base else None
        elif prev_key:
            try:
                a_txt = read_text(resolve_in_module(mod, prev_key, f))
            except PermissionError:
                a_txt = None
        else:
            a_txt = None
        status, add, rem = _count_changes(a_txt, b_txt)
        out.append({"name": f, "status": status, "added": add, "removed": rem})
    band = {"M": 0, "A": 0, "D": 0, "U": 1}
    out.sort(key=lambda r: (band.get(r["status"], 1), 0 if r["name"].endswith(".eqy") else 1, r["name"]))
    changed = sum(1 for r in out if r["status"] in ("A", "M", "D"))
    return {"files": out, "changed": changed, "step": step_key}


def find_tasks_md(mod):
    d = os.path.realpath(mod["path"])
    if ARGS and ARGS.tasks_md:
        c = os.path.realpath(os.path.expanduser(ARGS.tasks_md))
        if os.path.isfile(c):
            return c
    direct = os.path.join(d, "instructions", "conversion_tasks.md")
    if os.path.isfile(direct):
        return direct
    scripts = os.path.join(d, "scripts")
    if os.path.islink(scripts):
        tgt = os.path.join(os.path.dirname(scripts), os.readlink(scripts))
        c = os.path.realpath(os.path.join(tgt, "instructions", "conversion_tasks.md"))
        if os.path.isfile(c):
            return c
    rel = os.path.join("desktop_agent_verilog_conversion", "instructions", "conversion_tasks.md")
    p = d
    for _ in range(8):
        for cand in (os.path.join(p, "LLM_TLV", rel), os.path.join(p, rel)):
            if os.path.isfile(cand):
                return cand
        parent = os.path.dirname(p)
        if parent == p:
            break
        p = parent
    return None


def extract_task(md_text, name):
    out = []
    in_task = False
    for ln in md_text.splitlines():
        if ln.startswith("# EOF"):
            break
        if ln.startswith("## Task: "):
            in_task = (ln[len("## Task: "):].strip() == name)
        if in_task:
            out.append(ln)
    return "\n".join(out)


def list_tasks(md_text):
    out = []
    for ln in md_text.splitlines():
        if ln.startswith("# EOF"):
            break
        if ln.startswith("## Task: "):
            out.append(ln[len("## Task: "):].strip())
    return out


def claude_projects_dir():
    return os.path.realpath(os.path.expanduser(ARGS.claude_projects if ARGS else "~/.claude/projects"))


def find_sessions(mod):
    base = claude_projects_dir()
    out = []
    seen = set()
    tdir = os.path.join(mod["path"], "transcripts")
    if os.path.isdir(tdir):
        for f in sorted(os.listdir(tdir)):
            if f.endswith(".jsonl"):
                fp = os.path.join(tdir, f)
                out.append({"id": "repo/" + f, "name": f, "scope": "shared in repo (transcripts/)",
                            "size": os.path.getsize(fp), "mtime": safe_mtime(fp)})
    if not os.path.isdir(base):
        out.sort(key=lambda c: -(c["mtime"] or 0))
        return out
    p = os.path.realpath(mod["path"])
    stop_at = os.path.dirname(os.path.realpath(mod["root"]))
    hops = 0
    while p and p != "/" and hops < 8 and len(p) >= len(stop_at):
        enc = p.replace("/", "-")
        pd = os.path.join(base, enc)
        if os.path.isdir(pd) and pd not in seen:
            seen.add(pd)
            for f in os.listdir(pd):
                if f.endswith(".jsonl"):
                    fp = os.path.join(pd, f)
                    out.append({
                        "id": os.path.join(enc, f),
                        "name": f,
                        "scope": p,
                        "size": os.path.getsize(fp),
                        "mtime": safe_mtime(fp),
                    })
        p = os.path.dirname(p)
        hops += 1
    suffix = "-" + os.path.basename(mod["path"].rstrip("/"))
    for dname in os.listdir(base):
        pd = os.path.join(base, dname)
        if not dname.endswith(suffix) or pd in seen or not os.path.isdir(pd):
            continue
        seen.add(pd)
        for f in os.listdir(pd):
            if f.endswith(".jsonl"):
                fp = os.path.join(pd, f)
                out.append({"id": os.path.join(dname, f), "name": f,
                            "scope": "matched by module name: " + dname,
                            "size": os.path.getsize(fp), "mtime": safe_mtime(fp)})
    out.sort(key=lambda c: -(c["mtime"] or 0))
    return out


def normalize_content(content):
    parts = []
    if isinstance(content, str):
        if content.strip():
            parts.append({"t": "text", "text": content[:20000]})
    elif isinstance(content, list):
        for b in content:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text" and b.get("text", "").strip():
                parts.append({"t": "text", "text": b["text"][:20000]})
            elif bt == "tool_use":
                parts.append({"t": "tool", "name": b.get("name", "tool"),
                              "input": json.dumps(b.get("input", {}))[:400]})
            elif bt == "tool_result":
                c = b.get("content")
                if isinstance(c, list):
                    c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
                parts.append({"t": "result", "text": str(c)[:1200]})
    return parts


def model_rate(model):
    m = (model or "").lower()
    for k, v in PRICES.items():
        if k in m:
            return v
    return PRICES["sonnet"]


def accumulate_cost(cost, msg):
    u = msg.get("usage") or {}
    inp = u.get("input_tokens") or 0
    out = u.get("output_tokens") or 0
    cw = u.get("cache_creation_input_tokens") or 0
    cr = u.get("cache_read_input_tokens") or 0
    if not (inp or out or cw or cr):
        return
    model = msg.get("model") or "unknown"
    ri, ro = model_rate(model)
    usd = (inp * ri + cw * ri * 1.25 + cr * ri * 0.1 + out * ro) / 1e6
    cost["input"] += inp
    cost["output"] += out
    cost["cache_read"] += cr
    cost["cache_creation"] += cw
    cost["usd"] += usd
    bm = cost["by_model"].setdefault(model, {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "usd": 0.0})
    bm["input"] += inp
    bm["output"] += out
    bm["cache_read"] += cr
    bm["cache_creation"] += cw
    bm["usd"] += usd


def load_session(session_id, mod=None):
    if session_id.startswith("repo/"):
        if mod is None:
            raise PermissionError("repo session needs module")
        fname = session_id[len("repo/"):]
        if "/" in fname or fname.startswith("."):
            raise PermissionError("bad session name")
        tbase = os.path.realpath(os.path.join(mod["path"], "transcripts"))
        p = os.path.realpath(os.path.join(tbase, fname))
        if not (p.startswith(tbase + os.sep) and p.endswith(".jsonl") and os.path.isfile(p)):
            raise PermissionError("bad session")
    else:
        base = claude_projects_dir()
        p = os.path.realpath(os.path.join(base, session_id))
        if not (p.startswith(base + os.sep) and p.endswith(".jsonl") and os.path.isfile(p)):
            raise PermissionError("bad session")
    msgs = []
    cost = {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "usd": 0.0, "by_model": {}}
    # The transcript logs each streamed assistant message several times, all with
    # the same id and final usage. Count and show each id once, or the cost roughly
    # doubles and the conversation shows triplicate turns.
    seen_ids = set()
    with open(p, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("isMeta"):
                continue
            t = obj.get("type")
            if t not in ("user", "assistant"):
                continue
            msg = obj.get("message") or {}
            if t == "assistant":
                mid = msg.get("id")
                if mid is not None:
                    if mid in seen_ids:
                        continue
                    seen_ids.add(mid)
                accumulate_cost(cost, msg)
            if len(msgs) >= 4000:
                continue
            parts = normalize_content(msg.get("content"))
            if not parts:
                continue
            msgs.append({"role": msg.get("role", t), "ts": obj.get("timestamp"), "parts": parts})
    cost["usd"] = round(cost["usd"], 4)
    for bm in cost["by_model"].values():
        bm["usd"] = round(bm["usd"], 4)
    return {"messages": msgs, "cost": cost}


def iso_epoch(ts):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def module_transcript(mod):
    tdir = os.path.join(mod["path"], "transcripts")
    if not os.path.isdir(tdir):
        return None
    cands = [os.path.join(tdir, f) for f in os.listdir(tdir) if f.endswith(".jsonl")]
    return max(cands, key=lambda p: safe_mtime(p) or 0) if cands else None


# Pull every fev.sh invocation (Bash tool call running the script, not a grep/cat of it)
# out of an agent transcript, paired with the output the agent saw, sorted by time.
def fev_runs_from_transcript(path):
    runs, results = [], {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                content = (obj.get("message") or {}).get("content")
                if not isinstance(content, list):
                    continue
                ts = iso_epoch(obj.get("timestamp"))
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "tool_use" and b.get("name") == "Bash":
                        cmd = (b.get("input") or {}).get("command", "")
                        if "scripts/fev.sh" in cmd and "grep" not in cmd and "cat " not in cmd:
                            runs.append({"id": b.get("id"), "ts": ts, "command": cmd[:300]})
                    elif b.get("type") == "tool_result":
                        c = b.get("content")
                        if isinstance(c, list):
                            c = "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
                        results[b.get("tool_use_id")] = str(c)
    except OSError:
        return []
    for r in runs:
        r["output"] = results.get(r["id"], "")[:6000]
    runs = [r for r in runs if r["ts"] is not None]
    runs.sort(key=lambda r: r["ts"])
    return runs


# Correlate a checkpoint to the fev.sh run that produced it: the last run that started
# at or before the checkpoint was written. Surfaces the FEV output (the EQY error on a
# failed attempt, the proof on a pass) so each step's "why" is visible from the transcript.
def fevlog_for_step(mod, step_key):
    if mod.get("flavor") != "gen2":
        return {"found": False, "reason": "fev log correlation is gen2-only"}
    tpath = module_transcript(mod)
    if not tpath:
        return {"found": False, "reason": "no transcript captured for this module"}
    runs = fev_runs_from_transcript(tpath)
    if not runs:
        return {"found": False, "reason": "no fev.sh runs found in transcript"}
    try:
        ck_mtime = safe_mtime(resolve_in_module(mod, step_key, "status.json"))
    except PermissionError:
        ck_mtime = None
    if ck_mtime:
        before = [r for r in runs if r["ts"] <= ck_mtime + 5]
        chosen = before[-1] if before else min(runs, key=lambda r: abs(r["ts"] - ck_mtime))
    else:
        chosen = runs[-1]
    return {"found": True, "command": chosen["command"], "ts": chosen["ts"],
            "output": chosen["output"], "runs": len(runs),
            "transcript": os.path.basename(tpath)}


def live_state(mod):
    d = mod["path"]
    hist = os.path.join(d, "history")
    nums = []
    if os.path.isdir(hist):
        try:
            nums = sorted([k for k in os.listdir(hist) if k.isdigit()], key=int)
        except OSError:
            pass
    latest_n = int(nums[-1]) if nums else None
    latest_mtime = safe_mtime(os.path.join(hist, nums[-1])) if nums else None
    cur = read_json(os.path.join(d, "status.json")) or {}
    wip = read_text(os.path.join(d, "wip.tlv"))
    feved = read_text(os.path.join(d, "feved.tlv"))
    pending = (wip is not None and feved is not None and wip != feved)
    fev_cnt = cur.get("fev_cnt")
    now = time.time()
    idle = (now - latest_mtime) if latest_mtime else None
    activity, reason = "idle", None
    if pending:
        activity = "working"
        if isinstance(fev_cnt, int) and fev_cnt >= STUCK_FEV:
            activity, reason = "stuck", f"{fev_cnt} FEV attempts on the current task"
        elif idle is not None and idle > STUCK_MINUTES * 60:
            activity, reason = "stuck", f"no new checkpoint in {int(idle // 60)} min while a change is in progress"
    return {
        "steps": len(nums),
        "latest_n": latest_n,
        "latest_mtime": latest_mtime,
        "task": cur.get("task"),
        "fev": cur.get("fev.sh"),
        "fev_cnt": fev_cnt,
        "pending": pending,
        "activity": activity,
        "stuck_reason": reason,
        "now": now,
    }


def live_sig(ls):
    return (ls["steps"], ls["latest_mtime"], ls["task"], ls["fev"], ls["fev_cnt"],
            ls["pending"], ls["activity"], ls["stuck_reason"])


def get_mod(q):
    try:
        mid = int(q.get("mod", ["-1"])[0])
        return MODULES[mid]
    except (ValueError, IndexError):
        raise PermissionError("bad module id")


class Handler(BaseHTTPRequestHandler):
    server_version = "ConversionAtlas/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            u = urlparse(self.path)
            q = parse_qs(u.query)
            route = u.path
            if route == "/api/events":
                return self.sse(q)
            if route.startswith("/api/"):
                return self.api(route, q)
            return self.static(route)
        except PermissionError as e:
            return self.send_json({"error": str(e)}, 403)
        except BrokenPipeError:
            pass
        except Exception as e:
            return self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)

    def sse(self, q):
        mod = get_mod(q)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        last = object()
        ticks = 0
        try:
            while True:
                ls = live_state(mod)
                sig = live_sig(ls)
                if sig != last:
                    last = sig
                    self.wfile.write(b"event: state\ndata: " + json.dumps(ls).encode("utf-8") + b"\n\n")
                    self.wfile.flush()
                else:
                    ticks += 1
                    if ticks % 15 == 0:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                time.sleep(1)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def api(self, route, q):
        global MODULES
        if route == "/api/scan":
            if q.get("refresh", ["0"])[0] == "1":
                MODULES = scan(ARGS.roots)
            return self.send_json({"roots": [os.path.abspath(r) for r in ARGS.roots],
                                   "modules": MODULES, "now": time.time()})
        if route == "/api/module":
            mod = get_mod(q)
            det = gen1_detail(mod) if mod["flavor"] == "gen1" else gen2_detail(mod)
            return self.send_json(det)
        if route == "/api/file":
            mod = get_mod(q)
            step = q.get("step", ["root"])[0]
            name = q.get("name", [""])[0]
            p = resolve_in_module(mod, step, name)
            txt = read_text(p)
            if txt is None:
                return self.send_json({"error": "not found"}, 404)
            return self.send_json({"name": name, "step": step, "content": txt})
        if route == "/api/diff":
            mod = get_mod(q)
            a_step = q.get("a_step", ["root"])[0]
            a_name = q.get("a_name", [""])[0]
            b_step = q.get("b_step", ["root"])[0]
            b_name = q.get("b_name", [""])[0]
            a_txt = read_text(resolve_in_module(mod, a_step, a_name))
            b_txt = read_text(resolve_in_module(mod, b_step, b_name))
            if a_txt is None or b_txt is None:
                return self.send_json({"error": "file not found", "a_missing": a_txt is None,
                                       "b_missing": b_txt is None}, 404)
            rows, changed = diff_rows(a_txt.splitlines(), b_txt.splitlines())
            return self.send_json({"a": f"{a_step}/{a_name}", "b": f"{b_step}/{b_name}",
                                   "rows": rows, "changed": changed})
        if route == "/api/changes":
            mod = get_mod(q)
            return self.send_json(step_changes(mod, q.get("step", [""])[0]))
        if route == "/api/task":
            mod = get_mod(q)
            name = q.get("name", [""])[0]
            md_path = find_tasks_md(mod)
            if not md_path:
                return self.send_json({"error": "conversion_tasks.md not found; pass --tasks-md"}, 404)
            md = read_text(md_path) or ""
            if not name:
                return self.send_json({"source": md_path, "tasks": list_tasks(md)})
            text = extract_task(md, name)
            matched = name
            if not text:
                stop = {"the", "and", "to", "of", "for", "a", "in"}
                low = name.lower()
                qwords = [w for w in low.split() if w not in stop]
                best, best_score = None, 0
                for t in list_tasks(md):
                    tl = t.lower()
                    tw = set(tl.split()) - stop
                    score = 0
                    if tl == low:
                        score = 1000
                    elif low in tl or tl in low:
                        score = 500
                    else:
                        score = sum((i + 1) * 10 for i, w in enumerate(qwords) if w in tw)
                    if score > best_score:
                        best, best_score = t, score
                if best:
                    text = extract_task(md, best)
                    matched = best
            return self.send_json({"source": md_path, "name": name, "matched": matched,
                                   "exact": matched == name, "markdown": text,
                                   "tasks": [] if text else list_tasks(md)})
        if route == "/api/guide":
            mod = get_mod(q)
            p = os.path.join(HERE, "guides", os.path.basename(mod["name"]) + ".json")
            return self.send_json({"guide": read_json(p)})
        if route == "/api/tracker":
            mod = get_mod(q)
            txt = read_text(os.path.join(mod["path"], "tracker.md"))
            return self.send_json({"markdown": txt or "_no tracker.md_"})
        if route == "/api/sessions":
            mod = get_mod(q)
            return self.send_json({"sessions": find_sessions(mod), "projects_dir": claude_projects_dir()})
        if route == "/api/session":
            sid = q.get("id", [""])[0]
            mod = get_mod(q) if sid.startswith("repo/") else None
            return self.send_json(load_session(sid, mod))
        if route == "/api/fevlog":
            mod = get_mod(q)
            return self.send_json(fevlog_for_step(mod, q.get("step", [""])[0]))
        return self.send_json({"error": "unknown endpoint"}, 404)

    def static(self, route):
        if route in ("/", ""):
            route = "/index.html"
        p = os.path.realpath(os.path.join(STATIC_DIR, route.lstrip("/")))
        if not (p.startswith(os.path.realpath(STATIC_DIR) + os.sep) and os.path.isfile(p)):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        ctype = mimetypes.guess_type(p)[0] or "application/octet-stream"
        with open(p, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def autodetect_roots():
    for cand in (os.getcwd(),) + tuple(os.path.expanduser(p) for p in AUTODETECT):
        if os.path.isdir(cand) and scan([cand]):
            return [cand]
    return []


def main():
    global ARGS, MODULES
    ap = argparse.ArgumentParser(description="Conversion Atlas: Verilog -> TL-Verilog history explorer")
    ap.add_argument("roots", nargs="*", help="directories to scan for conversion work dirs "
                    "(omit to auto-detect: the current dir, then known conversion repos)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--tasks-md", default=None, help="path to conversion_tasks.md for task instructions")
    ap.add_argument("--claude-projects", default="~/.claude/projects",
                    help="Claude Code projects dir for session transcripts")
    ARGS = ap.parse_args()
    if not ARGS.roots:
        ARGS.roots = autodetect_roots()
        if not ARGS.roots:
            print("error: no conversion dirs found here; pass a path, e.g.\n"
                  "  python3 server.py ~/projects/research/redwood-eda/serv/tlv", file=sys.stderr)
            sys.exit(1)
        print(f"auto-detected conversion root: {ARGS.roots[0]}")
    for r in ARGS.roots:
        if not os.path.isdir(r):
            print(f"error: not a directory: {r}", file=sys.stderr)
            sys.exit(1)
    MODULES = scan(ARGS.roots)
    print(f"Conversion Atlas: found {len(MODULES)} conversion dir(s)")
    for m in MODULES:
        print(f"  [{m['flavor']}] {m['name']}  ({m['steps']} steps)  {m['path']}")
    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    print(f"\n  ->  http://{ARGS.host}:{ARGS.port}\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
