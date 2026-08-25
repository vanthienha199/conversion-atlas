#!/usr/bin/env python3
"""Per-task LLM router for the Verilog -> TL-Verilog conversion flow.

Runs the task list one task at a time. Each task is attempted by a cheap
provider first (deepseek), escalating to a stronger one (claude) on failure.
Every attempt is a fresh stateless API call; fev.sh (formal equivalence
checking) is the only gate that advances a task. Key mechanisms:

  - Prompt caching: each call is (common guide, task+files, feedback), with
    cache breakpoints after the first two parts, so retries hit cache.
  - Oversight judge: after FEV passes, a separate skeptical LLM call checks
    whether the task's REFACTORING GOAL was achieved (FEV only proves
    behavior is unchanged). FAIL feeds back into the retry loop.
  - NO_CHANGE cross-check: a NO_CHANGE claim is confirmed by the next
    provider and then judged; workers never referee their own intent.
  - Edit formats (MM_EDIT_FORMAT): "dots" (whole file with "..." omission
    lines, applied by diff alignment, ambiguity fails soft to a full-file
    request) or "sr" (aider-style search/replace blocks, exact-once match,
    hard fallback to full file after repeated apply failures).
  - Acceptance checks: MM_ACCEPT_GLOB (required new files), and
    MM_ACCEPT_DISTINCT=1 (per-config designs must actually differ).
  - attempts.jsonl: every worker attempt's feedback-in and full reply are
    recorded so the exact exchange is inspectable in the Console.
  - Agent worker mode: provider "agent" in MM_PROVIDERS runs Claude Code
    headless in the module dir; it edits design files directly with file
    tools only (no shell), harness files are snapshotted and force-restored
    if touched, and fev.sh/judge gate exactly as for API workers.
  - Preflight: key files, docker image, fev.sh, and the agent CLI are
    checked up front with clear errors before any paid call.
  - Resume: e6_state.json tracks completed tasks and the in-flight attempt
    budget; rerunning the router continues where it stopped.

Usage:
  MM_ORDER=tasks/order.json MM_PROVIDERS="deepseek:2,claude:2" \
      python3 router.py <module_dir>

See README.md in this directory for the full environment reference.
"""

import sys, os, json, subprocess, urllib.request, re, time

ROUTER_DIR = os.path.dirname(os.path.abspath(__file__))


if len(sys.argv) < 2 or not os.path.isdir(sys.argv[1]):
    sys.exit("usage: router.py <module_dir>   (module_dir must exist and contain wip.tlv, fev.eqy, scripts/fev.sh)")
MDIR = sys.argv[1]
ORDER_PATH = os.environ.get("MM_ORDER", os.path.join(ROUTER_DIR, "tasks", "order.json"))
ORDER_DIR = os.path.dirname(os.path.abspath(ORDER_PATH))
ORDER = json.load(open(ORDER_PATH))
# Task-file paths in the order file are resolved relative to the order file
# itself, so the router works from any CWD.
ORDER = [[name, path if os.path.isabs(path) else os.path.join(ORDER_DIR, path)] for name, path in ORDER]
MAX_COST = {
    "deepseek": float(os.environ.get("MM_MAX_COST_DEEPSEEK", "2.0")),
    "claude": float(os.environ.get("MM_MAX_COST_CLAUDE", "5.0")),
}
MODEL_NAME = {"deepseek": "deepseek-v4-flash", "claude": "claude-sonnet-4-6",
              "agent": "claude-code-agent"}

# Agent worker mode (issue #8 direction, Steve Aug 18: "just ask the agent to
# modify the file"): provider "agent" in MM_PROVIDERS invokes Claude Code
# headless in the module dir. The agent edits design files directly with
# file tools only (no shell), so edit formats do not apply; the harness still
# owns fev.sh, the judge, and all acceptance checks. Harness files are
# snapshotted and force-restored if the agent touches them.
AGENT_CMD = os.environ.get("MM_AGENT_CMD", "claude")
AGENT_MODEL = os.environ.get("MM_AGENT_MODEL", "sonnet")
AGENT_MAX_TURNS = int(os.environ.get("MM_AGENT_MAX_TURNS", "40"))
AGENT_TIMEOUT = int(os.environ.get("MM_AGENT_TIMEOUT", "900"))

# Edit formats for the A/B experiment: the "..." omission style vs the
# search/replace block style modern coding agents use. MM_EDIT_FORMAT=dots|sr.
EDIT_FORMAT = os.environ.get("MM_EDIT_FORMAT", "dots")
_FMT_DOTS = (
    "Only include files you change. For a file that already exists, you may shorten your "
    "output by replacing large UNCHANGED regions with a single line containing exactly "
    "... (three dots, no indentation). Include several unchanged context lines before and "
    "after each ... line so the omitted region maps unambiguously onto the original file, "
    "and preserve those context lines' exact indentation. Never place ... on or next to "
    "lines you are changing, and never use ... in a brand-new file. "
)
_FMT_SR = (
    "Only include files you change. For a file that already exists, instead of the full "
    "contents you may provide one or more search/replace edits inside the file block:\n"
    "<<<<<<< SEARCH\n<exact lines copied verbatim from the current file>\n=======\n"
    "<replacement lines>\n>>>>>>> REPLACE\n"
    "The SEARCH text must match the current file exactly (same whitespace) and exactly "
    "once; include enough surrounding lines to make it unique. Use multiple blocks for "
    "multiple edits, in top-to-bottom file order. A brand-new file must be written out "
    "in full with no search/replace blocks. "
)
SYSTEM = (
    "You are an expert digital-design refactoring agent converting Verilog to TL-Verilog "
    "in small, formally verified steps. You will be given one refactoring task and the "
    "current files. Reply with the updated contents of every file you change, "
    "using EXACTLY this format for each file (no markdown fences, no commentary):\n"
    "===FILE: <filename>===\n<file contents>\n===END===\n"
    + (_FMT_SR if EDIT_FORMAT == "sr" else _FMT_DOTS) +
    "If the task requires "
    "no change to this design, reply with exactly: NO_CHANGE\n"
    "A separate reviewing agent will verify that the task's goal was actually achieved; "
    "it cannot be talked into approving unfinished work. If part of the goal genuinely "
    "cannot be achieved for a specific technical reason (a tool limitation, a construct "
    "with no equivalent), say so explicitly by adding this block after your files:\n"
    "===JUSTIFICATION===\n<the specific technical reason, referencing the exact signals "
    "or constructs>\n===END===\n"
    "The reviewer weighs justifications on their technical merit; vague effort claims "
    "are rejected."
)

