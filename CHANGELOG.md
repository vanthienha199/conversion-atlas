# Changelog

## 1.1.0

- Per-step model attribution: each checkpoint shows which model produced it, as a
  colored family chip in the timeline and the full model id on the step banner.
- Copilot-style +/- line counts per checkpoint, next to the model chip.
- Scripted (non-LLM) steps get their own chip style.
- Timeline step rows stay on one line when chips make them wider.

## 1.0.0

- First packaged release of the Conversion Console frontend as `conversion-atlas-ui`.
- Ships `static/app.js`, `static/style.css`, `static/index.html`, and
  `docs/frontend-api.md` (the API contract any backend must serve).
