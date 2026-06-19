# Conversion Atlas

A web UI for exploring Verilog to TL-Verilog conversion history, built for the
[conversion-to-TLV](https://github.com/stevehoover/conversion-to-TLV) and
[LLM_TLV](https://github.com/stevehoover/LLM_TLV) flows.

Every refactoring step, its FEV result, the prompt that drove it, and the exact
code diff. Side by side. No more terminal archaeology.

![Conversion Atlas](docs/screenshot-diff.png)

## Quick start

```sh
python3 server.py <path-to-conversions> [more paths...]
# or run it with no arguments inside a conversion repo and it finds the dirs:
python3 server.py
# the guided lesson, against Steve's serv fork:
python3 server.py ~/repos/serv/tlv/serv_aligner
```

Open http://127.0.0.1:8765. That's it. No dependencies beyond Python 3.8+,
no npm, no build step, read-only against your files.

## Two modes, two layouts

- **Explore** (default): an engineer's workbench across ALL scanned modules.
  Task-grouped history timeline on the left; tabs for side-by-side diff,
  files, the prompt the agent followed, status metadata, tracker report, and
  Claude Code transcripts. This is the debugging view for the conversion team.
- **Lesson**: a Codecademy-style guided replay (instructions left, dark diff
  editor middle, verification terminal right, Back/Next at the bottom) for
  modules that ship a walkthrough in `guides/`.

## Guided lessons

`guides/<module>.json` holds a hand-written, beginner-friendly walkthrough for a
module: an intro plus a "what happened and why" narrative per step, shown in the
Learn panel above the raw agent instructions. `serv_aligner` (the smallest SERV
module, 15 steps) ships as the first guided lesson and is the recommended
starting point. Modules without a guide fall back to showing the raw task
instructions.

## What it shows

- **Module browser**: scans the given roots for conversion work dirs and lists
  every module with its current task and fev.sh status.
- **Timeline**: every checkpoint in `history/`, grouped into lanes by task,
  with per-step durations estimated from file mtimes. Arrow keys navigate. A
  difficulty bar above the timeline scales each task by its checkpoint count,
  so the tasks the agent struggled with stand out.
- **Live**: the timeline updates on its own as the agent writes new checkpoints
  (server-sent events), with a follow toggle to track the newest step and a flag
  when a task keeps running FEV without landing a checkpoint.
- **Diff**: side-by-side diff of `wip.tlv` (or any checkpointed file) between
  consecutive steps, with unchanged regions collapsed and changed words
  highlighted inline. The file list marks which files changed (M/A/D plus line
  counts) and surfaces the FEV `.eqy` when a step remaps signals. One click
  compares any step against `prepared.sv` for the cumulative change.
- **Prompt**: the task instructions the agent followed at that step, extracted
  from `conversion_tasks.md` (auto-located via the module's `scripts` symlink,
  a local LLM_TLV clone, or `--tasks-md`). Title drift between instruction
  versions is handled with fuzzy matching, disclosed in the UI.
- **Files**: view any file from any checkpoint or the working directory.
- **Agent notes**: the `status.json` metadata (`task`, `fev.sh`, `fev_cnt`,
  `llm` notes) per step.
- **Tracker**: rendered `tracker.md`.
- **Sessions**: renders the full agent conversation, including tool calls,
  from three sources, in priority order:
  1. `<module>/transcripts/*.jsonl` checked into the conversion repo itself,
     so transcripts travel with `git clone` (recommended: after a run, copy
     the session .jsonl from `~/.claude/projects/` into that folder)
  2. `~/.claude/projects/` on this machine, matched by the module's path
  3. a copied projects folder from another machine via `--claude-projects`,
     matched by module name (encoded paths differ across machines)

## Both flows supported

- **Gen 2** (`LLM_TLV/desktop_agent_verilog_conversion`): detects
  `wip.tlv` + `status.json`, reads `history/NNN/`.
- **Gen 1** (`conversion-to-TLV`): detects `history/<step>/mod_<n>/`, shows
  prompt descriptions from `prompt_id.txt`, renders the captured
  `messages.<api>.json` and `llm_response.txt` per modification, and marks
  reversion checkpoints.

## Options

```
--port N             port (default 8765)
--host H             bind address (default 127.0.0.1)
--tasks-md PATH      explicit conversion_tasks.md for the Prompt tab
--claude-projects P  Claude Code projects dir (default ~/.claude/projects)
```

## Notes

- Durations are derived from checkpoint directory mtimes, so they are only
  meaningful on the machine where the conversion ran (a fresh git clone
  resets them).
- The server is read-only and refuses paths outside the scanned roots.

Built by Ha Le for the Redwood EDA Summer Mentorship 2026.
