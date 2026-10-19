#!/bin/bash
# Suite check for "driftscore" (tests/run_suite.sh): the per-frame trace of
# tests/scripts/drift_score.txt must follow the drift scoring rules: the
# accrual law, banking and the crash loss (tools/drift_accrual.py).
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec "$ROOT/.venv/bin/python" "$ROOT/tools/drift_accrual.py" "$1"