JUSTIFY_RE = re.compile(r"===JUSTIFICATION===\n(.*?)\n?===END===", re.S)

def extract_justification(text):
    m = JUSTIFY_RE.search(text)
    return m.group(1).strip()[:1500] if m else None

# NO_CHANGE may carry a justification block (as the system prompt teaches),
# and models often lead with a short analysis before the NO_CHANGE line.
# Accept NO_CHANGE standing on its own line anywhere in the reply, as long
# as the reply contains no file-edit blocks; anything stricter blocks the
# honest escape hatch (both failure modes were observed in real runs).
def is_no_change(text):
    t = text.strip()
    if t == "NO_CHANGE":
        return True
    if "===FILE" in t or "<<<<<<< SEARCH" in t:
        return False
    return bool(re.search(r"^NO_CHANGE\s*$", t, re.M))

def log_unparsed(tname, tag, resp):
    with open(os.path.join(MDIR, "unparsed_replies.log"), "a") as lf:
        lf.write(f"\n===== {tname} [{tag}] {time.strftime('%H:%M:%S')} =====\n{resp}\n")

# Per-attempt exchange capture (agreed with Steve, meeting Aug 18): every worker
# attempt's full reply plus the feedback it was given, one JSON line each, so
# the Console can show the exact exchange after the fact. Conversations are
# otherwise stateless and unrecoverable.
def log_attempt_exchange(tname, provider, n, feedback_in, reply, cost):
    rec = {"ts": time.strftime("%Y-%m-%d %H:%M:%S"), "task": tname,
           "provider": provider, "attempt": n,
           "feedback_in": feedback_in or "", "reply": reply, "cost_usd": round(cost, 4)}
    with open(os.path.join(MDIR, "attempts.jsonl"), "a") as f:
        f.write(json.dumps(rec) + "\n")

def snap(name):
    return open(os.path.join(MDIR, name)).read() if os.path.exists(os.path.join(MDIR, name)) else ""

def set_status_fields(**fields):
    p = os.path.join(MDIR, "status.json")
    try:
        d = json.load(open(p))
    except Exception:
        d = {"task": "", "fev.sh": "none", "fev_cnt": 0, "llm": ""}
    d.update(fields)
    with open(p, "w") as f:
        json.dump(d, f, indent=2)

def context_files():
    names = ["wip.tlv", "fev.eqy", "fev_full.eqy", "config.json", "tracker.md"]
    for f in sorted(os.listdir(MDIR)):
        if f.startswith("fev_full_") and f.endswith(".eqy"):
            names.append(f)
    return [n for n in names if os.path.exists(os.path.join(MDIR, n))]

# The common guide is shared by EVERY task and module: it goes at the front
# of the prompt as a cache prefix that survives across tasks. Task+files
# change per task, so they come after; feedback changes per attempt, so last.
COMMON = ""
_cg = os.environ.get("MM_COMMON_GUIDE", os.path.join(ROUTER_DIR, "common_guide.md"))
if os.path.exists(_cg):
    COMMON = "# TL-Verilog language reference (common to all tasks)\n\n" + open(_cg).read() + "\n"

def build_user(task, feedback=None):
    # Three parts: common (identical across tasks, cache breakpoint 1),
    # stable (task + files, identical across retries within a task, cache
    # breakpoint 2), and feedback (changes every attempt, so it goes last).
    u = "# Task\n\n" + task + "\n"
    for n in context_files():
        u += f"\n===FILE: {n}===\n" + snap(n) + "\n===END===\n"
    fb = ""
    if feedback:
        fb = ("\n# Previous attempt FAILED verification. Tool output:\n\n" + feedback[-3000:] +
              "\n\nFix the problem and reply with the complete corrected files. If the "
              "remaining constructs genuinely cannot be converted for a specific technical "
              "reason, it is acceptable to reply NO_CHANGE followed by a "
              "===JUSTIFICATION===/===END=== block naming the exact constructs and why; "
              "the reviewing agent will weigh it on its merits.")
    return COMMON, u, fb

def call_with_retry(provider, user, tries=8, system=None):
    for k in range(tries):
        try:
            return call(provider, user, system=system)
        except Exception as e:
            wait = min(60, 15 * (k + 1))
            print(f"    (network error {type(e).__name__}, retry {k+1}/{tries} in {wait}s)", flush=True)
            time.sleep(wait)
    raise RuntimeError("network retries exhausted")

