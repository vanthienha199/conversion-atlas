"use strict";

const $ = (s) => document.querySelector(s);
const state = {
  modules: [], modId: null, detail: null, stepIdx: -1,
  file: null, loaded: {}, mode: "explore", exTab: "diff",
  es: null, tail: true, liveSteps: null,
};

function showView() {
  const has = state.detail != null;
  $("#empty").hidden = has;
  $("#bottombar").hidden = !has;
  $("#lesson").hidden = !(has && state.mode === "lesson");
  $("#explore").hidden = !(has && state.mode === "explore");
}

function allowedModules() {
  return state.mode === "lesson" ? state.modules.filter((m) => m.has_guide) : state.modules;
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
    if (/^\s*>/.test(ln)) { closeList(); out.push("<blockquote>" + inline(ln.replace(/^\s*>\s?/, "")) + "</blockquote>"); continue; }
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
  if (state.mode === "explore") p.set("t", state.exTab);
  if (state.modId != null) p.set("m", state.modId);
  if (state.stepIdx >= 0) p.set("s", state.stepIdx);
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
  sel.innerHTML = `<option value="">Choose a module…</option>` + allowedModules().map((m) =>
    `<option value="${m.id}" ${m.id === state.modId ? "selected" : ""}>${esc(m.name)} · ${m.steps} steps (${m.flavor === "gen1" ? "gen 1" : "gen 2"})${m.has_guide ? " · 🎓" : ""}</option>`
  ).join("");
}

function renderModeToggle() {
  $("#mode-explore").classList.toggle("active", state.mode === "explore");
  $("#mode-lesson").classList.toggle("active", state.mode === "lesson");
}

