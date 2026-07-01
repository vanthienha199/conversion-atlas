# serv_rf_if conversion (sample data)

A completed Verilog to TL-Verilog conversion of `serv_rf_if`, the SERV RISC-V
register-file interface (153 lines). 14 checkpoints, all passing formal
equivalence (FEV), for both `WITH_CSR=1` and `WITH_CSR=0`.

Contents:
- `history/001..014/` the recorded checkpoints (code, FEV config, status, tracker)
- `transcripts/run1-initial.jsonl`, `run2-resume.jsonl` the two agent sessions
- root files: the final `wip.tlv`, `status.json`, `tracker.md`, and the FEV configs

## View it

From the repo root:

```
python3 server.py samples/serv_rf_if
```

Then open the printed URL (default http://127.0.0.1:8765). Use the Sessions tab to
see per-session token usage and cost, and step through the checkpoints on the Diff
and Files tabs.