def call(provider, user, system=None):
    # user is (common, stable, fb) from build_user, (stable, fb) from the
    # judge path, or a bare string. Common goes first so both providers can
    # cache the cross-task prefix.
    if isinstance(user, tuple):
        common, stable, fb = user if len(user) == 3 else ("", user[0], user[1])
    else:
        common, stable, fb = "", user, ""
    system = system or SYSTEM
    if provider == "deepseek":
        key = open(os.path.expanduser(os.environ.get("MM_DEEPSEEK_KEY_FILE", "~/.secrets/deepseek_key"))).read().strip()
        req = urllib.request.Request("https://api.deepseek.com/chat/completions",
            data=json.dumps({"model": MODEL_NAME["deepseek"],
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": common + stable + fb}],
                "max_tokens": 16000, "temperature": 0.2}).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + key})
        d = json.load(urllib.request.urlopen(req, timeout=300))
        u = d.get("usage", {})
        usage = {"in": u.get("prompt_cache_miss_tokens", u.get("prompt_tokens", 0)),
                 "out": u.get("completion_tokens", 0),
                 "cache_read": u.get("prompt_cache_hit_tokens", 0),
                 "cache_write": 0}
        msg = d["choices"][0]["message"]
        content = msg.get("content") or ""
        if not content:
            # deepseek v4 can burn its whole budget on reasoning -> empty content
            print(f"    (deepseek empty content, finish_reason={d['choices'][0].get('finish_reason')})", flush=True)
            content = msg.get("reasoning_content") or ""
        return content, usage
    else:
        key = open(os.path.expanduser(os.environ.get("MM_ANTHROPIC_KEY_FILE", "~/.secrets/anthropic_key"))).read().strip()
        content = []
        if common:
            content.append({"type": "text", "text": common, "cache_control": {"type": "ephemeral"}})
        content.append({"type": "text", "text": stable, "cache_control": {"type": "ephemeral"}})
        if fb:
            content.append({"type": "text", "text": fb})
        req = urllib.request.Request("https://api.anthropic.com/v1/messages",
            data=json.dumps({"model": MODEL_NAME["claude"], "max_tokens": 8000, "system": system,
                "messages": [{"role": "user", "content": content}]}).encode(),
            headers={"Content-Type": "application/json", "x-api-key": key,
                     "anthropic-version": "2023-06-01"})
        d = json.load(urllib.request.urlopen(req, timeout=300))
        u = d.get("usage", {})
        usage = {"in": u.get("input_tokens", 0), "out": u.get("output_tokens", 0),
                 "cache_read": u.get("cache_read_input_tokens", 0),
                 "cache_write": u.get("cache_creation_input_tokens", 0)}
        return d["content"][0]["text"], usage

# Harness/fev.sh bookkeeping files the model must never write. Observed
# dodge: a model "overruled" a NO_CHANGE by editing status.json + tracker.md,
# touching no design file yet getting credited with work.
HARNESS_FILES = {"status.json", "e6_state.json", "feved.tlv", "fully_feved.tlv",
                 "match_lines.eqy", "orig.sv", "prepared.sv"}
DESIGN_FILES_RE = re.compile(r"^(wip\.tlv|fev.*\.eqy|config\.json)$")

def expand_omissions(new, orig):
    # The "..." mechanism (ported from the conversion-to-TLV repo): a "..."
    # line stands for an UNCHANGED region taken from the original file. Diff
    # line-by-line; every hunk containing "..." must map cleanly onto a block
    # of original lines. "..." mixed with edited lines in one hunk is
    # ambiguous: return None so the caller requests the full file instead of
    # guessing.
    import difflib
    nl, ol = new.split("\n"), orig.split("\n")
    out = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, nl, ol, autojunk=False).get_opcodes():
        chunk = nl[i1:i2]
        if tag == "equal":
            out.extend(chunk)
            continue
        dots = [l for l in chunk if l.strip() == "..."]
        if not dots:
            out.extend(chunk)
        elif len(dots) == len(chunk):
            out.extend(ol[j1:j2])
        else:
            return None
    return "\n".join(out)

SR_BLOCK_RE = re.compile(r"<<<<<<< SEARCH\n(.*?)\n=======\n?(.*?)\n?>>>>>>> REPLACE", re.S)

def apply_search_replace(body, orig):
    # Aider-style search/replace: every SEARCH block must match the original
    # exactly ONCE (same whitespace). Returns (new_text, err); a non-None err
    # goes back to the model as feedback.
    pos = 0
    out = orig
    blocks = list(SR_BLOCK_RE.finditer(body))
    if not blocks:
        return None, "No valid <<<<<<< SEARCH/=======/>>>>>>> REPLACE blocks found."
    leftover = SR_BLOCK_RE.sub("", body).strip()
    if leftover:
        return None, ("Content found outside search/replace blocks. For an existing file, "
                      "provide ONLY search/replace blocks, or the complete file with none.")
    for m in blocks:
        search, replace = m.group(1), m.group(2)
        n = out.count(search)
        if n == 0:
            return None, ("SEARCH text not found in the current file (must match exactly, "
                          "including whitespace):\n" + search[:400])
        if n > 1:
            return None, ("SEARCH text matches the current file more than once; add more "
                          "surrounding context lines to make it unique:\n" + search[:400])
        out = out.replace(search, replace, 1)
    return out, None

APPLY_ERROR = ""

def apply_files(text):
    global APPLY_ERROR
    APPLY_ERROR = ""
    changed = []
    originals = {}
    for m in re.finditer(r"===FILE: (\S+)===\n(.*?)\n?===END===", text, re.S):
        name, body = m.group(1), m.group(2)
        if "/" in name or name.startswith(".") or name in HARNESS_FILES:
            continue
        p = os.path.join(MDIR, name)
        orig = open(p).read() if os.path.exists(p) else None
        if "<<<<<<< SEARCH" in body:
            if orig is None:
                APPLY_ERROR = (f"File {name} is new but uses search/replace blocks; "
                               "new files must be written out in full.")
                restore(originals)
                return [], {}
            body, err = apply_search_replace(body, orig)
            if body is None:
                APPLY_ERROR = f"Search/replace edit for {name} failed: {err}"
                restore(originals)
                return [], {}
        elif any(l.strip() == "..." for l in body.split("\n")):
            if orig is None:
                APPLY_ERROR = (f"File {name} is new but uses \"...\" omission lines; "
                               "new files must be written out in full.")
                restore(originals)
                return [], {}
            body = expand_omissions(body, orig)
            if body is None:
                APPLY_ERROR = (f"The \"...\" omission lines in {name} could not be mapped "
                               "unambiguously onto the original file (a \"...\" was mixed with "
                               "changed lines in the same region). Resend the COMPLETE file "
                               "contents without \"...\" lines.")
                restore(originals)
                return [], {}
        originals[name] = orig
        with open(p, "w") as f:
            f.write(body.rstrip() + "\n")
        changed.append(name)
    return changed, originals

def restore(originals):
    for name, body in originals.items():
        p = os.path.join(MDIR, name)
        if body is None:
            if os.path.exists(p):
                os.remove(p)
        else:
            with open(p, "w") as f:
                f.write(body)

def snapshot_module():
    snap = {}
    for f in os.listdir(MDIR):
        p = os.path.join(MDIR, f)
        if os.path.isfile(p):
            try:
                snap[f] = open(p, encoding="utf-8", errors="replace").read()
            except OSError:
                pass
    return snap