function setMode(m) {
  if (m === state.mode) return;
  state.mode = m;
  renderModeToggle();
  const allowed = allowedModules();
  if (state.modId != null && !allowed.some((x) => x.id === state.modId)) {
    if (allowed.length) { renderModuleSelect(); selectModule(allowed[0].id); return; }
    state.modId = null;
    state.detail = null;
  } else if (state.detail) {
    showView();
    renderStep();
    renderModuleSelect();
    return;
  }
  showView();
  renderModuleSelect();
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

async function renderLearn() {
  const d = state.detail, s = curStep();
  const body = $("#learn-body");
  if (d.flavor === "gen1" && !s.pseudo) return renderGen1Prompt(body, s);
  const guideStep = state.mode === "lesson" && state.guide && !s.pseudo && state.guide.steps && state.guide.steps[String(s.n)];
  if (guideStep) {
    const intro = state.stepIdx === 0 && state.guide.intro
      ? `<div class="md guide-intro"><h2>${esc(state.guide.intro.title)}</h2>${md(state.guide.intro.md)}</div><hr class="guide-hr">`
      : "";
    body.innerHTML = `${intro}
      <div class="md"><h2>${esc(guideStep.title)}</h2>${md(guideStep.md)}</div>
      <details id="raw-instr" class="raw-instr">
        <summary>Show the exact instructions the AI was given for "${esc(s.task || "")}"</summary>
        <div class="sec-body" id="raw-instr-body"></div>
      </details>`;
    const det = $("#raw-instr");
    det.addEventListener("toggle", () => {
      if (det.open && !det.dataset.loaded) { det.dataset.loaded = "1"; loadTaskInstructions($("#raw-instr-body"), s.task || d.current.task); }
    });
    return;
  }
  const name = s.task || d.current.task;
  if (!name) { body.innerHTML = `<div class="note">No task was recorded for this step.</div>`; return; }
  await loadTaskInstructions(body, name);
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

function renderInstructions() {
  const d = state.detail;
  const grp = activeGroup();
  const body = $("#instructions-body");
  if (!grp) { body.innerHTML = ""; return; }
  const intro = `<p style="margin-top:0">The AI completed this task in <b>${grp.items.length}</b> verified step${grp.items.length === 1 ? "" : "s"}. Click one to inspect it.</p>`;
  body.innerHTML = intro + grp.items.map(({ s, idx }, i) => {
    const active = idx === state.stepIdx;
    const sub = [s.duration ? "took " + s.duration : null, s.model || null, s.by === "human" ? "human edit" : null]
      .filter(Boolean).join(" · ") || "formally verified";
    const title = `${i + 1}. Step ${s.n} of ${d.steps.length}`;
    const noteTxt = s.llm ? `<div class="ck-sub">${esc(s.llm.length > 110 ? s.llm.slice(0, 110) + "…" : s.llm)}</div>` : "";
    return `<button class="ckpt pass ${active ? "active" : ""} ${idx > state.stepIdx ? "dim" : ""}" data-idx="${idx}">
      <span class="box">✓</span>
      <span class="ck-text"><div class="ck-title">${esc(title)}</div><div class="ck-sub">${esc(sub)}</div>${noteTxt}</span>
    </button>`;
  }).join("");
  body.querySelectorAll(".ckpt").forEach((b) => {
    b.onclick = () => gotoStep(+b.dataset.idx);
  });
}

function renderHint() {
  const s = curStep();
  const body = $("#hint-body");
  const fields = Object.entries(s.pseudo ? state.detail.current : s)
    .filter(([k, v]) => !["files", "key", "pseudo", "mtime", "llm"].includes(k) && v != null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join("\n");
  body.innerHTML = `
    ${s.llm ? `<p style="margin-top:0"><b>The AI wrote about this step:</b></p><div class="hint-code">${esc(s.llm)}</div>` : `<p style="margin-top:0">The AI left no note for this step.</p>`}
    <p><b>Everything recorded at this checkpoint:</b></p><div class="hint-code">${esc(fields)}</div>`;
}

function renderFiles() {
  const d = state.detail, s = curStep();
  const mk = (files, step) => files.map((f) =>
    `<button class="file-pill" data-step="${esc(step)}" data-name="${esc(f)}">${esc(f)}</button>`).join("");
  $("#files-body").innerHTML = `
    <p style="margin-top:0">Saved at this checkpoint:</p>
    <div class="file-grid">${mk(s.files || [], s.pseudo ? "root" : s.key)}</div>
    <p>In the working directory right now:</p>
    <div class="file-grid">${mk(d.root_files, "root")}</div>`;
  $("#files-body").querySelectorAll(".file-pill").forEach((b) => {
    b.onclick = async () => {
      const fj = await api("file", { mod: d.module.id, step: b.dataset.step, name: b.dataset.name });
      openModal(`${b.dataset.step} / ${b.dataset.name}`, fj.content);
    };
  });
}

async function renderReport() {
  if (state.loaded.report === state.modId) return;
  state.loaded.report = state.modId;
  const tj = await api("tracker", { mod: state.detail.module.id });
  $("#report-body").innerHTML = `<div class="md">${md(tj.markdown)}</div>`;
}

function fmtBytes(n) {
  if (n > 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n > 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}

async function renderSessions() {
  if (state.loaded.sessions === state.modId) return;
  state.loaded.sessions = state.modId;
  const body = $("#sessions-body");
  const sj = await api("sessions", { mod: state.detail.module.id });
  if (!sj.sessions.length) {
    body.innerHTML = noSessionsHelp();
    return;
  }
  body.innerHTML = sj.sessions.map((s) => `
    <button class="sess-item" data-id="${esc(s.id)}" title="${esc(s.scope || "")}">
      <span>${esc(s.name)}</span><span>${fmtBytes(s.size)} · ${new Date((s.mtime || 0) * 1000).toLocaleDateString()}</span>
    </button>`).join("") + `<div id="sess-host" class="chat"></div>`;
  body.querySelectorAll(".sess-item").forEach((b) => {
    b.onclick = async () => {
      const host = $("#sess-host");
      host.innerHTML = `<div class="note">loading transcript…</div>`;
      const mj = await api("session", { id: b.dataset.id, mod: state.detail.module.id });
      host.innerHTML = mj.messages.map((m) => {
        const bodyHtml = m.parts.map((pt) => {
          if (pt.t === "text") return `<pre>${esc(pt.text)}</pre>`;
          if (pt.t === "tool") return `<span class="tool-chip">⚙ ${esc(pt.name)}</span>`;
          return `<div class="result-blk">${esc(pt.text)}</div>`;
        }).join("");
        return `<div class="bubble ${m.role === "user" ? "user" : ""}"><div class="who">${esc(m.role)}</div>${bodyHtml}</div>`;
      }).join("") || `<div class="note">empty transcript</div>`;
    };
  });
}

function defaultFile(files) {
  for (const cand of ["wip.tlv", "fev.eqy"]) if (files.includes(cand)) return cand;
  const v = files.find((f) => f.endsWith(".v") || f.endsWith(".sv") || f.endsWith(".tlv"));
  return v || files[0];
}

function diffEndpoints(file) {
  const d = state.detail, idx = state.stepIdx, s = curStep();
  if (s.pseudo) {
    return { a_step: d.steps.length ? d.steps[d.steps.length - 1].key : "root", a_name: file, b_step: "root", b_name: file };
  }
  if (idx === 0) {
    const base = d.flavor === "gen2" && d.root_files.includes("prepared.sv") && file === "wip.tlv" ? "prepared.sv" : null;
    return { a_step: base ? "root" : s.key, a_name: base || file, b_step: s.key, b_name: file };
  }
  const prev = d.steps[idx - 1];
  const pkey = prev.reverted_to ? prev.key.split("/").slice(0, -1).concat(prev.reverted_to).join("/") : prev.key;
  return { a_step: pkey, a_name: file, b_step: s.key, b_name: file };
}

async function renderEditor() {
  const d = state.detail, s = curStep();
  const files = (s.files && s.files.length ? s.files : d.root_files).filter((f) => !f.endsWith(".json") || f === "config.json");
  const allFiles = s.files && s.files.length ? s.files : d.root_files;
  const file = state.file && allFiles.includes(state.file) ? state.file : defaultFile(allFiles);
  state.file = file;
  $("#file-select").innerHTML = allFiles.map((f) => `<option ${f === file ? "selected" : ""}>${esc(f)}</option>`).join("");
  const ed = $("#editor");
  ed.innerHTML = `<div class="eline"><span class="gut"></span><span class="src" style="color:#7d88a3">loading…</span></div>`;
  const showDiff = $("#diff-toggle").checked;
  try {
    if (showDiff) {
      const ep = diffEndpoints(file);
      const dj = await api("diff", { mod: d.module.id, ...ep });
      renderUnified(ed, dj.rows);
      $(".ed-note").textContent = dj.changed
        ? `${dj.changed} line${dj.changed === 1 ? "" : "s"} changed in this step · green added, red removed`
        : `no code changes in this step (checkpoint only updated metadata)`;
    } else {
      const step = s.pseudo ? "root" : s.key;
      const fj = await api("file", { mod: d.module.id, step, name: file });
      const lines = fj.content.split("\n");
      ed.innerHTML = lines.map((t, i) =>
        `<div class="eline"><span class="gut">${i + 1}</span><span class="src">${esc(t)}</span></div>`).join("");
      $(".ed-note").textContent = `${lines.length} lines`;
    }
  } catch (e) {
    ed.innerHTML = `<div class="eline"><span class="gut"></span><span class="src" style="color:var(--red)">${esc(e.message)}</span></div>`;
  }
}

function renderUnified(host, rows) {
  const CTX = 4, MIN_SKIP = 12;
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
    if (t === "eq") return `<div class="eline"><span class="gut">${bn}</span><span class="src">${esc(bt)}</span></div>`;
    if (t === "add") return `<div class="eline add"><span class="gut"><span class="sign">+</span>${bn}</span><span class="src">${esc(bt)}</span></div>`;
    if (t === "del") return `<div class="eline del"><span class="gut"><span class="sign">−</span>${an}</span><span class="src">${esc(at)}</span></div>`;
    const [aHtml, bHtml] = wordDiffMark(at, bt);
    return `<div class="eline del"><span class="gut"><span class="sign">−</span>${an}</span><span class="src">${aHtml}</span></div>` +
           `<div class="eline add"><span class="gut"><span class="sign">+</span>${bn}</span><span class="src">${bHtml}</span></div>`;
  };
  const frag = [];
  segs.forEach(([t, a, b], si) => {
    if (t === "ch") { for (let k = a; k < b; k++) frag.push(emit(rows[k])); return; }
    const len = b - a;
    const head = si === 0 ? 0 : CTX, tail = si === segs.length - 1 ? 0 : CTX;
    if (len <= head + tail + MIN_SKIP) { for (let k = a; k < b; k++) frag.push(emit(rows[k])); return; }
    for (let k = a; k < a + head; k++) frag.push(emit(rows[k]));
    frag.push(`<button class="eskip" data-a="${a + head}" data-b="${b - tail}">⋯ show ${len - head - tail} unchanged lines ⋯</button>`);
    for (let k = b - tail; k < b; k++) frag.push(emit(rows[k]));
  });
  host.innerHTML = frag.join("");
  host.querySelectorAll(".eskip").forEach((btn) => {
    btn.onclick = () => {
      const a = +btn.dataset.a, b = +btn.dataset.b;
      const tmp = document.createElement("div");
      tmp.innerHTML = rows.slice(a, b).map(emit).join("");
      btn.replaceWith(...tmp.childNodes);
    };
  });
}

let termTimer = null;

function termLines(s) {
  const d = state.detail;
  const lines = [];
  if (d.flavor === "gen1") {
    lines.push(["t-cmd", "convert.py · checkpoint " + s.key]);
    if (s.by) lines.push(["t-meta", `modified by: ${s.by}${s.model ? " (" + s.model + ")" : ""}`]);
    lines.push(["t-ok", "FEV: passed"]);
    lines.push(["t-explain ok", "Yosys proved this modification equivalent to the previous version. ✓"]);
    return lines;
  }
  lines.push(["t-cmd", "./scripts/fev.sh"]);
  lines.push(["t-ok", "SandPiper compile ............. OK"]);
  lines.push(["t-ok", "incremental FEV vs previous ... PASS"]);
  lines.push(["t-ok", "full FEV vs original Verilog .. PASS"]);
  lines.push(["t-explain ok", "EQY formally proved this step did not change the circuit's behavior. The change is mathematically safe."]);
  return lines;
}

function runTerminal(replay) {
  const t = $("#terminal");
  const s = curStep();
  if (!s) return;
  if (termTimer) { clearInterval(termTimer); termTimer = null; }
  const lines = termLines(s);
  t.innerHTML = "";
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!replay || reduce) {
    t.innerHTML = lines.map(([c, x]) => `<div class="t-line ${c}">${esc(x)}</div>`).join("");
    return;
  }
  let i = 0;
  termTimer = setInterval(() => {
    if (i >= lines.length) { clearInterval(termTimer); termTimer = null; return; }
    const [c, x] = lines[i++];
    t.insertAdjacentHTML("beforeend", `<div class="t-line ${c}">${esc(x)}</div>`);
    t.scrollTop = t.scrollHeight;
  }, 140);
}

function renderExHeader() {
  const d = state.detail, m = d.module;
  const parts = m.name.split("_");
  const title = parts.length > 1
    ? `${esc(parts[0])}_<em>${esc(parts.slice(1).join("_"))}</em>`
    : esc(m.name);
  $("#ex-header").innerHTML = `
    <div class="mh-eyebrow">${esc(m.root)} / ${esc(m.rel)}</div>
    <h2 class="mh-title">${title}</h2>
    <div class="mh-chips">
      <span class="chip">${m.flavor === "gen1" ? "Gen 1 · prompt flow" : "Gen 2 · agentic flow"}</span>
      <span class="chip">${d.steps.length} verified checkpoints · ${d.task_lanes.length} tasks</span>
      <span class="chip ok">✓ Conversion complete</span>
    </div>`;
}

function heatLevel(n) {
  if (n >= 20) return 4;
  if (n >= 11) return 3;
  if (n >= 6) return 2;
  if (n >= 3) return 1;
  return 0;
}

function groupFev(grp) {
  return grp.items.reduce((a, it) => a + (Number(it.s.fev_cnt) || 0), 0);
}

function renderDifficulty(groups) {
  const host = $("#ex-difficulty");
  if (!host) return;
  const max = Math.max(1, ...groups.map((g) => g.items.length));
  const activeGi = groups.findIndex((g) => g.items.some((it) => it.idx === state.stepIdx));
  host.innerHTML = `<div class="diff-bars">` + groups.map((g, gi) => {
    const n = g.items.length, lvl = heatLevel(n);
    const fev = groupFev(g);
    const tip = `${g.task || "task"}: ${n} checkpoint${n === 1 ? "" : "s"}${fev ? `, ${fev} FEV attempts` : ""}`;
    return `<button class="diff-bar heat${lvl}${gi === activeGi ? " on" : ""}" data-gi="${gi}" title="${esc(tip)}"
      style="height:${Math.max(12, Math.round((n / max) * 100))}%"><span class="db-n">${n}</span></button>`;
  }).join("") + `</div><div class="diff-legend">checkpoints per task: taller and warmer means the agent struggled there</div>`;
  host.querySelectorAll(".diff-bar").forEach((b) => {
    b.onclick = () => gotoStep(groups[+b.dataset.gi].items[0].idx);
  });
}

function renderExTimeline() {
  const tl = $("#ex-timeline");
  tl.innerHTML = "";
  const groups = taskGroups();
  renderDifficulty(groups);
  groups.forEach((grp) => {
    const hasActive = grp.items.some((it) => it.idx === state.stepIdx);
    const lvl = heatLevel(grp.items.length);
    const div = document.createElement("div");
    div.className = "tl-group" + (hasActive ? " open" : "");
    const head = document.createElement("button");
    head.className = "tl-group-head heat" + lvl + (hasActive ? " has-active" : "");
    head.innerHTML = `<span class="tw">▶</span><span>${esc(grp.task || "…")}</span><span class="cnt heat${lvl}">${grp.items.length}</span>`;
    head.onclick = () => div.classList.toggle("open");
    div.appendChild(head);
    const list = document.createElement("div");
    list.className = "tl-group-steps";
    grp.items.forEach(({ s, idx }) => {
      const b = document.createElement("button");
      b.className = "tl-step" + (idx === state.stepIdx ? " active" : "");
      b.title = s.llm || "";
      b.innerHTML = `<span class="ic">✓</span>
        <span>Step ${esc(String(s.n))}</span>
        <span class="dur">${esc(s.duration || "")}</span>`;
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

function renderExBanner() {
  const d = state.detail, s = curStep();
  if (!s) return;
  let badges = `<span class="badge ok" title="This checkpoint was proven equivalent by formal verification">✓ FEV verified</span>`;
  if (s.duration) badges += `<span class="badge info">took ${esc(s.duration)}</span>`;
  if (s.model) badges += `<span class="badge info">${esc(s.model)}</span>`;
  $("#ex-banner").innerHTML = `
    <div class="step-banner">
      <div class="sb-top">
        <h3>Step ${esc(String(s.n))}</h3>
        <span class="sb-pos">of ${d.steps.length}</span>
        ${badges}
        ${s.task ? `<span class="sb-pos">· ${esc(s.task)}</span>` : ""}
      </div>
      ${s.llm ? `<div class="hint"><b>AI note:</b> ${esc(s.llm)}</div>` : ""}
    </div>`;
}

const EXTABS = [
  ["diff", "Diff"], ["files", "Files"], ["prompt", "Prompt"],
  ["notes", "Status"], ["tracker", "Tracker"], ["sessions", "Sessions"],
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
  const fns = { diff: exDiff, files: exFiles, prompt: exPrompt, notes: exNotes, tracker: exTracker, sessions: exSessions };
  (fns[state.exTab] || exDiff)(p).catch((e) => {
    p.innerHTML = `<div class="note">⚠ ${esc(e.message)}</div>`;
  });
}

function defaultChangedFile(fileList, allFiles) {
  const changed = fileList.filter((f) => f.status === "M" || f.status === "A");
  const wip = changed.find((f) => f.name === "wip.tlv");
  if (wip) return wip.name;
  const eqy = changed.find((f) => f.name.endsWith(".eqy"));
  if (eqy) return eqy.name;
  if (changed.length) return changed[0].name;
  return defaultFile(allFiles);
}

function fileChipRow(fileList, sel) {
  const chip = (f) => {
    const changed = f.status !== "U";
    const badge = changed ? `<span class="fc-badge ${f.status}">${f.status}</span>` : "";
    const counts = (f.added || f.removed)
      ? `<span class="fc-counts"><span class="add">+${f.added}</span><span class="rem">−${f.removed}</span></span>` : "";
    return `<button class="fchip ${changed ? "changed" : "unchanged"} ${f.name === sel ? "sel" : ""}" data-name="${esc(f.name)}">${badge}<span class="fc-name">${esc(f.name)}</span>${counts}</button>`;
  };
  return `<div class="fchips">${fileList.map(chip).join("")}</div>`;
}

async function exDiff(p) {
  const d = state.detail, s = curStep();
  const allFiles = s.files && s.files.length ? s.files : d.root_files;
  let changes = null;
  if (!s.pseudo) { try { changes = await api("changes", { mod: d.module.id, step: s.key }); } catch (_) {} }
  const fileList = changes ? changes.files
    : allFiles.map((n) => ({ name: n, status: "U", added: 0, removed: 0 }));
  const file = state.file && fileList.some((f) => f.name === state.file)
    ? state.file : defaultChangedFile(fileList, allFiles);
  state.file = file;
  const nChanged = changes ? changes.changed : 0;
  const ep = diffEndpoints(file);
  const dj = await api("diff", { mod: d.module.id, ...ep });
  const prev = state.stepIdx > 0 ? d.steps[state.stepIdx - 1] : null;
  const aLabel = s.pseudo ? "last verified checkpoint"
    : ep.a_step === "root" ? "original Verilog (prepared.sv)"
    : prev ? `step ${prev.n}` : "first checkpoint";
  const bLabel = s.pseudo ? "working copy" : `step ${s.n}`;
  p.innerHTML = `
    <div class="panel-toolbar diff-toolbar">
      <span class="diff-summary">${changes ? `<b>${nChanged}</b> file${nChanged === 1 ? "" : "s"} changed this step` : "files at this checkpoint"}</span>
      ${d.flavor === "gen2" && !s.pseudo ? `<button class="btn-mini" id="ex-vs-orig">vs original Verilog</button>` : ""}
    </div>
    ${fileChipRow(fileList, file)}
    <div id="ex-diff-host"></div>`;
  p.querySelectorAll(".fchip").forEach((b) => {
    b.onclick = () => { state.file = b.dataset.name; renderExPanel(); };
  });
  const vs = $("#ex-vs-orig");
  if (vs) vs.onclick = async () => {
    const dj2 = await api("diff", { mod: d.module.id, a_step: "root", a_name: "prepared.sv", b_step: s.key, b_name: file });
    renderSxS($("#ex-diff-host"), dj2.rows, "original Verilog", `step ${s.n} / ${file}`);
  };
  renderSxS($("#ex-diff-host"), dj.rows, aLabel, bLabel);
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
    <div class="panel-toolbar"><span>Files saved at this checkpoint (click to view):</span></div>
    <div class="file-grid">${mk(s.files || [], s.pseudo ? "root" : s.key)}</div>
    <div class="panel-toolbar" style="margin-top:20px"><span>Working directory right now:</span></div>
    <div class="file-grid">${mk(d.root_files, "root")}</div>`;
  p.querySelectorAll(".file-pill").forEach((b) => {
    b.onclick = async () => {
      const fj = await api("file", { mod: d.module.id, step: b.dataset.step, name: b.dataset.name });
      openModal(`${b.dataset.step} / ${b.dataset.name}`, fj.content);
    };
  });
}

async function exPrompt(p) {
  const d = state.detail, s = curStep();
  if (d.flavor === "gen1" && !s.pseudo) return renderGen1Prompt(p, s);
  const name = s.task || d.current.task;
  if (!name) { p.innerHTML = `<div class="note">No task was recorded for this step.</div>`; return; }
  const wrap = document.createElement("div");
  wrap.className = "md-card md";
  p.innerHTML = "";
  p.appendChild(wrap);
  await loadTaskInstructions(wrap, name);
}

async function exNotes(p) {
  const d = state.detail, s = curStep();
  const rows = Object.entries(s.pseudo ? d.current : s)
    .filter(([k]) => !["files", "key", "pseudo", "mtime"].includes(k))
    .map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</span></div>`)
    .join("");
  p.innerHTML = `<div class="kv">${rows}</div>`;
}

async function exTracker(p) {
  const tj = await api("tracker", { mod: state.detail.module.id });
  p.innerHTML = `<div class="md-card md">${md(tj.markdown)}</div>`;
}

function noSessionsHelp() {
  const mod = state.detail.module;
  return `<div class="note"><b>No agent transcripts found for this module yet.</b><br><br>
  Claude Code saves its chat logs on the machine where the agent ran, outside the git repo,
  so a cloned conversion (like this one, run on Steve's machine) arrives without them.<br><br>
  Three ways to get transcripts here:<br>
  1. <b>Run a conversion on this machine</b>: its transcript is picked up automatically from ~/.claude/projects.<br>
  2. <b>Share via git (recommended for the team)</b>: copy the session .jsonl into
  <code>${esc(mod.rel)}/transcripts/</code> and commit. Everyone who clones sees it.<br>
  3. <b>Import from another machine</b>: get that machine's ~/.claude/projects folder and start the
  server with <code>--claude-projects &lt;copied-folder&gt;</code>. Folders are matched by module name.</div>`;
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
      host.innerHTML = mj.messages.map((m) => {
        const bodyHtml = m.parts.map((pt) => {
          if (pt.t === "text") return `<pre>${esc(pt.text)}</pre>`;
          if (pt.t === "tool") return `<span class="tool-chip">⚙ ${esc(pt.name)}</span>`;
          return `<div class="result-blk">${esc(pt.text)}</div>`;
        }).join("");
        return `<div class="bubble ${m.role === "user" ? "user" : ""}"><div class="who">${esc(m.role)}</div>${bodyHtml}</div>`;
      }).join("") || `<div class="note">empty transcript</div>`;
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
  if (state.mode === "lesson") {
    renderInstructions();
    renderHint();
    renderFiles();
    renderLearn();
    renderEditor();
    runTerminal(false);
  } else {
    renderExHeader();
    renderExTimeline();
    renderExBanner();
    renderExTabs();
    renderExPanel();
  }
  syncHash();
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
  try { state.guide = (await api("guide", { mod: state.modId })).guide; } catch (_) { state.guide = null; }
  try { state.hasSessions = ((await api("sessions", { mod: state.modId })).sessions || []).length > 0; }
  catch (_) { state.hasSessions = false; }
  $("#report-body").innerHTML = "";
  $("#sessions-body").innerHTML = "";
  $("#sec-report").open = false;
  $("#sec-sessions").open = false;
  $("#sec-sessions").hidden = !state.hasSessions;
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
  const sel = state.mode === "lesson" ? ".ckpt.active" : ".tl-step.active";
  const el = $(sel);
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
$("#mode-lesson").onclick = () => setMode("lesson");
$("#back-btn").onclick = () => gotoStep(state.stepIdx - 1);
$("#next-btn").onclick = () => gotoStep(state.stepIdx + 1);
$("#tail-check").onchange = (e) => { state.tail = e.target.checked; };
$("#run-btn").onclick = () => runTerminal(true);
$("#diff-toggle").onchange = () => renderEditor();
$("#file-select").onchange = (e) => { state.file = e.target.value; renderEditor(); };
$("#expand-btn").onclick = async () => {
  const s = curStep();
  const step = s.pseudo ? "root" : s.key;
  const fj = await api("file", { mod: state.detail.module.id, step, name: state.file });
  openModal(`${step} / ${state.file}`, fj.content);
};
$("#sec-report").addEventListener("toggle", () => { if ($("#sec-report").open) renderReport(); });
$("#sec-sessions").addEventListener("toggle", () => { if ($("#sec-sessions").open) renderSessions(); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#modal").hidden = true;
  if (!state.detail) return;
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
  if (h.v === "lesson" || h.v === "explore") {
    state.mode = h.v;
    renderModeToggle();
    renderModuleSelect();
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
