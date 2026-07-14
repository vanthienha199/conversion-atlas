# Conversion Console frontend: API contract

The frontend in `static/` (`app.js`, `style.css`, `index.html`) is vanilla JS/CSS with no
build step and no framework. It talks to a backend over `GET /api/*` returning JSON. Any
backend that serves these endpoints (the Python `server.py` here, or a TypeScript port)
can host the same frontend files unchanged.

This file is the contract a replacement backend must satisfy. It ships inside the npm
package so the frontend and the contract version together.

## Installing the package

The package is versioned with git tags on this repo:

```
npm install github:vanthienha199/conversion-atlas#v1.0.0
```

Then reference `node_modules/conversion-atlas-ui/static/app.js`, `static/style.css`, and
`static/index.html`. To pick up a newer UI, bump the tag and read the diff between tags.

## Endpoints

All endpoints are `GET` with query-string parameters and return JSON.

### `/api/scan`
Params: `refresh=1` to force a rescan.
Returns `{roots: [abs paths], modules: [module...], now: epoch}` where each module has
`id` (index), `name`, `rel`, `root`, `flavor` (`"gen1"` mod_ subfolder format or `"gen2"`
flat `history/NNN` format), `steps` (count).

### `/api/module?mod=<id>`
Full detail for one module: `{module, steps: [step...], current, tasks, root_files,
pending}`. Each step: `{key, n, task, fev, fev_cnt, model, llm, files, mtime, duration}`.
`model` is the model id that produced the checkpoint (from the checkpoint's
`status.json`; may be absent on older runs). `fev` is the raw `fev.sh` status string
(`"0: ..."` pass, other leading integers are failure codes).

### `/api/file?mod=<id>&step=<key>&name=<file>`
One file at one checkpoint. `step` is a step `key` (e.g. `history/007`) or `root` for the
module directory itself. Returns `{name, step, content}`; 404 `{error}` if missing.

### `/api/diff?mod=<id>&a_step=&a_name=&b_step=&b_name=`
Server-side diff of two files across checkpoints. Returns `{a, b, rows, changed}` where
`rows` are aligned line pairs for a side-by-side view.

### `/api/changes?mod=<id>&step=<key>`
Which files changed at this checkpoint relative to the previous one.

### `/api/task?mod=<id>&name=<task name>`
The instructions text for a task, extracted from the flow's `conversion_tasks.md`.
Fuzzy-matches when the recorded name has drifted from the current instructions file;
returns `{name, matched, exact, markdown}`. Without `name`, lists all tasks.

### `/api/tracker?mod=<id>`
`{markdown}` of the module's current `tracker.md`.

### `/api/guide?mod=<id>`
Optional per-module walkthrough JSON (from `guides/<name>.json`), else `{guide: null}`.

### `/api/sessions?mod=<id>` and `/api/session?id=<sid>&mod=<id>`
Agent transcript discovery and retrieval (cost summary, message stream). Optional:
the UI degrades gracefully when absent.

### `/api/fevlog?mod=<id>&step=<key>`
FEV tool output recorded for a checkpoint, when available.

### `/api/events`
Server-sent events stream used by Follow/Live mode. Emits a line when module state
changes so the timeline refreshes without polling. Optional: the UI polls `/api/scan`
as fallback.

## Static hosting expectations

`index.html` loads `style.css` and `app.js` from the same directory and expects the API
under the same origin at `/api/`. In a VS Code webview, rewrite those three URLs to
webview URIs and proxy `/api/` to the extension host.
