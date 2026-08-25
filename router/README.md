# Per-task LLM router for Verilog -> TL-Verilog conversion

This is the router behind the serv_rf_ram ($1.62) and serv_immdec (~$10 with
every failed round included) conversions: one stateless API call per attempt,
a cheap model first with escalation, and formal equivalence checking as the
only gate. It drives the same task list and fev.sh harness as the desktop
agent flow in the LLM_TLV repo; only the model-invocation layer is different.

## Why it is cheap

1. Every attempt is a fresh call built as three blocks: the common guide
   (identical across all tasks and modules), the task + current files
   (identical across retries within a task), and the latest feedback. Cache
   breakpoints sit after the first two blocks, so retries are mostly cache
   reads. Retry attempts routinely hit 90%+ input cache.
2. deepseek attempts each task first; claude only sees tasks deepseek failed.
   On serv_rf_ram deepseek handled 21 of 45 checkpoints for about 7 cents.
3. The full desktop instructions ride along in the cached prefix, so nothing
   is re-sent at full price.

## What keeps it honest

- fev.sh must print "All FEV runs successful" for a task to advance. No
  exceptions; the router never edits harness files, and models cannot either
  (HARNESS_FILES blocklist).
- An oversight judge (separate LLM call, skeptical system prompt) checks the
  refactoring INTENT after FEV passes; its FAIL reason feeds the retry loop.
- NO_CHANGE claims are cross-checked by the next provider, then judged.
- MM_ACCEPT_GLOB / MM_ACCEPT_DISTINCT block the observed work-dodging moves
  (no files created; per-config designs byte-identical).
- attempts.jsonl records every attempt's feedback-in and full reply; the
  Console's Attempts tab renders it.

## Setup

1. Key files (plain text, one key per line):
   - `~/.secrets/deepseek_key` (or MM_DEEPSEEK_KEY_FILE)
   - `~/.secrets/anthropic_key` (or MM_ANTHROPIC_KEY_FILE)
2. A docker image with the toolchain (sandpiper-saas, oss-cad-suite, jq,
   make, time, diffutils). See Dockerfile.fev in the LLM_TLV repo (PR #19).
3. Checkouts of the serv repo (with tlv/<module> work dirs) and LLM_TLV.

## Run

```
MM_SERV_DIR=/path/to/serv \
MM_LLMTLV_DIR=/path/to/LLM_TLV \
MM_ORDER=router/tasks/order.json \
MM_PROVIDERS="deepseek:2,claude:6" \
python3 router/router.py /path/to/serv/tlv/<module_dir>
```

The router resumes: completed tasks and the in-flight attempt budget live in
`<module_dir>/e6_state.json`, so rerunning the same command continues where
it stopped (survives network drops and machine sleep; run it in tmux on a
server and your laptop is irrelevant).

## Environment reference

| Variable | Default | Meaning |
|---|---|---|
| MM_ORDER | router/tasks/order.json | task list, [name, task-file] pairs |
| MM_PROVIDERS | deepseek:2,claude:2 | attempt budget per provider, in order |
| MM_EDIT_FORMAT | dots | dots (whole file with "..." omissions) or sr (search/replace blocks) |
| MM_JUDGE | 1 | oversight judge on/off |
| MM_CHECKS | router/checks | per-task judge criteria files |
| MM_HINTS | router/hints | per-task user guidance files, appended to the task prompt |
| MM_COMMON_GUIDE | router/common_guide.md | the cached common block |
| MM_ACCEPT_GLOB | (off) | glob whose match count must increase during the task |
| MM_ACCEPT_DISTINCT | (off) | 1 = per-config wip_*.sv must differ |
| MM_MAX_COST_DEEPSEEK / _CLAUDE | 2.0 / 5.0 | USD safety caps per run |
| MM_SERV_DIR / MM_LLMTLV_DIR / MM_TOOLSHIM_DIR | ./serv, ./LLM_TLV, router/toolshim | docker mounts |
| MM_DOCKER_IMAGE / MM_DOCKER_USER | mm-convert:latest / (none) | toolchain container |
| MM_DEEPSEEK_KEY_FILE / MM_ANTHROPIC_KEY_FILE | ~/.secrets/... | API key file paths |

## Hints: the ratchet

When a task fails its whole attempt budget, the run stops. Write what you
learned into `hints/<Task_Name>.txt` (mine the previous conversion's history
for the verified pattern; verify fixes by hand through fev.sh before turning
them into a hint) and rerun; the hint is appended to the task prompt as user
guidance. `hints_examples/serv_immdec/` contains the full hint set that
carried both serv_immdec A/B runs to completion, as a reference for the
style: state why the attempts failed, give the verified pattern byte-exact,
and say explicitly what not to touch.

## Edit formats and the A/B result

Both formats are implemented (MM_EDIT_FORMAT). The serv_immdec A/B (same
module, tasks, models, hints) finished 24/24 on both, $9.93 for dots vs
$11.78 for sr, with the gap concentrated in one whole-file restructure task
that search/replace blocks could not express. dots is the default; sr fails
hard to a full-file requirement after two failed applies.
