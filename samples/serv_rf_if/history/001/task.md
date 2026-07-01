## Task: Preparation

Summary: Prepare the initial code, tracker, status, and FEV configurations to begin conversion.

### Continuation

If asked to continue a conversion that has already been started, `cd` to the given working directory for the conversion, and assess the current progress in `status.md` and `tracker.md` as well as reviewing the current code. Skip ahead to the appropriate task using `./scripts/get_task.py '<task-title>'` to continue the work in progress.

### `prep.sh`

When starting fresh, a script `desktop_agent_verilog_conversion/prep.sh` assists you in initializing the conversion directory. The user should have provided you with a directory path and a Verilog file path to use for the conversion. Search the Verilog file to find its module name (perhaps `grep module <orig.sv>`), then run `.../prep.sh <directory> <verilog-file> <module-name>` to safely create and initialize `<directory>` with:

- `prepared.sv`, `wip.tlv`, and `feved.tlv`: as copies of <verilog-file>
- `tracker.md`: Some initial empty categories (which you may change as appropriate).
- `status.json`: to contain: `{"task": "Preparation", "fev.sh": "none", "llm": ""}
- `fev.eqy` and `fev_full.eqy`: based on the template `fev.eqy` in `desktop_agent_verilog_conversion/fev/`.
- `scripts/`: as a link to the `desktop_agent_verilog_conversion/` directory containing all helper scripts (e.g. `fev.sh` and `get_task.py`).

<directory> and <verilog-file> must be given as absolute paths.

After running `prep.sh ...`, `cd` to <directory>. As you consider the remaining instructions for this task, update `prepared.sv`, `tracker.md`, and `status.json`.

### Libraries

`prepared.sv` may depend on external files via tick-include statements, or it might depend on the build environment to provide other files on the command line...
The MCP tools require the top-level module definition to be encapsulated in a single file. This includes any submodules, functions, and macro definitions that might be instantiated by the module. If any other files are needed, either find them and inline the needed content, or record the issue and stop to give the user a chance to assess the situation.

### Latch-based Design

It is expected that the original design is flip-flop-based, triggered by the rising edge of the clock. If logic is driven by the falling edge of the clock, it may be converted to transition a phase earlier or later as long as the output timing is preserved for FEV. This may require the use of grouping/partitioning statements in EQY configurations. Any changes like this that may impact the nature of the physical implementation should be noted in `tracker.md`.

### Clock Gating/Enabling

Clock gating logic can be difficult to convert. TL-Verilog logic infers flip-flops and does not have direct control over the application of clock to them. TL-Verilog supports fine-grained clock gating or enables using "when conditions", e.g., `?$valid`. This can be used to create clock gating that matches the original, but it may result in awkward code.

There is a distinction between functional and non-functional clock gating/enabling. In functional gating/enabling the gating is functionally required. In non-functional clock gating, the gating condition is functionally a DONT-CARE. If we know the gating to be non-functional, we have more flexibility in the conversion.

If the module has clock gating/enable inputs that can be determined to be non-functional, assume the input to be DONT-CARE (1'bX). Comment on the use of clock gating or clock enabling in the original code and any modification to the code.

### No Tri-States

This process does not support conversion of tri-states. You may continue, but note the issue in `tracker.md`.

### Prepare the Code

Make sure you are in the established working directory for this conversion. Prepare `prepared.sv` as instructed above if needed. If any modifications were necessary from the original code or issues are found, report them in `tracker.md` and to the user.

This establishes the baseline code that you will convert. Henceforth, all modifications will be made in `wip.tlv` and MUST PASS FEV using `fev.sh`. If you made changes to `prepared.sv`, copy `prepared.sv` to `wip.tlv` and `feved.tlv`.

Run `fev.sh` for this task as well. It should pass since there are no changes vs. `wip.tlv`, but this will catch any script and setup errors before you begin refactoring.