AGENT_PREAMBLE = (
    "You are a digital-design refactoring agent converting Verilog to TL-Verilog in "
    "small, formally verified steps. You are working directly in this module directory. "
    "Perform ONE refactoring task by editing the design files in place: wip.tlv, "
    "fev.eqy, fev_full*.eqy, config.json, tracker.md. Rules:\n"
    "- Do NOT run fev.sh, docker, or any command; the harness runs formal verification "
    "after you finish, and a separate reviewing agent checks that the task's goal was "
    "actually achieved. It cannot be talked into approving unfinished work.\n"
    "- Do NOT edit these harness files: status.json, e6_state.json, feved.tlv, "
    "fully_feved.tlv, orig.sv, prepared.sv, match_lines.eqy, attempts.jsonl.\n"
    "- If the task genuinely requires no change, edit nothing and end your reply with "
    "NO_CHANGE plus a ===JUSTIFICATION===/===END=== block naming the exact constructs "
    "and why; vague effort claims are rejected.\n"
    "- When your edits are complete, stop and summarize what you changed in 2-3 "
    "sentences.\n\n"
)

def run_agent_worker(task_text, feedback):
    prompt = AGENT_PREAMBLE + "# Task\n\n" + task_text + "\n"
    if feedback:
        prompt += ("\n# Previous attempt FAILED verification. Tool output:\n\n"
                   + feedback[-3000:] + "\n\nFix the problem by editing the files.\n")
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)
    argv = [AGENT_CMD, "-p", "--model", AGENT_MODEL,
            "--max-turns", str(AGENT_MAX_TURNS),
            "--permission-mode", "acceptEdits",
            "--allowedTools", "Read,Edit,Write,Grep,Glob"]
    t_start = time.time()
    try:
        r = subprocess.run(argv, input=prompt, capture_output=True, text=True,
                           timeout=AGENT_TIMEOUT, cwd=MDIR, env=env)
        report = (r.stdout or "") + (("\n[stderr] " + r.stderr) if r.returncode != 0 and r.stderr else "")
    except subprocess.TimeoutExpired:
        report = f"[agent timed out after {AGENT_TIMEOUT}s]"
    return report.strip(), time.time() - t_start

SERV_DIR = os.environ.get("MM_SERV_DIR", os.path.abspath("serv"))
LLMTLV_DIR = os.environ.get("MM_LLMTLV_DIR", os.path.abspath("LLM_TLV"))
TOOLSHIM_DIR = os.environ.get("MM_TOOLSHIM_DIR", os.path.join(ROUTER_DIR, "toolshim"))
DOCKER_IMAGE = os.environ.get("MM_DOCKER_IMAGE", "mm-convert:latest")
DOCKER_USER = os.environ.get("MM_DOCKER_USER", "")

def run_in_module(cmd, timeout=3600):
    argv = ["docker", "run", "--rm"]
    if DOCKER_USER:
        argv += ["-u", DOCKER_USER]
    argv += ["-v", SERV_DIR + ":/workspace/proj:rw",
        "-v", LLMTLV_DIR + ":/home/steve/repos/LLM_TLV:ro",
        "-v", TOOLSHIM_DIR + ":/toolshim:ro",
        "-w", "/workspace/proj/tlv/" + os.path.basename(MDIR),
        "--entrypoint", "bash", DOCKER_IMAGE, "-lc",
        "export PATH=/toolshim:/opt/oss-cad-suite/bin:$PATH; " + cmd]
    r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    return r.stdout + r.stderr

def run_fev():
    out = run_in_module("./scripts/fev.sh 2>&1")
    return "All FEV runs successful" in out, out

def enrich_feedback(out):
    m = re.search(r"wip\.sv:(\d+): ERROR", out)
    p = os.path.join(MDIR, "wip.sv")
    if m and os.path.exists(p):
        ln = int(m.group(1))
        lines = open(p).read().splitlines()
        lo, hi = max(0, ln - 8), min(len(lines), ln + 8)
        excerpt = "\n".join(f"{i+1}: {lines[i]}" for i in range(lo, hi))
        out += ("\n\n# The Verilog that SandPiper GENERATED from your wip.tlv, around the error line:\n"
                + excerpt +
                "\n\nCompare this generated Verilog against your TLV source to see how your TLV was interpreted.")
    return out

# Tasks that are deterministic scripts run directly, costing no API call.
SCRIPT_TASKS = {"No Tabs": "./scripts/no_tabs.py 2>&1"}

# Oversight judge: FEV only proves behavior is unchanged, not that the
# refactoring GOAL was achieved (e.g. an if left untouched inside \SV_plus
# still passes FEV). A SEPARATE LLM call answers only pass/fail on intent;
# it has no incentive to declare success on the worker's behalf. FAIL routes
# the reason back through the same retry path as a FEV failure, then judges
# again. MM_JUDGE=0 disables; MM_CHECKS adds per-task criteria files.
JUDGE_ON = os.environ.get("MM_JUDGE", "1") == "1"
JUDGE_SYSTEM = (
    "You are a strict, skeptical hardware-refactoring reviewer. Formal equivalence "
    "checking has ALREADY proven the code's behavior is unchanged; that is not your "
    "question. Your only question is whether the stated refactoring goal was actually "
    "achieved in the resulting code. Refactoring agents sometimes dodge: leaving "
    "constructs untouched inside \\SV_plus blocks, renaming without restructuring, or "
    "declaring work done that was not performed. If the goal was to eliminate or convert "
    "a construct and it survives anywhere, including inside \\SV_plus, the verdict is "
    "FAIL, with one exception: the agent may supply a technical justification for "
    "residual incompleteness, and you may PASS if and only if that justification is "
    "specific to the exact surviving constructs and technically sound (a real tool "
    "limitation or a construct with no equivalent), not a vague effort claim. "
    "Reply with exactly:\nVERDICT: PASS\nor\nVERDICT: FAIL\nREASON: <short paragraph "
    "pointing at the specific lines or constructs showing the goal was not met>"
)

