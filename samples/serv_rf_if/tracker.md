## Conversion Tracker: serv_rf_if

### Status

Conversion complete. FEV passes for all runs: incremental, full (`WITH_CSR=1`), and `WITH_CSR=0`.

### Naming Conflicts

Two input pipesignal names required special handling due to conflicts with other signals:

- `i_rd_wen` → `$rd_wen_in` (avoids conflict with the computed `$rd_wen = $rd_wen_in & (|$rd_waddr)`)
- `i_csr` → `$csr_in` (avoids conflict with the output pipesignal `$csr`)

These are minor deviations from the usual convention of dropping the `i_` prefix.

### Code Size

- `prepared.sv`: 153 lines (two generate branches: WITH_CSR and no_CSR)
- `wip.tlv`: 175 lines (TLV macro + module body with input/output connection sections)

The TLV macro logic (≈70 lines) is smaller than the combined original branches (≈90 lines), because the generate `if`/`else` was unified into a single set of `(|WITH_CSR)` ternary expressions. The file is larger overall due to the 35-line input/output connection boilerplate.

### Dead Logic When WITH_CSR=0

`$mtval` and `$sel_rs2` are computed unconditionally but their values are unused when `WITH_CSR=0`. They appear as dead logic in that configuration. This is harmless but could be eliminated with M5 conditioning (a functional change that cannot be FEVed in the current framework without additional work).

### Parameter Configurations

Two configurations are FEV'd:
1. `WITH_CSR=1` (`fev_full.eqy`): matches `rd_wen`, `gen_csr.rd`, `gen_csr.mtval`, `gen_csr.sel_rs2`
2. `WITH_CSR=0` (`fev_full_WITH_CSR_0.eqy`): matches `rd_wen`, `gen_no_csr.rd`

`W` (data width) is held at 1 in both. Widening `W` changes vector widths only, not logic structure.

### Potential Further Optimizations

- **M5 conditioning for dead logic**: `$mtval` and `$sel_rs2` could be wrapped in `m5_if_eq_block(WITH_CSR, 1, ...)` to eliminate them when `WITH_CSR=0`. This is a functional change in the generated Verilog (though logically equivalent in context) and would require special FEV handling.
- **`$rd` computation**: The CSR term `{W{$rd_csr_en}} & $csr_rd` is similarly conditioned via a ternary. Explicit M5 conditioning would be cleaner but requires the same approach.

### Process Improvement Notes

- `no_tabs.py` could not auto-detect tab width during the No Tabs task (scores were too close across widths). Manual replacement was required. Suggestion: add an explicit `--tab-width` CLI argument as a fallback.
- The generate `if`/`else` elimination (Simplify Code Generation task) made the Signal Assignments task trivial, since no assignments remained in generate blocks at that point. The task ordering worked well for this module.
