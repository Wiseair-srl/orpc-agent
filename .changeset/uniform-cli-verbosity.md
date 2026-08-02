---
"@orpc-agent/cli": minor
---

Add `--verbosity min|normal|detail` (with `--detail` as shorthand), shared with the sibling agent-surface CLI.

`min` stops at the headline; `detail` prints each capability's description and declared execution metadata — tags, per-surface tool names, approval type, idempotency, retry, timeout, redaction — under its row, in both the drawn and the plain renderer. On `check`, `detail` also prints the inventory the gate compared after the drift report, and `min` keeps only the drift headline and per-kind counts.

The plain renderer now colour-codes side effect, risk and approval like the interactive view (only when attached to a terminal — piped, `CI` and `NO_COLOR` output is byte-identical to before). The inspect headline now also counts unexposed and excluded procedures. `--format` accepts `markdown` as a spelling of `md` and `json` as a spelling of `--json`. `renderInventory` and `renderChanges` gain an optional trailing `verbosity` parameter, and the `Verbosity` type is exported.