# The verdict goes into its OWN file in the checkpoint fev.sh just
# recorded: status.json belongs to the agent/harness, judge.json is written
# only by the router, and the Console renders it like any checkpoint file.
# The judge runs AFTER recording, so it writes into the newest history dir.
def write_judge_record(tname, passed, reason, cost_usd):
    hist = os.path.join(MDIR, "history")
    try:
        nums = sorted([d for d in os.listdir(hist) if d.isdigit()], key=int)
    except OSError:
        return
    if not nums:
        return
    with open(os.path.join(hist, nums[-1], "judge.json"), "w") as f:
        json.dump({"verdict": "PASS" if passed else "FAIL", "reason": reason,
                   "cost_usd": round(cost_usd, 4), "model": MODEL_NAME["claude"],
                   "task": tname}, f, indent=1)

def judge(tname, task, before, after, justification=None, nochange=False):
    check_path = os.path.join(os.environ.get("MM_CHECKS", os.path.join(ROUTER_DIR, "checks")),
                              re.sub(r"[^A-Za-z0-9]+", "_", tname) + ".txt")
    u = "# Refactoring task that was performed\n\n" + task + "\n"
    if os.path.exists(check_path):
        u += "\n# Specific acceptance criteria for this task\n\n" + open(check_path).read() + "\n"
    if nochange:
        u += "\n===FILE: wip.tlv (proposed UNCHANGED)===\n" + before + "\n===END===\n"
        u += ("\nThe worker agents concluded this task requires NO change to this code, and a "
              "second model cross-checked and agreed. There is deliberately no diff to review; "
              "do not fail merely because the files are identical. Judge whether no-change is "
              "the CORRECT outcome: PASS if the task's goal is already satisfied in this code "
              "or genuinely does not apply to it; FAIL if the task still requires work here.\n")
    else:
        u += "\n===FILE: wip.tlv BEFORE the task===\n" + before + "\n===END===\n"
        u += "\n===FILE: wip.tlv AFTER the task===\n" + after + "\n===END===\n"
    if justification:
        u += ("\n# The refactoring agent's justification for any remaining incompleteness\n\n"
              + justification + "\n\nAccept this only if it is specific and technically sound "
              "for the exact constructs left unconverted; reject vague effort claims.\n")
    u += "\nWas the refactoring goal achieved?"
    resp, ju = call_with_retry("claude", (u, ""), system=JUDGE_SYSTEM)
    jc = track("claude", ju)
    passed = bool(re.search(r"VERDICT:\s*PASS", resp))
    m = re.search(r"REASON:\s*(.+)", resp, re.S)
    reason = m.group(1).strip()[:2000] if m else resp.strip()[:2000]
    return passed, reason, jc

# Acceptance criterion beyond FEV (blocks "dodge by creating no files"):
# MM_ACCEPT_GLOB names a glob whose match count must INCREASE during the task.
import glob as _glob
ACCEPT_GLOB = os.environ.get("MM_ACCEPT_GLOB", "")

def accept_count():
    return len(_glob.glob(os.path.join(MDIR, ACCEPT_GLOB))) if ACCEPT_GLOB else 0

def acceptance_ok(baseline):
    return (not ACCEPT_GLOB) or accept_count() > baseline

# MM_ACCEPT_DISTINCT=1: per-config generated designs (wip_*.sv) must truly
# differ. Blocks the "vacuous config" dodge where a hardcoded var() in
# wip.tlv overrides the per-config m5 define, every config elaborates to the
# same design, and FEV passes meaninglessly.
ACCEPT_DISTINCT = os.environ.get("MM_ACCEPT_DISTINCT", "") == "1"

def distinct_ok():
    if not ACCEPT_DISTINCT:
        return True
    svs = sorted(_glob.glob(os.path.join(MDIR, "wip_*.sv")))
    if len(svs) < 2:
        return True
    bodies = [open(p).read() for p in svs]
    return any(b != bodies[0] for b in bodies[1:])

def revert():
    body = snap("feved.tlv")
    if body:
        with open(os.path.join(MDIR, "wip.tlv"), "w") as f:
            f.write(body)

cost = {"deepseek": 0.0, "claude": 0.0}
cache_totals = {"read": 0, "write": 0, "in": 0}

def track(provider, u):
    # Cache pricing per the official price sheets: anthropic cache write is
    # 1.25x input and cache read 0.1x input; deepseek cache hit ~0.1x miss.
    if provider == "deepseek":
        c = (u["in"]*0.14 + u["cache_read"]*0.014 + u["out"]*0.28)/1e6
    else:
        c = (u["in"]*3.0 + u["cache_write"]*3.75 + u["cache_read"]*0.30 + u["out"]*15.0)/1e6
    cost[provider] += c
    cache_totals["read"] += u["cache_read"]
    cache_totals["write"] += u["cache_write"]
    cache_totals["in"] += u["in"]
    if cost[provider] > MAX_COST[provider]:
        print(f"!!! COST CAP: {provider} ${cost[provider]:.2f} > ${MAX_COST[provider]:.2f}, stopping safely")
        print_summary()
        sys.exit(2)
    return c

def cache_str(u):
    return f"cache r{u['cache_read']}/w{u['cache_write']}/u{u['in']}"

stats = []
t0 = time.time()
agent_wall = [0.0]

def print_summary():
    print("\n===== RUN SUMMARY =====")
    for t, u in stats:
        print(f"  {u:36} {t}")
    print(f"cost: deepseek ${cost['deepseek']:.4f} + claude ${cost['claude']:.4f} = ${cost['deepseek']+cost['claude']:.4f}")
    tot = cache_totals["read"] + cache_totals["in"]
    pct = 100.0 * cache_totals["read"] / tot if tot else 0.0
    print(f"cache: read {cache_totals['read']} / write {cache_totals['write']} / uncached {cache_totals['in']} (hit {pct:.0f}%)")
    print(f"wall clock: {(time.time()-t0)/60:.1f} min")
    if agent_wall[0]:
        print(f"agent worker wall: {agent_wall[0]/60:.1f} min (subscription, no API cost)")

STATE = os.path.join(MDIR, "e6_state.json")
_raw_state = json.load(open(STATE)) if os.path.exists(STATE) else {}
if "done" in _raw_state:
    done_tasks = _raw_state["done"]
    inflight = _raw_state.get("inflight") or {}
