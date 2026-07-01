## Conversion Tracker: serv_rf_if

### Parameter Configurations

Two parameter configurations are tested:
1. Default: `WITH_CSR=1, W=1` — original `gen_csr` branch; now mapped to unified signals `rd`, `mtval`, `sel_rs2`.
2. `WITH_CSR=0` (`fev_full_WITH_CSR_0.eqy`) — original `gen_no_csr` branch; now mapped to unified `rd`.

`W` (data width) is kept at 1 (SERV serial RISC-V typical usage). Widening W doesn't change logic structure, only vector widths.

### Simplify Code Generation

The single `generate if (|WITH_CSR)` block was fully eliminated. Unified `rd` uses a `(|WITH_CSR)` ternary to gate the CSR term, ensuring correctness for both parameter values under FEV. `mtval` and `sel_rs2` become dead logic when `WITH_CSR=0` but do not create FEV issues (no cutpoint match). No remaining `generate` blocks.

### Process Improvement Note (No Tabs task)

`no_tabs.py` could not auto-detect tab width (scores 102 for width 8, 101 for widths 4 and 6; margin below threshold). Manual replacement with 8-space tabs was required. Suggestion: allow an explicit tab-width CLI argument in `no_tabs.py` as a fallback, or lower the confidence threshold slightly.
