"use strict";

const $ = (s) => document.querySelector(s);
const state = {
  modules: [], modId: null, detail: null, stepIdx: -1,
  file: null, loaded: {}, mode: "explore", exTab: "diff",
  es: null, tail: true, liveSteps: null,
};

function showView() {
  const inGuide = state.mode === "guide";
  const has = state.detail != null;
  $("#guide").hidden = !inGuide;
  $("#empty").hidden = inGuide || has;
  $("#explore").hidden = inGuide || !has;
  $("#bottombar").hidden = inGuide || !has;
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function wordDiffMark(a, b) {
  const ta = String(a).split(/(\W)/), tb = String(b).split(/(\W)/);
  let p = 0;
  while (p < ta.length && p < tb.length && ta[p] === tb[p]) p++;
  let sa = ta.length, sb = tb.length;
  while (sa > p && sb > p && ta[sa - 1] === tb[sb - 1]) { sa--; sb--; }
  const wrap = (toks, lo, hi) => {
    const mid = esc(toks.slice(lo, hi).join(""));
    return esc(toks.slice(0, lo).join("")) + (mid ? `<mark>${mid}</mark>` : "") + esc(toks.slice(hi).join(""));
  };
  return [wrap(ta, p, sa), wrap(tb, p, sb)];
}

async function api(path, params) {
  const q = params ? "?" + new URLSearchParams(params).toString() : "";
  const r = await fetch("/api/" + path + q);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function md(src) {
  if (!src) return "";
  const lines = src.split("\n");
  let out = [], inCode = false, inList = false;
  const inline = (t) =>
    esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
  for (const ln of lines) {
    if (ln.startsWith("```")) {
      closeList();
      out.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(esc(ln) + "\n"); continue; }
    const h = ln.match(/^(#{1,4})\s+(.*)/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*[-*]\s+/.test(ln)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push("<li>" + inline(ln.replace(/^\s*[-*]\s+/, "")) + "</li>");
      continue;
    }
    closeList();
    if (ln.trim() === "") out.push("<br>");
    else out.push("<p>" + inline(ln) + "</p>");
  }
  closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("");
}

function syncHash() {
  const p = new URLSearchParams();
  p.set("v", state.mode);
  if (state.mode === "explore") {
    p.set("t", state.exTab);
    if (state.modId != null) p.set("m", state.modId);
    if (state.stepIdx >= 0) p.set("s", state.stepIdx);
  }
  history.replaceState(null, "", "#" + p.toString());
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { m: p.get("m"), s: p.get("s"), v: p.get("v"), t: p.get("t") };
}

function steps() { return state.detail ? state.detail.steps : []; }
function totalSteps() { return steps().length; }

function curStep() {
  const d = state.detail;
  if (!d) return null;
  return d.steps[state.stepIdx];
}

function taskGroups() {
  const d = state.detail, groups = [];
  let g = null;
  d.steps.forEach((s, idx) => {
    if (!g || s.task !== g.task) { g = { task: s.task, items: [] }; groups.push(g); }
    g.items.push({ s, idx });
  });
  return groups;
}

function activeGroup() {
  return taskGroups().find((g) => g.items.some((it) => it.idx === state.stepIdx));
}

function renderModuleSelect() {
  const sel = $("#module-select");
  sel.innerHTML = `<option value="">Choose a module…</option>` + state.modules.map((m) =>
    `<option value="${m.id}" ${m.id === state.modId ? "selected" : ""}>${esc(m.name)} · ${m.steps} steps (${m.flavor === "gen1" ? "gen 1" : "gen 2"})</option>`
  ).join("");
}

function renderModeToggle() {
  $("#mode-explore").classList.toggle("active", state.mode === "explore");
  $("#mode-guide").classList.toggle("active", state.mode === "guide");
}

function setMode(m) {
  if (m === state.mode) return;
  state.mode = m;
  renderModeToggle();
  showView();
  if (m === "explore" && state.detail) renderStep();
  syncHash();
}

function renderPills() {
  const groups = taskGroups();
  const host = $("#task-pills");
  const ai = groups.findIndex((g) => g.items.some((it) => it.idx === state.stepIdx));
  host.innerHTML = groups.map((g, i) =>
    `<span class="${i < ai ? "done" : i === ai ? "cur" : ""}" title="${esc(g.task || "")}"></span>`).join("");
  $("#tb-status").textContent = state.detail ? `${state.detail.module.name} · ${state.detail.flavor === "gen1" ? "gen 1" : "gen 2"}` : "";
}

async function renderGen1Prompt(body, s) {
  const d = state.detail;
  const msgs = (s.files || []).filter((f) => f.startsWith("messages.") && f.endsWith(".json"));
  const hasResp = (s.files || []).includes("llm_response.txt");
  if (!msgs.length && !hasResp) {
    body.innerHTML = `<div class="note">No prompt was captured for this checkpoint. It is either the initial code or a manual (human) edit.</div>
      <p>Refactoring step: <b>${esc(s.task || "n/a")}</b></p>`;
    return;
  }
  body.innerHTML = `<div class="note">This is the exact prompt sent to the model for this modification, and its response.</div><div class="chat"></div>`;
  const host = body.querySelector(".chat");
  for (const mf of msgs) {
    const fj = await api("file", { mod: d.module.id, step: s.key, name: mf });
    let parsed = null;
    try { parsed = JSON.parse(fj.content.replace(/\n(?=([^"]*"[^"]*")*[^"]*"[^"]*$)/g, "\\n")); } catch (_) {}
    if (Array.isArray(parsed)) {
      for (const m of parsed) {
        const text = typeof m.content === "string" ? m.content : (m.parts || []).join("\n");
        host.insertAdjacentHTML("beforeend",
          `<div class="bubble ${m.role === "user" ? "user" : ""}"><div class="who">${esc(m.role)}</div><pre>${esc(text)}</pre></div>`);
      }
    } else {
      host.insertAdjacentHTML("beforeend", `<div class="bubble"><div class="who">${esc(mf)}</div><pre>${esc(fj.content.slice(0, 30000))}</pre></div>`);
    }
  }
  if (hasResp) {
    const fj = await api("file", { mod: d.module.id, step: s.key, name: "llm_response.txt" });
    host.insertAdjacentHTML("beforeend", `<div class="bubble"><div class="who">model response</div><pre>${esc(fj.content.slice(0, 60000))}</pre></div>`);
  }
}

async function loadTaskInstructions(body, name) {
  const d = state.detail;
  body.innerHTML = `<div class="note">loading instructions…</div>`;
  try {
    const tj = await api("task", { mod: d.module.id, name });
    let note = "";
    if (tj.markdown && !tj.exact) {
      note = `<div class="note">This run recorded the task as "<b>${esc(name)}</b>". The instructions file has evolved since, so this shows the closest current match: "<b>${esc(tj.matched)}</b>".</div>`;
    } else if (!tj.markdown) {
      body.innerHTML = `<div class="note">Task "<b>${esc(name)}</b>" no longer exists in today's instructions file, so the original text is unavailable. The AI's own notes still describe what it did.</div>`;
      return;
    }
    body.innerHTML = note + `<div class="md">${md(tj.markdown)}</div>`;
  } catch (e) {
    body.innerHTML = `<div class="note">${esc(e.message)}</div>`;
  }
}

function fmtBytes(n) {
  if (n > 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n > 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}

function defaultFile(files) {
  for (const cand of ["wip.tlv", "fev.eqy"]) if (files.includes(cand)) return cand;
  const v = files.find((f) => f.endsWith(".v") || f.endsWith(".sv") || f.endsWith(".tlv"));
  return v || files[0];
}

function diffEndpoints(file) {
  const d = state.detail, idx = state.stepIdx, s = curStep();
  if (idx === 0) {
    const base = d.flavor === "gen2" && d.root_files.includes("prepared.sv") && file === "wip.tlv" ? "prepared.sv" : null;
    return { a_step: base ? "root" : s.key, a_name: base || file, b_step: s.key, b_name: file };
  }
  const prev = d.steps[idx - 1];
  const pkey = prev.reverted_to ? prev.key.split("/").slice(0, -1).concat(prev.reverted_to).join("/") : prev.key;
  return { a_step: pkey, a_name: file, b_step: s.key, b_name: file };
}

function stepStatus(s) {
  const raw = s.fev;
  if (raw == null || raw === "" || raw === "none") return { state: "none", label: "no FEV recorded" };
  const m = String(raw).match(/^\s*(\d+)\s*:\s*(.*)$/);
  if (!m) return { state: "ok", label: String(raw) };
  const code = +m[1], reason = m[2] || String(raw);
  return code === 0 ? { state: "ok", label: reason } : { state: "fail", code, label: reason };
}

function passCount() {
  return steps().filter((s) => stepStatus(s).state === "ok").length;
}

// Which model authored a checkpoint, as a compact colored chip. The full model id
// stays in the tooltip; the chip shows the family so the timeline scans at a glance.
function modelFamily(model) {
  const m = String(model || "").toLowerCase();
  if (!m) return null;
  if (m === "script") return "script";
  if (m.includes("deepseek")) return "deepseek";
  if (m.includes("claude")) return "claude";
  if (m.includes("gemini")) return "gemini";
  if (m.includes("gpt") || /\bo\d/.test(m)) return "openai";
  return "other";
}

function modelChip(model) {
  const fam = modelFamily(model);
  if (!fam) return "";
  return `<span class="model-chip ${fam}" title="${esc(model)}">${esc(fam)}</span>`;
}

// Prompt-cache hit share for the LLM call behind a checkpoint, when the run
// recorded it. Reads should dominate on retries within a task; a low share on
// a retry means the cached prefix was invalidated or expired.
function cacheChip(s) {
  const c = s.cache;
  if (!c) return "";
  const read = c.cache_read || 0, write = c.cache_write || 0, unc = c.in || 0;
  if (!read && !write && !unc) return "";
  const total = read + unc;
  const pct = total ? Math.round((100 * read) / total) : 0;
  return `<span class="cache-chip" title="prompt cache: ${read} read, ${write} written, ${unc} uncached input tokens">${pct}% cached</span>`;
}

// Copilot-style +added/-removed lines of source change at this checkpoint. The main
// signal is "did the code change at all", so zero-change steps show nothing.
function deltaChip(s) {
  if (!s.plus && !s.minus) return "";
  return `<span class="delta-chip" title="lines of code changed at this checkpoint">` +
    `<span class="d-plus">+${s.plus}</span> <span class="d-minus">-${s.minus}</span></span>`;
}

function renderExHeader() {
  const d = state.detail, m = d.module;
  const parts = m.name.split("_");
  const title = parts.length > 1
    ? `${esc(parts[0])}_<em>${esc(parts.slice(1).join("_"))}</em>`
    : esc(m.name);
  const complete = (d.root_files || []).includes("CONVERSION_COMPLETE.md");
  const ok = passCount(), total = d.steps.length;
  const stateChip = complete
    ? `<span class="chip ok">✓ Conversion complete</span>`
    : `<span class="chip">in progress · ${ok}/${total} checkpoints passed FEV</span>`;
  $("#ex-header").innerHTML = `
    <div class="mh-eyebrow">${esc(m.root)} / ${esc(m.rel)}</div>
    <h2 class="mh-title">${title}</h2>
    <div class="mh-chips">
      <span class="chip">${m.flavor === "gen1" ? "Gen 1 · prompt flow" : "Gen 2 · agentic flow"}</span>
      <span class="chip">${total} checkpoints · ${d.task_lanes.length} tasks</span>
      ${stateChip}
    </div>`;
}

function heatLevel(fails) {
  if (fails >= 10) return 4;
  if (fails >= 6) return 3;
  if (fails >= 3) return 2;
  if (fails >= 1) return 1;
  return 0;
}

function groupFails(grp) {
  return grp.items.filter((it) => stepStatus(it.s).state === "fail").length;
}

function renderDifficulty(groups) {
  const host = $("#ex-difficulty");
  if (!host) return;
  const max = Math.max(1, ...groups.map((g) => g.items.length));
  const activeGi = groups.findIndex((g) => g.items.some((it) => it.idx === state.stepIdx));
  host.innerHTML = `<div class="diff-bars">` + groups.map((g, gi) => {
    const n = g.items.length, fails = groupFails(g);
    const h = Math.max(8, Math.round((n / max) * 100));
    const failPct = n ? Math.round((fails / n) * 100) : 0;
    const tip = `${g.task || "task"}: ${n} checkpoint${n === 1 ? "" : "s"}, ${fails} failed FEV`;
    return `<button class="diff-bar${gi === activeGi ? " on" : ""}" data-gi="${gi}" title="${esc(tip)}" style="height:${h}%">
      <span class="seg fail" style="height:${failPct}%"></span><span class="seg pass"></span></button>`;
  }).join("") + `</div><div class="diff-legend">bar height is checkpoints per task; the red portion is failed FEV, where the agent struggled</div>`;
  host.querySelectorAll(".diff-bar").forEach((b) => {
    b.onclick = () => gotoStep(groups[+b.dataset.gi].items[0].idx);
  });
}

function renderExTimeline() {
  const tl = $("#ex-timeline");
  tl.innerHTML = "";
  const groups = taskGroups();
  renderDifficulty(groups);
  const icon = { ok: "✓", fail: "✗", none: "•" };
  groups.forEach((grp) => {
    const hasActive = grp.items.some((it) => it.idx === state.stepIdx);
    const fails = groupFails(grp), lvl = heatLevel(fails);
    const div = document.createElement("div");
    div.className = "tl-group" + (hasActive ? " open" : "");
    const head = document.createElement("button");
    head.className = "tl-group-head heat" + lvl + (hasActive ? " has-active" : "");
    const n = grp.items.length;
    const fbadge = fails ? `<span class="cnt fails" title="${fails} of ${n} checkpoints failed FEV">${fails} failed</span>` : "";
    head.innerHTML = `<span class="tw">▶</span><span class="tl-task">${esc(grp.task || "…")}</span>${fbadge}<span class="cnt total" title="${n} checkpoint${n === 1 ? "" : "s"} in this task">${n} step${n === 1 ? "" : "s"}</span>`;
    head.onclick = () => div.classList.toggle("open");
    div.appendChild(head);
    const list = document.createElement("div");
    list.className = "tl-group-steps";
    grp.items.forEach(({ s, idx }) => {
      const st = stepStatus(s);
      const nochange = st.state === "none";  // captured by prep/get_task, no FEV step ran
      const baseline = nochange && idx === 0;
      const b = document.createElement("button");
      b.className = `tl-step ${st.state}` + (nochange ? " nochange" : "") + (idx === state.stepIdx ? " active" : "");
      b.title = st.state === "fail" ? st.label
        : baseline ? "prepared baseline (no source change yet)"
        : nochange ? "no source change for this task" : (s.llm || "");
      const right = nochange
        ? `<span class="nc-tag">${baseline ? "baseline" : "no change"}</span>`
        : `<span class="dur">${esc(s.duration || "")}</span>`;
      b.innerHTML = `<span class="ic">${icon[st.state]}</span>
        <span>Step ${esc(String(s.n))}</span>
        ${modelChip(s.model)}
        ${deltaChip(s)}
        ${cacheChip(s)}
        ${right}`;
      b.onclick = () => gotoStep(idx);
      list.appendChild(b);
    });
    div.appendChild(list);
    tl.appendChild(div);
  });
  const total = totalSteps();
  $("#ex-meta").textContent = `${Math.min(state.stepIdx + 1, total)} of ${total}`;
  $("#ex-progress").style.width = total ? `${((state.stepIdx + 1) / total) * 100}%` : "0%";
  const act = tl.querySelector(".tl-step.active");
  if (act) act.scrollIntoView({ block: "nearest" });
}

function nextPassingStep() {
  const d = state.detail;
  for (let i = state.stepIdx + 1; i < d.steps.length; i++) {
    if (stepStatus(d.steps[i]).state === "ok") return d.steps[i];
  }
  return null;
}

function failHint(code) {
  if (code === 2) return "This step did not compile: SandPiper rejected the TL-Verilog.";
  if (code === 3) return "This step compiled but failed formal equivalence against the previous step.";
  if (code === 4) return "This step passed the incremental check but failed full equivalence against the original Verilog.";
  return "This step did not pass FEV.";
}

async function showFixDiff(np) {
  if (!np) return;
  const d = state.detail, s = curStep();
  const files = s.files && s.files.length ? s.files : d.root_files;
  const file = files.includes("wip.tlv") ? "wip.tlv"
    : (state.file && files.includes(state.file) ? state.file : defaultFile(files));
  state.exTab = "diff";
  renderExTabs();
  const p = $("#ex-panel");
  p.innerHTML = `
    <div class="panel-toolbar diff-toolbar">
      <span class="diff-summary">Why it failed: <b>step ${s.n}</b> (✗) compared with the fix at <b>step ${np.n}</b> (✓)</span>
      <button class="btn-mini" id="ex-fix-back">← back to this step</button>
    </div>
    <div id="ex-diff-host"><div class="note">loading…</div></div>`;
  $("#ex-fix-back").onclick = () => renderExPanel();
  try {
    const dj = await api("diff", { mod: d.module.id, a_step: s.key, a_name: file, b_step: np.key, b_name: file });
    renderSxS($("#ex-diff-host"), dj.rows, `step ${s.n} · ${file} (failed)`, `step ${np.n} · ${file} (fix)`);
  } catch (e) {
    $("#ex-diff-host").innerHTML = `<div class="note">${esc(e.message)}</div>`;
  }
}

function renderExBanner() {
  const d = state.detail, s = curStep();
  if (!s) return;
  const st = stepStatus(s);
  let badges = st.state === "fail"
    ? `<span class="badge bad" title="${esc(st.label)}">✗ FEV failed: ${esc(st.label)}</span>`
    : st.state === "none"
    ? `<span class="badge">setup step (no FEV)</span>`
    : `<span class="badge ok" title="Proven equivalent by formal verification">✓ FEV verified</span>`;
  if (s.duration) badges += `<span class="badge info">took ${esc(s.duration)}</span>`;
  if (s.model) badges += `<span class="badge model ${modelFamily(s.model)}" title="model that produced this checkpoint">${esc(s.model)}</span>`;
  if (s.plus || s.minus) badges += `<span class="badge delta" title="lines of code changed at this checkpoint"><span class="d-plus">+${s.plus}</span> <span class="d-minus">-${s.minus}</span></span>`;
  let failBlock = "";
  if (st.state === "fail") {
    const np = nextPassingStep();
    failBlock = `<div class="fail-hint"><b>${esc(failHint(st.code))}</b> ` +
      (np ? `The agent kept working from here. Compare with the fix to see what changed. <button class="btn-mini" id="ex-fix">⤳ diff vs the fix (step ${np.n})</button>`
          : `No later passing checkpoint to compare against.`) + `</div>`;
  }
  $("#ex-banner").innerHTML = `
    <div class="step-banner">
      <div class="sb-top">
        <h3>Step ${esc(String(s.n))}</h3>
        <span class="sb-pos">of ${d.steps.length}</span>
        ${badges}
        ${s.task ? `<span class="sb-pos">· ${esc(s.task)}</span>` : ""}
      </div>
      ${s.llm ? `<div class="hint"><b>AI note:</b> ${esc(s.llm)}</div>` : ""}
      ${failBlock}
    </div>`;
  const fb = $("#ex-fix");
  if (fb) fb.onclick = () => showFixDiff(nextPassingStep());
}

const EXTABS = [
  ["diff", "Diff"], ["files", "Files"],
  ["notes", "Status"], ["fev", "FEV"], ["tracker", "Tracker"], ["sessions", "Sessions"],
];

function renderExTabs() {
  const t = $("#ex-tabs");
  t.innerHTML = "";
  const tabs = EXTABS.filter(([k]) => k !== "sessions" || state.hasSessions);
  if (state.exTab === "sessions" && !state.hasSessions) state.exTab = "diff";
  for (const [key, label] of tabs) {
    const b = document.createElement("button");
    b.className = "tab" + (key === state.exTab ? " active" : "");
    b.setAttribute("role", "tab");
    b.textContent = label;
    b.onclick = () => { state.exTab = key; renderExTabs(); renderExPanel(); syncHash(); };
    t.appendChild(b);
  }
}

function renderExPanel() {
  const p = $("#ex-panel");
  p.innerHTML = `<div class="note">loading…</div>`;
  const fns = { diff: exDiff, files: exFiles, notes: exNotes, fev: exFev, tracker: exTracker, sessions: exSessions };
  (fns[state.exTab] || exDiff)(p).catch((e) => {
    p.innerHTML = `<div class="note">⚠ ${esc(e.message)}</div>`;
  });
}

async function fileDiffRows(f, s, d) {
  if (f.status === "A") {
    const fj = await api("file", { mod: d.module.id, step: s.key, name: f.name });
    return fj.content.split("\n").map((t, i) => ["add", null, null, i + 1, t]);
  }
  if (f.status === "D" && state.stepIdx > 0) {
    const prev = d.steps[state.stepIdx - 1];
    const fj = await api("file", { mod: d.module.id, step: prev.key, name: f.name });
    return fj.content.split("\n").map((t, i) => ["del", i + 1, t, null, null]);
  }
  const ep = diffEndpoints(f.name);
  const dj = await api("diff", { mod: d.module.id, ...ep });
  return dj.rows;
}

// Diff rows for one file at an arbitrary step index (independent of the page's step).
// Whole file as all-added rows, so a file that first appears at a step renders
// without requesting a diff against a version that does not exist (which 404s).
async function allAddedRows(fname, stepKey, d) {
  const fj = await api("file", { mod: d.module.id, step: stepKey, name: fname });
  return (fj.content || "").split("\n").map((t, i) => ["add", "", "", i + 1, t]);
}

async function fileDiffRowsAt(fname, idx, d) {
  let ep;
  if (idx === 0) {
    const base = d.flavor === "gen2" && d.root_files.includes("prepared.sv") && fname === "wip.tlv" ? "prepared.sv" : null;
    ep = { a_step: base ? "root" : d.steps[0].key, a_name: base || fname, b_step: d.steps[0].key, b_name: fname };
  } else {
    const prev = d.steps[idx - 1], s = d.steps[idx];
    const bHas = (s.files || []).includes(fname);
    const aHas = (prev.files || []).includes(fname) || !!prev.reverted_to;
    // Avoid diffing against a version that is not there (would 404): show the file
    // as all-added when it first appears, or nothing when it is not saved here.
    if (!bHas) return [];
    if (!aHas) return allAddedRows(fname, s.key, d);
    const pkey = prev.reverted_to ? prev.key.split("/").slice(0, -1).concat(prev.reverted_to).join("/") : prev.key;
    ep = { a_step: pkey, a_name: fname, b_step: s.key, b_name: fname };
  }
  const dj = await api("diff", { mod: d.module.id, ...ep });
  return dj.rows;
}

// A single-file diff that you can step through checkpoint by checkpoint, keeping
// this one file in view. The page's selected step is the starting point.
// Per-step changed-file map, fetched once per module and cached on d, so the
// delta buttons can skip steps where a given file did not change.
async function changedStepsFor(fname, d) {
  if (!d._changesByStep) {
    d._changesByStep = await Promise.all(
      d.steps.map((s) => api("changes", { mod: d.module.id, step: s.key })
        .then((c) => new Set((c.files || []).filter((f) => f.status !== "U").map((f) => f.name)))
        .catch(() => null)));
  }
  const idxs = [];
  d._changesByStep.forEach((set, i) => { if (set && set.has(fname)) idxs.push(i); });
  return idxs;
}

// Tracker content at each step, cached on d. The "note about step N" lives in the
// NEXT checkpoint (the agent writes the tracker after fev.sh snapshots the step),
// so the after-tracker for step N is step N+1, or the working dir for the last step.
async function trackerContentsByStep(d) {
  if (!d._trackerByStep) {
    d._trackerByStep = await Promise.all(d.steps.map((s) =>
      (s.files || []).includes("tracker.md")
        ? api("file", { mod: d.module.id, step: s.key, name: "tracker.md" }).then((r) => r.content || "").catch(() => "")
        : Promise.resolve("")));
    d._trackerAfterLast = await api("tracker", { mod: d.module.id }).then((r) => r.markdown || "").catch(() => "");
  }
  return d._trackerByStep;
}
function trackerAfter(idx, d) {
  return idx < d.steps.length - 1 ? d._trackerByStep[idx + 1] : d._trackerAfterLast;
}
async function trackerChangedIdxs(d) {
  await trackerContentsByStep(d);
  const out = [];
  d.steps.forEach((_, i) => { if ((d._trackerByStep[i] || "") !== (trackerAfter(i, d) || "")) out.push(i); });
  return out;
}

// A per-file stepper. Two tiers of navigation: prev/next step (every checkpoint)
// and prev/next delta (only checkpoints where THIS file changed). mode is "diff"
// (side by side vs the previous version) or "full" (the whole file at that step).
// opts.tracker: diff this step vs the NEXT (N vs N+1) since the tracker is written
// after fev records the checkpoint; "full" renders the tracker as markdown.
function mountFileStepper(host, fname, d, opts = {}) {
  const tracker = !!opts.tracker;
  let idx = state.stepIdx;
  let mode = opts.mode || "diff";
  let deltas = [];
  host.innerHTML = `
    <div class="fstep-bar">
      <span class="fstep-nav fstep-nav-left">
        <button class="btn-mini fstep-pdelta" title="previous change to this file">⏮ prev change</button>
        <button class="btn-mini fstep-prev" title="previous step">◀</button>
      </span>
      <span class="fstep-label"></span>
      <span class="fstep-nav fstep-nav-right">
        <button class="btn-mini fstep-next" title="next step">▶</button>
        <button class="btn-mini fstep-ndelta" title="next change to this file">next change ⏭</button>
      </span>
      <span class="fstep-modes">
        <button class="btn-mini fstep-mdiff" title="side-by-side diff">Diff</button>
        <button class="btn-mini fstep-mfull" title="whole file">Full file</button>
      </span>
    </div>
    <div class="fstep-diff"><div class="note">loading…</div></div>`;
  const label = host.querySelector(".fstep-label");
  const diffHost = host.querySelector(".fstep-diff");
  const prevBtn = host.querySelector(".fstep-prev");
  const nextBtn = host.querySelector(".fstep-next");
  const pDelta = host.querySelector(".fstep-pdelta");
  const nDelta = host.querySelector(".fstep-ndelta");
  const mDiff = host.querySelector(".fstep-mdiff");
  const mFull = host.querySelector(".fstep-mfull");
  if (tracker) {
    pDelta.title = "previous step with a note"; pDelta.textContent = "⏮ prev note";
    nDelta.title = "next step with a note"; nDelta.textContent = "next note ⏭";
    mFull.textContent = "Rendered"; mFull.title = "tracker rendered as markdown";
  }
  async function render() {
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx >= d.steps.length - 1;
    pDelta.disabled = !deltas.some((i) => i < idx);
    nDelta.disabled = !deltas.some((i) => i > idx);
    mDiff.classList.toggle("on", mode === "diff");
    mFull.classList.toggle("on", mode === "full");
    const s = d.steps[idx];
    const last = d.steps.length - 1;
    label.textContent = `step ${s.n} of ${d.steps.length}${s.task ? " · " + s.task : ""}${tracker ? " · notes about this step" : ""}`;
    // keep the previous content visible during the (fast, local) fetch so the
    // panel does not collapse to a one-line "loading" and back, which shifts layout
    if (!diffHost.querySelector(".sxs, .fullfile, .md-card")) diffHost.innerHTML = `<div class="note">loading…</div>`;
    try {
      if (tracker) {
        if (mode === "full") {
          diffHost.innerHTML = `<div class="md-card md">${md(trackerAfter(idx, d) || "")}</div>`;
        } else {
          const bStep = idx < last ? d.steps[idx + 1].key : "root";
          const dj = await api("diff", { mod: d.module.id, a_step: s.key, a_name: "tracker.md", b_step: bStep, b_name: "tracker.md" });
          if (!dj.rows.some((r) => r[0] !== "eq")) diffHost.innerHTML = `<div class="note">No note recorded about step ${s.n}.</div>`;
          else renderSxS(diffHost, dj.rows, `step ${s.n}`, idx < last ? `step ${d.steps[idx + 1].n} (note lands here)` : "working dir (latest)");
        }
      } else if (mode === "full") {
        await renderFullFileAt(diffHost, fname, idx, d);
      } else {
        const aLabel = (idx === 0 && fname === "wip.tlv") ? "original Verilog" : idx > 0 ? `step ${d.steps[idx - 1].n}` : "before";
        const rows = await fileDiffRowsAt(fname, idx, d);
        renderSxS(diffHost, rows, aLabel, `step ${s.n}`);
      }
    } catch (e) {
      diffHost.innerHTML = `<div class="note">${esc(e.message)}</div>`;
    }
  }
  // Re-render but keep the button bar at the same viewport position, so stepping
  // does not make the page jump when the new content has a different height (most
  // visible on the tracker, which is the last element and varies a lot per step).
  async function anchoredRender() {
    const sc = host.closest("#explore") || document.scrollingElement;
    const bar = host.querySelector(".fstep-bar");
    const before = bar.getBoundingClientRect().top;
    await render();
    const after = host.querySelector(".fstep-bar").getBoundingClientRect().top;
    if (sc && Math.abs(after - before) > 0.5) sc.scrollTop += after - before;
  }
  prevBtn.onclick = () => { if (idx > 0) { idx--; anchoredRender(); } };
  nextBtn.onclick = () => { if (idx < d.steps.length - 1) { idx++; anchoredRender(); } };
  pDelta.onclick = () => { const t = deltas.filter((i) => i < idx).pop(); if (t != null) { idx = t; anchoredRender(); } };
  nDelta.onclick = () => { const t = deltas.find((i) => i > idx); if (t != null) { idx = t; anchoredRender(); } };
  mDiff.onclick = () => { if (mode !== "diff") { mode = "diff"; anchoredRender(); } };
  mFull.onclick = () => { if (mode !== "full") { mode = "full"; anchoredRender(); } };
  render();
  (tracker ? trackerChangedIdxs(d) : changedStepsFor(fname, d)).then((idxs) => { deltas = idxs; render(); }).catch(() => {});
}

// Whole-file view at a step, with changed lines highlighted vs the previous step
// (green added, red removed). Uses the same diff rows but shows every line.
async function renderFullFileAt(host, fname, idx, d) {
  const rows = await fileDiffRowsAt(fname, idx, d);
  // rows are [type, aLineNum, aText, bLineNum, bText]
  const line = (r) => {
    const cls = r[0] === "add" ? "l-add" : r[0] === "del" ? "l-del" : r[0] === "chg" ? "l-chg" : "";
    const txt = r[0] === "del" ? (r[2] ?? "") : (r[4] ?? r[2] ?? "");
    return `<div class="ffl ${cls}">${esc(txt)}</div>`;
  };
  host.innerHTML = `<div class="fullfile">${rows.map(line).join("")}</div>`;
}

async function exDiff(p) {
  const d = state.detail, s = curStep();
  const META = new Set(["task.md", "tracker.md"]);  // shown under Prompt/Tracker, not the code diff
  const allFiles = s.files && s.files.length ? s.files : d.root_files;
  let changes = null;
  try { changes = await api("changes", { mod: d.module.id, step: s.key }); } catch (_) {}
  const fileList = (changes ? changes.files
    : allFiles.map((n) => ({ name: n, status: "U", added: 0, removed: 0 })))
    .filter((f) => !META.has(f.name));
  const changed = fileList.filter((f) => f.status !== "U");
  const unchanged = fileList.filter((f) => f.status === "U");
  const nChanged = changed.length;
  const show = changed.length ? changed : fileList;
  p.innerHTML = `
    <div class="panel-toolbar diff-toolbar">
      <span class="diff-summary">${changes ? `<b>${nChanged}</b> file${nChanged === 1 ? "" : "s"} changed this step` : "files at this checkpoint"}</span>
      ${d.flavor === "gen2" ? `<button class="btn-mini" id="ex-vs-orig">vs original Verilog</button>` : ""}
    </div>
    <div id="ex-stack"></div>
    <div id="ex-tracker-diff"></div>
    ${unchanged.length ? `<details class="diff-unchanged"><summary>${unchanged.length} unchanged file${unchanged.length === 1 ? "" : "s"}</summary><div class="file-grid" id="ex-unchanged"></div></details>` : ""}`;
  const stack = $("#ex-stack");
  for (const f of show) {
    const counts = (f.added || f.removed)
      ? `<span class="fc-counts"><span class="add">+${f.added}</span><span class="rem">−${f.removed}</span></span>` : "";
    const badge = f.status !== "U" ? `<span class="fc-badge ${f.status}">${f.status}</span>` : "";
    const sec = document.createElement("details");
    sec.className = "fdiff";
    sec.open = true;
    sec.innerHTML = `<summary>${badge}<span class="fc-name">${esc(f.name)}</span>${counts}</summary><div class="fdiff-body"></div>`;
    stack.appendChild(sec);
    mountFileStepper(sec.querySelector(".fdiff-body"), f.name, d);
  }
  // Tracker diff, shown next-vs-current (N vs N+1) because the agent writes the
  // tracker after fev.sh records the checkpoint, so a step's notes land in the
  // next checkpoint. This is the opposite direction from every other file.
  const tHost = $("#ex-tracker-diff");
  const anyTracker = d.steps.some((st) => (st.files || []).includes("tracker.md"));
  if (tHost && anyTracker) {
    const sec = document.createElement("details");
    sec.className = "fdiff tracker-in-diff";
    sec.open = false;
    sec.innerHTML = `<summary><span class="fc-name">tracker.md</span><span class="muted"> (agent notes, shown next vs current since written after FEV; step or jump between notes)</span></summary><div class="fdiff-body"></div>`;
    tHost.appendChild(sec);
    mountFileStepper(sec.querySelector(".fdiff-body"), "tracker.md", d, { tracker: true, mode: "diff" });
  }
  const uc = $("#ex-unchanged");
  if (uc) {
    uc.innerHTML = unchanged.map((f) => `<button class="file-pill" data-name="${esc(f.name)}">${esc(f.name)}</button>`).join("");
    uc.querySelectorAll(".file-pill").forEach((b) => {
      b.onclick = async () => {
        const fj = await api("file", { mod: d.module.id, step: s.key, name: b.dataset.name });
        openModal(`${s.key} / ${b.dataset.name}`, fj.content);
      };
    });
  }
  const vs = $("#ex-vs-orig");
  if (vs) vs.onclick = async () => {
    stack.innerHTML = `<details class="fdiff" open><summary><span class="fc-name">wip.tlv vs original Verilog</span></summary><div class="fdiff-body" id="ex-vs-host"><div class="note">loading…</div></div></details>`;
    const dj2 = await api("diff", { mod: d.module.id, a_step: "root", a_name: "prepared.sv", b_step: s.key, b_name: "wip.tlv" });
    renderSxS($("#ex-vs-host"), dj2.rows, "original Verilog", `step ${s.n} / wip.tlv`);
  };
}

function renderSxS(host, rows, aLabel, bLabel) {
  const CTX = 4, MIN_SKIP = 10;
  const segs = [];
  let i = 0;
  while (i < rows.length) {
    const eq = rows[i][0] === "eq";
    let j = i;
    while (j < rows.length && (rows[j][0] === "eq") === eq) j++;
    segs.push([eq ? "eq" : "ch", i, j]);
    i = j;
  }
  const emit = (r) => {
    const [t, an, at, bn, bt] = r;
    let aHtml = esc(at ?? ""), bHtml = esc(bt ?? "");
    if (t === "chg") [aHtml, bHtml] = wordDiffMark(at, bt);
    return `<div class="sxs-row ${t}">
      <span class="ln">${an ?? ""}</span><span class="cd a">${aHtml}</span>
      <span class="ln">${bn ?? ""}</span><span class="cd b">${bHtml}</span></div>`;
  };
  const frag = [`<div class="sxs"><div class="sxs-cols"><div></div><div>Before · ${esc(aLabel)}</div><div></div><div>After · ${esc(bLabel)}</div></div>`];
  segs.forEach(([t, a, b], si) => {
    if (t === "ch") { for (let k = a; k < b; k++) frag.push(emit(rows[k])); return; }
    const len = b - a;
    const head = si === 0 ? 0 : CTX, tail = si === segs.length - 1 ? 0 : CTX;
    if (len <= head + tail + MIN_SKIP) { for (let k = a; k < b; k++) frag.push(emit(rows[k])); return; }
    for (let k = a; k < a + head; k++) frag.push(emit(rows[k]));
    frag.push(`<button class="sxs-skip" data-a="${a + head}" data-b="${b - tail}">⋯ show ${len - head - tail} unchanged lines ⋯</button>`);
    for (let k = b - tail; k < b; k++) frag.push(emit(rows[k]));
  });
  frag.push("</div>");
  host.innerHTML = frag.join("");
  host.querySelectorAll(".sxs-skip").forEach((btn) => {
    btn.onclick = () => {
      const a = +btn.dataset.a, b = +btn.dataset.b;
      const tmp = document.createElement("div");
      tmp.innerHTML = rows.slice(a, b).map(emit).join("");
      btn.replaceWith(...tmp.childNodes);
    };
  });
}

async function exFiles(p) {
  const d = state.detail, s = curStep();
  const mk = (files, step) => files.map((f) =>
    `<button class="file-pill" data-step="${esc(step)}" data-name="${esc(f)}">${esc(f)}</button>`).join("");
  p.innerHTML = `
    <div class="panel-toolbar"><span>Files saved at this checkpoint (click to open it below and step through it):</span></div>
    <div class="file-grid">${mk(s.files || [], s.key)}</div>
    <div class="panel-toolbar" style="margin-top:20px"><span>Working directory right now:</span></div>
    <div class="file-grid">${mk(d.root_files, "root")}</div>
    <div id="files-viewer"></div>`;
  const viewer = $("#files-viewer");
  // Files that appear in the checkpoint history can be stepped through; root-only
  // files (not part of the conversion history) just open in the modal.
  const stepable = new Set();
  d.steps.forEach((st) => (st.files || []).forEach((f) => stepable.add(f)));
  p.querySelectorAll(".file-pill").forEach((b) => {
    b.onclick = async () => {
      const name = b.dataset.name;
      if (b.dataset.step !== "root" || stepable.has(name)) {
        p.querySelectorAll(".file-pill").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        viewer.innerHTML = `<div class="panel-toolbar" style="margin-top:20px"><span>${esc(name)}: step through it, or switch to Diff</span></div><div class="fdiff-body"></div>`;
        mountFileStepper(viewer.querySelector(".fdiff-body"), name, d, { mode: "full" });
      } else {
        const fj = await api("file", { mod: d.module.id, step: b.dataset.step, name });
        openModal(`${b.dataset.step} / ${name}`, fj.content);
      }
    };
  });
}

async function exPrompt(p) {
  const d = state.detail, s = curStep();
  if (d.flavor === "gen1") return renderGen1Prompt(p, s);
  if ((s.files || []).includes("task.md")) {
    const fj = await api("file", { mod: d.module.id, step: s.key, name: "task.md" });
    p.innerHTML = `<div class="note">The exact instructions the agent was following at this checkpoint.</div><div class="md-card md">${md(fj.content)}</div>`;
    return;
  }
  const name = s.task || d.current.task;
  if (!name) { p.innerHTML = `<div class="note">No task was recorded for this step.</div>`; return; }
  const wrap = document.createElement("div");
  wrap.className = "md-card md";
  p.innerHTML = "";
  p.appendChild(wrap);
  await loadTaskInstructions(wrap, name);
}

async function exNotes(p) {
  const s = curStep();
  const rows = Object.entries(s)
    .filter(([k]) => !["files", "key", "mtime"].includes(k))
    .map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</span></div>`)
    .join("");
  p.innerHTML = `<div class="kv">${rows}</div>`;
}

// Block-level diff of two markdown documents, rendered. Split each into blocks,
// LCS-diff the blocks, and show the changed ones as formatted markdown (added in
// green, removed in red). Keeps markdown formatting while highlighting what changed,
// which a plain text diff can't do.
function renderedTrackerDiff(before, after) {
  const blocks = (t) => (t || "").split(/\n{2,}/).map((b) => b.replace(/\s+$/, "")).filter((b) => b.trim());
  const A = blocks(before), B = blocks(after), n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(["del", A[i++]]);
    else out.push(["add", B[j++]]);
  }
  while (i < n) out.push(["del", A[i++]]);
  while (j < m) out.push(["add", B[j++]]);
  return out.map(([t, text]) => `<div class="tdr ${t}"><div class="md">${md(text)}</div></div>`).join("");
}

async function exTracker(p) {
  const d = state.detail, s = curStep();
  const hasCur = (s.files || []).includes("tracker.md");
  const next = state.stepIdx < d.steps.length - 1 ? d.steps[state.stepIdx + 1] : null;
  const nextHas = next && (next.files || []).includes("tracker.md");

  // fev.sh snapshots the checkpoint before the agent writes its notes, so a step's
  // tracker reflection lands in the next checkpoint (or the working-dir tracker for
  // the last step). Show that "after" tracker, plus the diff vs this step's snapshot.
  const before = hasCur ? (await api("file", { mod: d.module.id, step: s.key, name: "tracker.md" })).content : "";
  let after = "", afterLabel = "", afterStep = null;
  if (nextHas) {
    after = (await api("file", { mod: d.module.id, step: next.key, name: "tracker.md" })).content;
    afterStep = next.key; afterLabel = `step ${next.n}`;
  } else {
    after = (await api("tracker", { mod: d.module.id })).markdown || "";
    afterLabel = "working dir (latest)";
  }
  const diffHtml = hasCur ? renderedTrackerDiff(before, after) : "";
  p.innerHTML = `
    <div class="panel-toolbar"><span>What the agent recorded about step ${s.n}
      <span class="muted">(written after FEV, captured in ${esc(afterLabel)})</span></span></div>
    ${diffHtml ? `<div class="tracker-diff">${diffHtml}</div>` : `<div class="note">No tracker notes recorded for this step.</div>`}
    <details class="tracker-full" open><summary>Tracker after this step (${esc(afterLabel)})</summary><div class="md-card md">${md(after)}</div></details>
    <details class="tracker-full"><summary>Tracker as captured at this step, before the agent reflected</summary><div class="md-card md">${md(before)}</div></details>`;
}

async function exFev(p) {
  const d = state.detail, s = curStep();
  const j = await api("fevlog", { mod: d.module.id, step: s.key });
  if (!j.found) {
    p.innerHTML = `<div class="note"><b>No correlated FEV output:</b> ${esc(j.reason || "unavailable")}.<br><br>
      This panel pulls the <code>fev.sh</code> output the agent saw for this step out of the captured transcript,
      so it needs a transcript in <code>transcripts/</code>.</div>`;
    return;
  }
  const fev = s.fev || "";
  const pass = /^0:/.test(fev);
  const lines = (j.output || "").split("\n").map((l) => {
    const cls = /\b(FAIL|UNKNOWN|ERROR|Failed|FATAL|SyntaxError|Traceback)\b|not equival/i.test(l) ? "fev-err"
      : /Successfully proved|All FEV runs successful|^0: /.test(l) ? "fev-ok" : "";
    return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
  }).join("\n");
  p.innerHTML = `
    <div class="panel-toolbar">
      <span>FEV result the agent saw at step ${s.n}
        <span class="muted">(transcript ${esc(j.transcript)}, ${j.runs} fev.sh runs)</span></span>
      <span class="fev-verdict ${pass ? "ok" : "err"}">${esc(fev)}</span>
    </div>
    <div class="panel-toolbar"><span class="muted"><code>${esc(j.command)}</code></span></div>
    <pre class="fev-out">${lines}</pre>`;
}

function noSessionsHelp() {
  const mod = state.detail.module;
  return `<div class="note"><b>No agent transcripts found for this module yet.</b><br><br>
  The agent's chat logs are saved on the machine where it ran, outside the git repo,
  so a cloned conversion arrives without them.<br><br>
  Three ways to get transcripts here:<br>
  1. <b>Run a conversion on this machine</b>: its transcript is picked up automatically from ~/.claude/projects.<br>
  2. <b>Share via git</b>: copy the session .jsonl into
  <code>${esc(mod.rel)}/transcripts/</code> and commit. Everyone who clones sees it.<br>
  3. <b>Import from another machine</b>: start the server with
  <code>--claude-projects &lt;copied-folder&gt;</code>. Folders are matched by module name.</div>`;
}

function costSummary(c) {
  if (!c || (!c.usd && !c.input && !c.output)) return "";
  const k = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(n);
  const models = Object.keys(c.by_model || {}).map((m) => m.replace(/^claude-/, "")).join(", ");
  const dollars = c.usd < 1 ? "$" + c.usd.toFixed(4) : "$" + c.usd.toFixed(2);
  return `<div class="cost-bar"><b>${dollars}</b> <span class="cost-est" title="Estimated from the transcript's token usage at public list prices. Actual billing may differ; check the provider's cost dashboard.">est. · list price</span> · ${k(c.input)} in / ${k(c.output)} out · ${k(c.cache_read)} cached${models ? " · " + esc(models) : ""}</div>`;
}

async function exSessions(p) {
  const sj = await api("sessions", { mod: state.detail.module.id });
  if (!sj.sessions.length) {
    p.innerHTML = noSessionsHelp();
    return;
  }
  p.innerHTML = sj.sessions.map((s) => `
    <button class="sess-item" data-id="${esc(s.id)}" title="${esc(s.scope || "")}">
      <span>${esc(s.name)}</span><span>${esc(s.scope || "")} · ${fmtBytes(s.size)} · ${new Date((s.mtime || 0) * 1000).toLocaleString()}</span>
    </button>`).join("") + `<div class="chat" id="ex-sess-host" style="margin-top:14px"></div>`;
  p.querySelectorAll(".sess-item").forEach((b) => {
    b.onclick = async () => {
      const host = $("#ex-sess-host");
      host.innerHTML = `<div class="note">loading transcript…</div>`;
      const mj = await api("session", { id: b.dataset.id, mod: state.detail.module.id });
      const body = mj.messages.map((m) => {
        const bodyHtml = m.parts.map((pt) => {
          if (pt.t === "text") return `<pre>${esc(pt.text)}</pre>`;
          if (pt.t === "tool") return `<span class="tool-chip">⚙ ${esc(pt.name)}</span>`;
          return `<div class="result-blk">${esc(pt.text)}</div>`;
        }).join("");
        return `<div class="bubble ${m.role === "user" ? "user" : ""}"><div class="who">${esc(m.role)}</div>${bodyHtml}</div>`;
      }).join("") || `<div class="note">empty transcript</div>`;
      host.innerHTML = costSummary(mj.cost) + body;
    };
  });
}

function renderBottom() {
  const total = totalSteps();
  $("#bb-progress").textContent = `${Math.min(state.stepIdx + 1, total)}/${total}`;
  $("#back-btn").disabled = state.stepIdx <= 0;
  $("#next-btn").disabled = state.stepIdx >= total - 1;
}

function renderStep() {
  renderPills();
  renderBottom();
  renderExHeader();
  renderExTimeline();
  renderExBanner();
  renderTaskHeader();
  renderExTabs();
  renderExPanel();
  syncHash();
}

// The task being worked on, as a collapsible header above the tabs, so the task is
// visible (and its description reachable) regardless of which tab is open.
async function renderTaskHeader() {
  const host = $("#ex-task");
  if (!host) return;
  const d = state.detail, s = curStep();
  const name = s.task || (d.current && d.current.task) || "";
  if (!name) { host.innerHTML = ""; return; }
  host.innerHTML = `<details class="task-header">
    <summary><span class="th-label">Task</span><span class="th-name">${esc(name)}</span><span class="th-hint">description</span></summary>
    <div class="th-body"><div class="note">loading…</div></div></details>`;
  const body = host.querySelector(".th-body");
  try {
    if (d.flavor === "gen1") { await renderGen1Prompt(body, s); return; }
    if ((s.files || []).includes("task.md")) {
      const fj = await api("file", { mod: d.module.id, step: s.key, name: "task.md" });
      body.innerHTML = `<div class="md-card md">${md(fj.content)}</div>`;
      return;
    }
    body.innerHTML = `<div class="md-card md"></div>`;
    await loadTaskInstructions(body.querySelector(".md-card"), name);
  } catch (e) {
    body.innerHTML = `<div class="note">${esc(e.message)}</div>`;
  }
}

function gotoStep(idx) {
  const total = totalSteps();
  if (idx < 0 || idx >= total) return;
  if (state.es && state.tail && idx < total - 1) {
    state.tail = false;
    const c = $("#tail-check"); if (c) c.checked = false;
  }
  state.stepIdx = idx;
  renderStep();
}

async function selectModule(id, wantStep) {
  if (id == null || id === "" || !state.modules[+id]) return;
  state.modId = +id;
  state.file = null;
  state.loaded = {};
  renderModuleSelect();
  state.detail = await api("module", { mod: state.modId });
  showView();
  try { state.hasSessions = ((await api("sessions", { mod: state.modId })).sessions || []).length > 0; }
  catch (_) { state.hasSessions = false; }
  const n = totalSteps();
  state.stepIdx = wantStep != null && wantStep >= 0 && wantStep < n ? wantStep : 0;
  renderStep();
  connectLive(state.modId);
}

function setLiveDot(status) {
  const dot = $("#live-dot");
  dot.hidden = false;
  dot.className = "live-dot " + status;
  dot.textContent = status === "reconnecting" ? "Reconnecting…" : "Live";
}

function renderLiveStrip(ls) {
  const strip = $("#live-strip");
  if (!ls || ls.activity === "idle") { strip.hidden = true; strip.className = "live-strip"; return; }
  strip.hidden = false;
  if (ls.activity === "stuck") {
    strip.className = "live-strip stuck";
    strip.innerHTML = `<span class="ls-ic">⚠</span> <b>Possibly stuck</b> · ${esc(ls.stuck_reason || "")}${ls.task ? ` · task: ${esc(ls.task)}` : ""}`;
  } else {
    strip.className = "live-strip working";
    const cnt = typeof ls.fev_cnt === "number" ? ` · ${ls.fev_cnt} FEV attempt${ls.fev_cnt === 1 ? "" : "s"}` : "";
    strip.innerHTML = `<span class="ls-ic">●</span> <b>Agent working</b>${ls.task ? ` · ${esc(ls.task)}` : ""}${cnt}`;
  }
}

function flashNewest() {
  const el = $(".tl-step.active");
  if (!el) return;
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

async function refreshDetailLive(jumpToLast) {
  const prevIdx = state.stepIdx;
  try { state.detail = await api("module", { mod: state.modId }); }
  catch (_) { return; }
  state.loaded = {};
  const n = totalSteps();
  state.stepIdx = jumpToLast ? n - 1 : Math.min(prevIdx, n - 1);
  if (state.stepIdx < 0) state.stepIdx = 0;
  renderStep();
  flashNewest();
}

function onLiveState(ls) {
  setLiveDot("connected");
  if ($("#live-dot")) $("#live-dot").classList.toggle("beat", ls.activity !== "idle");
  renderLiveStrip(ls);
  const prev = state.liveSteps;
  state.liveSteps = ls.steps;
  if (prev != null && ls.steps !== prev) {
    refreshDetailLive(state.tail && ls.steps > prev);
  }
}

function disconnectLive() {
  if (state.es) { state.es.close(); state.es = null; }
  state.liveSteps = null;
  $("#live-dot").hidden = true;
  $("#tail-follow").hidden = true;
  $("#live-strip").hidden = true;
}

function connectLive(modId) {
  disconnectLive();
  if (modId == null) return;
  if (new URLSearchParams(location.hash.slice(1)).get("live") === "0") return;
  $("#tail-follow").hidden = false;
  const es = new EventSource("/api/events?mod=" + modId);
  state.es = es;
  es.addEventListener("state", (e) => {
    if (state.es !== es) return;
    try { onLiveState(JSON.parse(e.data)); } catch (_) {}
  });
  es.onopen = () => { if (state.es === es) setLiveDot("connected"); };
  es.onerror = () => {
    if (state.es !== es) return;
    setLiveDot("reconnecting");
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      if (state.es === es) setTimeout(() => { if (state.es === es) connectLive(modId); }, 2000);
    }
  };
}

function openModal(title, content) {
  $("#modal-title").textContent = title;
  $("#modal-body").textContent = content;
  $("#modal").hidden = false;
}
$("#modal-close").onclick = () => { $("#modal").hidden = true; };
$("#modal").onclick = (e) => { if (e.target.id === "modal") $("#modal").hidden = true; };

$("#module-select").onchange = (e) => selectModule(e.target.value);
$("#mode-explore").onclick = () => setMode("explore");
$("#mode-guide").onclick = () => setMode("guide");
$("#back-btn").onclick = () => gotoStep(state.stepIdx - 1);
$("#next-btn").onclick = () => gotoStep(state.stepIdx + 1);
$("#tail-check").onchange = (e) => { state.tail = e.target.checked; };

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#modal").hidden = true;
  if (state.mode !== "explore" || !state.detail) return;
  const tag = e.target.tagName;
  if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "ArrowLeft") gotoStep(state.stepIdx - 1);
  if (e.key === "ArrowRight") gotoStep(state.stepIdx + 1);
});

$("#refresh-btn").onclick = async () => {
  const sj = await api("scan", { refresh: 1 });
  state.modules = sj.modules;
  renderModuleSelect();
};

function applyHash() {
  const h = readHash();
  if (h.v === "guide" || h.v === "explore") {
    state.mode = h.v;
    renderModeToggle();
    showView();
  }
  if (h.t && EXTABS.some(([k]) => k === h.t)) state.exTab = h.t;
  if (h.m == null || !state.modules[+h.m]) return;
  if (+h.m !== state.modId) selectModule(+h.m, h.s != null ? +h.s : null);
  else if (h.s != null && +h.s !== state.stepIdx) gotoStep(+h.s);
}
window.addEventListener("hashchange", applyHash);

(async function boot() {
  const sj = await api("scan");
  state.modules = sj.modules;
  renderModuleSelect();
  applyHash();
})();
