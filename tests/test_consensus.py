#!/usr/bin/env python3
"""Validate the shared consensus engine against the committed oracle fixture.

The fixture is ``ridal/assets/interp/dronbreen-20250327-DAT_0066_A1_1``: ten
gprinterp submissions and ``expected_consensus.csv``, the published values the
study's consensus must reproduce. ``ridal/`` is git-ignored in this repository,
so the test skips, loudly, when the fixture is absent.

    python3 tests/test_consensus.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import consensus  # noqa: E402

FIXTURE = ROOT / "ridal" / "assets" / "interp" / "dronbreen-20250327-DAT_0066_A1_1"
KEY = "dronbreen-20250327-DAT_0066_A1_1"


def main() -> int:
    if not FIXTURE.exists():
        print(f"SKIP: fixture not found at {FIXTURE}", file=sys.stderr)
        return 0

    documents = sorted(FIXTURE.glob("*.gprinterp.json"))
    axis = consensus.axis_from_document(json.loads(documents[0].read_text()))

    frames = []
    for path in documents:
        user = path.name[: -len(".gprinterp.json")]
        frame = consensus.read_gprinterp(path, KEY, user, axis)
        if not frame.empty:
            frames.append(frame)
    picks = pd.concat(frames, ignore_index=True)
    reduced = consensus.reduce_shallowest(picks)
    table = consensus.consensus_table(reduced, np.arange(axis.n_traces, dtype=np.int64))

    expected = pd.read_csv(FIXTURE / "expected_consensus.csv").set_index("trace")
    joined = table.join(expected, how="inner", rsuffix="_exp")
    assert len(joined) > 0, "no overlapping traces"

    # The paper's ``temperate`` column is a rule-based quantity, not the 0.49
    # order statistic over the CTS pool, so it is deliberately not compared
    # here. Ice thickness is the published consensus this site measures
    # against, and it reproduces exactly.
    checks = {
        "thickness": "thickness",
        "thickness_user_count": "thickness_user_count",
        "thickness_user_nmad": "thickness_user_nmad",
    }
    failures = 0
    for mine, theirs in checks.items():
        error = (joined[mine] - joined[theirs]).abs().dropna()
        median = float(error.median()) if len(error) else float("nan")
        maximum = float(error.max()) if len(error) else float("nan")
        tolerance = 2e-3 if mine != "thickness_user_count" else 1.0
        status = "ok" if median <= tolerance else "FAIL"
        failures += status == "FAIL"
        print(f"  {status:4} {mine:22} median|err|={median:.6g} max|err|={maximum:.6g}")

    if failures:
        print(f"{failures} check(s) failed", file=sys.stderr)
        return 1
    print("All consensus checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
