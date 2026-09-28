#!/usr/bin/env python3
"""Export a small reduced-pick fixture for the JavaScript cross-check.

The JS consensus engine is a port of :mod:`tools.consensus`. To prove the two
agree, this writes one radargram's reduced picks to
``tests/fixtures/js_crosscheck.json``; ``tests/js_consensus.test.mjs`` rebuilds
the consensus in JavaScript and compares it with ``data/reference/<key>.json``,
which the Python engine produced.

Usage
-----
    python3 tools/export_fixture.py --zip interpretations_gprinterp.zip
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import zipfile
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import consensus  # noqa: E402

#: A mid-sized radargram: enough traces to be meaningful, small enough to
#: commit as JSON.
DEFAULT_KEY = "bergmesterbreen-20230222-DAT_0036_A1_1"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", type=Path, default=Path("interpretations_gprinterp.zip"))
    parser.add_argument("--interpretations", type=Path, default=None)
    parser.add_argument("--key", default=DEFAULT_KEY)
    parser.add_argument("--out", type=Path, default=Path("tests/fixtures/js_crosscheck.json"))
    args = parser.parse_args()

    cleanup = None
    if args.interpretations is not None:
        root = args.interpretations
    else:
        cleanup = tempfile.TemporaryDirectory()
        with zipfile.ZipFile(args.zip) as archive:
            archive.extractall(cleanup.name)
        root = Path(cleanup.name)

    paths = sorted((root / args.key).glob("*.gprinterp.json"))
    if not paths:
        raise SystemExit(f"no submissions for {args.key} in {root}")

    axis = consensus.axis_from_document(json.loads(paths[0].read_text()))
    frames = []
    users = []
    for path in paths:
        user = path.name[: -len(".gprinterp.json")]
        users.append(user)
        frame = consensus.read_gprinterp(path, args.key, user, axis)
        if not frame.empty:
            frames.append(frame)
    picks = pd.concat(frames, ignore_index=True)
    reduced = consensus.reduce_shallowest(picks)

    user_index = {user: i for i, user in enumerate(users)}
    rows = [
        [user_index[user], layer, int(trace), round(float(depth), 6)]
        for user, layer, trace, depth in reduced.itertuples(index=False, name=None)
    ]

    payload = {
        "key": args.key,
        "n_traces": axis.n_traces,
        "n_samples": axis.n_samples,
        "dt_ns": axis.dt_ns,
        "t0_ns": axis.t0_ns,
        "users": users,
        "reference": "data/reference/" + args.key + ".json",
        "rows": rows,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(f"Wrote {len(rows)} reduced rows to {args.out}", file=sys.stderr)
    if cleanup is not None:
        cleanup.cleanup()


if __name__ == "__main__":
    main()
