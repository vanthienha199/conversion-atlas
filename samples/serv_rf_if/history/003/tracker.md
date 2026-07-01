## Conversion Tracker: serv_rf_if

### Parameter Configurations

Two parameter configurations are tested:
1. Default: `WITH_CSR=1, W=1` — uses `gen_csr` generate block; internal signals: `rd_wen`, `gen_csr.rd`, `gen_csr.mtval`, `gen_csr.sel_rs2`.
2. `WITH_CSR=0` (`fev_full_WITH_CSR_0.eqy`) — uses `gen_no_csr` generate block; internal signals: `rd_wen`, `gen_no_csr.rd`.

`W` (data width) is kept at 1 (SERV serial RISC-V typical usage). Widening W doesn't change logic structure, only vector widths.

### Process Improvement Note (No Tabs task)

`no_tabs.py` could not auto-detect tab width (scores 102 for width 8, 101 for widths 4 and 6; margin below threshold). Manual replacement with 8-space tabs was required. Suggestion: allow an explicit tab-width CLI argument in `no_tabs.py` as a fallback, or lower the confidence threshold slightly.