else:
    done_tasks = _raw_state
    inflight = {}

def save_state():
    json.dump({"done": done_tasks, "inflight": inflight}, open(STATE, "w"), indent=1)

PROVIDERS = [tuple(x.strip().split(":")) for x in os.environ.get("MM_PROVIDERS", "deepseek:2,claude:2").split(",") if x.strip()]
PROVIDERS = [(p, int(n)) for p, n in PROVIDERS]

# Preflight (audit Aug 25): fail fast with clear messages instead of burning
# retries or paid calls against a broken environment.
def _preflight():
    errs = []
    used = {p for p, _ in PROVIDERS}
    keyfiles = {"deepseek": os.path.expanduser(os.environ.get("MM_DEEPSEEK_KEY_FILE", "~/.secrets/deepseek_key"))}
    if JUDGE_ON or "claude" in used:
        keyfiles["claude"] = os.path.expanduser(os.environ.get("MM_ANTHROPIC_KEY_FILE", "~/.secrets/anthropic_key"))
    for prov, kf in keyfiles.items():
        if prov in used or (prov == "claude" and JUDGE_ON):
            if not os.path.isfile(kf):
                errs.append(f"API key file for {prov} not found: {kf}")
    if not os.path.isfile(os.path.join(MDIR, "scripts", "fev.sh")) and not os.path.islink(os.path.join(MDIR, "scripts")):
        errs.append(f"no scripts/fev.sh under {MDIR} (is this a conversion work dir?)")
    try:
        r = subprocess.run(["docker", "image", "inspect", DOCKER_IMAGE],
                           capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            errs.append(f"docker image {DOCKER_IMAGE} not found (build it from Dockerfile.fev)")
    except FileNotFoundError:
        errs.append("docker not found on PATH")
    except Exception as e:
        errs.append(f"docker preflight failed: {e}")
    if "agent" in used:
        try:
            subprocess.run([AGENT_CMD, "--version"], capture_output=True, timeout=30)
        except FileNotFoundError:
            errs.append(f"agent worker command not found: {AGENT_CMD} (install Claude Code)")
    if errs:
        sys.exit("PREFLIGHT FAILED:\n  - " + "\n  - ".join(errs))
_preflight()

for tname, tfile in ORDER:
    if tname in done_tasks:
        print(f"##### TASK: {tname} (previously completed: {done_tasks[tname]}, skip)")
        stats.append((tname, done_tasks[tname] + " (prior)"))
        continue
    task = open(tfile).read()
    hint_path = os.path.join(os.environ.get("MM_HINTS", os.path.join(ROUTER_DIR, "hints")),
                             re.sub(r"[^A-Za-z0-9]+", "_", tname) + ".txt")
    hinted = os.path.exists(hint_path)
    if hinted:
        task += "\n\n# Guidance from the user (after prior failed attempts)\n\n" + open(hint_path).read()
    print(f"\n##### TASK: {tname} [{time.strftime('%H:%M:%S')}]" + (" (with user guidance)" if hinted else ""))
    set_status_fields(task=tname)
    done = False
    used = None
    feedback = None
    burned = inflight.get("used", {}) if inflight.get("task") == tname else {}
    if burned:
        print(f"  (resuming mid-task: already burned {burned}, continuing with the next provider)")
    inflight = {"task": tname, "used": dict(burned)}
    save_state()
    accept_base = accept_count()
    task_before = snap("wip.tlv")
    sr_apply_fails = 0
    if tname in SCRIPT_TASKS:
        set_status_fields(model="script")
        sout = run_in_module(SCRIPT_TASKS[tname])
        ok, out = run_fev()
        print(f"  [script] {SCRIPT_TASKS[tname]} fev={'PASS' if ok else 'FAIL'}")
        if ok:
            done_tasks[tname] = "script"
            inflight = {}
            save_state()
            stats.append((tname, "script"))
            continue
        print("  [script] failed, handing to LLM with feedback")
        feedback = sout + "\n" + out
        revert()
    for pidx, (provider, tries) in enumerate(PROVIDERS):
        start = burned.get(provider, 0) + 1
        for a in range(start, tries + 1):
            inflight["used"][provider] = a
            save_state()
            if provider == "agent":
                print(f"  [agent #{a}] running Claude Code worker ...", flush=True)
                before_snap = snapshot_module()
                report, wall = run_agent_worker(task, feedback)
                after_snap = snapshot_module()
                touched_harness = [f for f in HARNESS_FILES
                                   if before_snap.get(f) != after_snap.get(f)]
                if touched_harness:
                    restore({f: before_snap.get(f) for f in touched_harness})
                    print(f"  [agent #{a}] RESTORED harness files it touched: {touched_harness}")
                changed = sorted(f for f in set(before_snap) | set(after_snap)
                                 if f not in HARNESS_FILES and f != "attempts.jsonl"
                                 and before_snap.get(f) != after_snap.get(f))
                originals = {f: before_snap.get(f) for f in changed}
                log_attempt_exchange(tname, "agent", a, feedback, report, 0.0)
                agent_wall[0] += wall
                if not changed:
                    nc_just = extract_justification(report)
                    print(f"  [agent #{a}] no design files changed (wall {wall:.0f}s) -> judged as NO_CHANGE")
                    if ACCEPT_GLOB and accept_count() <= accept_base:
                        feedback = (f"NO_CHANGE is not acceptable for this task: it explicitly requires "
                                    f"creating new files matching '{ACCEPT_GLOB}', and none exist yet. "
                                    f"Create the required files.")
                        continue
                    if JUDGE_ON:
                        jp, jreason, jc = judge(tname, task, task_before, task_before,
                                                justification=nc_just, nochange=True)
                        print(f"  [judge:no-change] {'PASS' if jp else 'FAIL'} (${jc:.4f})"
                              + ("" if jp else f": {jreason[:150]}"))
                        if not jp:
                            feedback = ("You made no edits, but a separate reviewing agent judged that "
                                        "this task DOES require work on this code. Its reason:\n\n"
                                        + jreason + "\n\nDo the required work by editing the files.")
                            continue
                    done = True; used = "agent (no-change)"; break
                files = changed
                set_status_fields(model=MODEL_NAME["agent"],
                                  cache={"in": 0, "out": 0, "cache_read": 0, "cache_write": 0})
                ok, out = run_fev()
                print(f"  [agent #{a}] files={files} fev={'PASS' if ok else 'FAIL'} (wall {wall:.0f}s)")
                if ok:
                    if acceptance_ok(accept_base) and distinct_ok():
                        if JUDGE_ON:
                            if "wip.tlv" in files:
                                jp, jreason, jc = judge(tname, task, task_before, snap("wip.tlv"),
                                                        justification=extract_justification(report))
                            else:
                                # Design credit without touching wip.tlv (audit Aug 25 dodge
                                # gap): judge whether leaving the design unchanged is the
                                # correct outcome for this task.
                                jp, jreason, jc = judge(tname, task, task_before, task_before,
                                                        justification=extract_justification(report), nochange=True)
                            write_judge_record(tname, jp, jreason, jc)
                            print(f"  [judge] {'PASS' if jp else 'FAIL'} (${jc:.4f})" + ("" if jp else f": {jreason[:150]}"))
                            if not jp:
                                feedback = ("FEV passed (behavior is preserved), but a separate reviewing agent "
                                            "judged the task goal NOT achieved. Its reason:\n\n" + jreason +
                                            "\n\nComplete the remaining refactoring from the current state of the files.")
                                continue
                        done = True; used = "agent"; break
                    if not acceptance_ok(accept_base):
                        print(f"  [agent #{a}] fev PASS but required outputs missing ({ACCEPT_GLOB}), rejected")
                        feedback = (f"FEV passed, but the task's required outputs are missing: no new files "
                                    f"matching '{ACCEPT_GLOB}' were created. The task explicitly requires "
                                    f"creating one per parameter set. Create them now.")
                    else:
                        print(f"  [agent #{a}] fev PASS but all per-config designs are IDENTICAL, rejected")
                        feedback = ("FEV passed, but all generated per-configuration designs (wip_*.sv) are "
                                    "byte-identical, so the alternate configuration does not actually change "
                                    "elaboration and the check is vacuous. Likely cause: a hardcoded m5 "
                                    "var(...) in wip.tlv overrides the per-config m5 definition. Restructure "
                                    "so the configuration genuinely affects the design, then re-verify.")
                    continue
                feedback = enrich_feedback(out)
                restore(originals)
                revert()
                continue
            print(f"  [{provider} #{a}] calling API ...", flush=True)
            resp, u = call_with_retry(provider, build_user(task, feedback))
            c = track(provider, u)
            print(f"    ({cache_str(u)})")
            log_attempt_exchange(tname, provider, a, feedback, resp, c)
            if is_no_change(resp):
                nc_just = extract_justification(resp)
                if nc_just:
                    feedback = ((feedback + "\n\n") if feedback else "") + \
                        "The previous model replied NO_CHANGE with this justification:\n" + nc_just
                if ACCEPT_GLOB and accept_count() <= accept_base:
                    print(f"  [{provider} #{a}] NO_CHANGE REJECTED (missing required output {ACCEPT_GLOB})")
                    feedback = (f"NO_CHANGE is not acceptable for this task: it explicitly requires "
                                f"creating new files matching '{ACCEPT_GLOB}', and none exist yet. "
                                f"Create the required files.")
                    continue
                if pidx + 1 < len(PROVIDERS):
                    checker = PROVIDERS[pidx + 1][0]
                    print(f"  [{provider} #{a}] NO_CHANGE (${c:.4f}) -> cross-check by {checker}")
                    vresp, vu = call_with_retry(checker, build_user(task, feedback))
                    vc = track(checker, vu)
                    if is_no_change(vresp):
                        print(f"  [{checker} verify] agrees NO_CHANGE (${vc:.4f})")
                        # Every NO_CHANGE outcome goes through the judge:
                        # workers never referee their own intent.
                        if JUDGE_ON:
                            jp, jreason, jc = judge(tname, task, task_before, task_before,
                                                    justification=nc_just, nochange=True)
                            print(f"  [judge:no-change] {'PASS' if jp else 'FAIL'} (${jc:.4f})"
                                  + ("" if jp else f": {jreason[:150]}"))
                            if not jp:
                                feedback = ("Both models proposed NO_CHANGE, but a separate reviewing "
                                            "agent judged that this task DOES require work on this code. "
                                            "Its reason:\n\n" + jreason + "\n\nDo the required work.")
                                continue
                        done = True; used = f"{provider}+{checker} (no-change agreed)"; break
                    vfiles, vorig = apply_files(vresp)
                    if vfiles and not any(DESIGN_FILES_RE.match(f) for f in vfiles):
                        # "Disagreed" but touched no design file: an empty
                        # overrule, treated as agreeing NO_CHANGE.
                        restore(vorig)
                        print(f"  [{checker} verify] only touched non-design files {vfiles}, treated as agreeing NO_CHANGE (${vc:.4f})")
                        if JUDGE_ON:
                            jp, jreason, jc = judge(tname, task, task_before, task_before,
                                                    justification=nc_just, nochange=True)
                            print(f"  [judge:no-change] {'PASS' if jp else 'FAIL'} (${jc:.4f})"
                                  + ("" if jp else f": {jreason[:150]}"))
                            if not jp:
                                feedback = ("Both models proposed NO_CHANGE, but a separate reviewing "
                                            "agent judged that this task DOES require work on this code. "
                                            "Its reason:\n\n" + jreason + "\n\nDo the required work.")
                                continue
                        done = True; used = f"{provider}+{checker} (no-change agreed)"; break
                    if vfiles:
                        set_status_fields(model=MODEL_NAME[checker], cache=vu)
                        ok, out = run_fev()
                        print(f"  [{checker} verify] DISAGREES, files={vfiles} fev={'PASS' if ok else 'FAIL'} (${vc:.4f})")
                        if ok:
                            if JUDGE_ON:
                                if "wip.tlv" in vfiles:
                                    jp, jreason, jc = judge(tname, task, task_before, snap("wip.tlv"),
                                                            justification=extract_justification(vresp))
                                else:
                                    # Design credit without touching wip.tlv (audit Aug 25 dodge
                                    # gap): judge whether leaving the design unchanged is the
                                    # correct outcome for this task.
                                    jp, jreason, jc = judge(tname, task, task_before, task_before,
                                                            justification=extract_justification(vresp), nochange=True)
                                write_judge_record(tname, jp, jreason, jc)
                                print(f"  [judge] {'PASS' if jp else 'FAIL'} (${jc:.4f})" + ("" if jp else f": {jreason[:150]}"))
                                if not jp:
                                    feedback = ("FEV passed, but a separate reviewing agent judged the task goal "
                                                "NOT achieved. Its reason:\n\n" + jreason +
                                                "\n\nComplete the remaining refactoring from the current state of the files.")
                                    continue
                            done = True; used = f"{checker} (overruled no-change)"; break
                        feedback = enrich_feedback(out)
                        restore(vorig)
                        revert()
                        continue
                    with open(os.path.join(MDIR, "unparsed_replies.log"), "a") as lf:
                        lf.write(f"\n===== {tname} [{checker} verify] {time.strftime('%H:%M:%S')} =====\n{vresp}\n")
                    print(f"  [{checker} verify] reply not parseable (logged), provisionally accepting NO_CHANGE")
                    if JUDGE_ON:
                        jp, jreason, jc = judge(tname, task, task_before, task_before,
                                                justification=nc_just, nochange=True)
                        print(f"  [judge:no-change] {'PASS' if jp else 'FAIL'} (${jc:.4f})"
                              + ("" if jp else f": {jreason[:150]}"))
                        if not jp:
                            feedback = ("A NO_CHANGE claim was judged incorrect by the reviewing agent. "
                                        "Its reason:\n\n" + jreason + "\n\nDo the required work.")
                            continue
                    done = True; used = provider + " (no-change unverified)"; break
                else:
                    print(f"  [{provider} #{a}] NO_CHANGE (${c:.4f})")
                    if JUDGE_ON:
                        jp, jreason, jc = judge(tname, task, task_before, task_before,
                                                justification=nc_just, nochange=True)
                        print(f"  [judge:no-change] {'PASS' if jp else 'FAIL'} (${jc:.4f})"
                              + ("" if jp else f": {jreason[:150]}"))
                        if not jp:
                            feedback = ("A NO_CHANGE claim was judged incorrect by the reviewing agent. "
                                        "Its reason:\n\n" + jreason + "\n\nDo the required work.")
                            continue
                    done = True; used = provider + " (no-change)"; break
            files, originals = apply_files(resp)
            if not files:
                log_unparsed(tname, f"{provider} #{a}", resp)
                print(f"  [{provider} #{a}] reply not parseable (logged), retry")
                feedback = APPLY_ERROR or "Your reply did not follow the ===FILE:===/===END=== format."
                # Hard fallback for search/replace (agreed with Steve, Aug 18): the
                # dots path fails soft to a full-file request, sr previously kept
                # retrying blocks forever. After two failed applies, blocks are
                # banned for the rest of the task.
                if EDIT_FORMAT == "sr" and "earch/replace" in feedback:
                    sr_apply_fails += 1
                    if sr_apply_fails >= 2:
                        feedback += ("\n\nSearch/replace blocks have now failed to apply "
                                     f"{sr_apply_fails} times on this task. Do NOT send any more "
                                     "search/replace blocks: reply with the COMPLETE updated file "
                                     "contents inside the ===FILE:===/===END=== block.")
                continue
            sr_apply_fails = 0
            set_status_fields(model=MODEL_NAME[provider], cache=u)
            ok, out = run_fev()
            print(f"  [{provider} #{a}] files={files} fev={'PASS' if ok else 'FAIL'} (${c:.4f})")
            if ok:
                if acceptance_ok(accept_base) and distinct_ok():
                    if JUDGE_ON:
                        if "wip.tlv" in files:
                            jp, jreason, jc = judge(tname, task, task_before, snap("wip.tlv"),
                                                    justification=extract_justification(resp))
                        else:
                            # Design credit without touching wip.tlv (audit Aug 25 dodge
                            # gap): judge whether leaving the design unchanged is the
                            # correct outcome for this task.
                            jp, jreason, jc = judge(tname, task, task_before, task_before,
                                                    justification=extract_justification(resp), nochange=True)
                        write_judge_record(tname, jp, jreason, jc)
                        print(f"  [judge] {'PASS' if jp else 'FAIL'} (${jc:.4f})" + ("" if jp else f": {jreason[:150]}"))
                        if not jp:
                            feedback = ("FEV passed (behavior is preserved), but a separate reviewing agent "
                                        "judged the task goal NOT achieved. Its reason:\n\n" + jreason +
                                        "\n\nComplete the remaining refactoring from the current state of the files.")
                            continue
                    done = True; used = provider; break
                if not acceptance_ok(accept_base):
                    print(f"  [{provider} #{a}] fev PASS but required outputs missing ({ACCEPT_GLOB}), rejected")
                    feedback = (f"FEV passed, but the task's required outputs are missing: no new files "
                                f"matching '{ACCEPT_GLOB}' were created. The task explicitly requires "
                                f"creating one per parameter set. Create them now.")
                else:
                    print(f"  [{provider} #{a}] fev PASS but all per-config designs are IDENTICAL, rejected")
                    feedback = ("FEV passed, but all generated per-configuration designs (wip_*.sv) are "
                                "byte-identical, so the alternate configuration does not actually change "
                                "elaboration and the check is vacuous. Likely cause: a hardcoded m5 "
                                "var(...) in wip.tlv overrides the per-config m5 definition. Restructure "
                                "so the configuration genuinely affects the design, then re-verify.")
                continue
            feedback = enrich_feedback(out)
            restore(originals)
            revert()
        if done:
            break
    stats.append((tname, used if done else "FAILED"))
    if done:
        done_tasks[tname] = used
        inflight = {}
        save_state()
    if not done:
        print(f"  !!! TASK FAILED, attempt budget exhausted, stopping here")
        inflight = {}
        save_state()
        break

print_summary()
