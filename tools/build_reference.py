#!/usr/bin/env python3
"""Precompute the published consensus for every radargram in the pick archive.

Reads a zip (or directory) laid out as ``<radargram>/<user>.gprinterp.json``
-- the shape of ``interpretations_gprinterp.zip`` and of
``ridal.misc.convert_legacy_interpretations`` output -- and writes one compact
JSON file per radargram plus an ``index.json`` under ``--out``.

The consensus is defined in :mod:`tools.consensus`. Depth is converted from the
pick document's own TWTT anchor with a constant velocity, so no processed
NetCDF is required; see the module docstring for why that is sound.

Usage
-----
    python3 tools/build_reference.py \
        --zip interpretations_gprinterp.zip --out data/reference
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import consensus  # noqa: E402  (path is adjusted above)


def _iter_documents(root: Path) -> dict[str, list[Path]]:
    """Group ``*.gprinterp.json`` paths by radargram (the parent directory)."""
    grouped: dict[str, list[Path]] = defaultdict(list)
    for path in sorted(root.rglob("*.gprinterp.json")):
        grouped[path.parent.name].append(path)
    return grouped


def build_one(
    radargram: str, paths: list[Path], velocity: float
) -> tuple[dict, RadarIndexEntry]:
    """Compute the consensus for one radargram and return its serializable form."""
    import json as _json

    first = _json.loads(paths[0].read_text())
    axis = consensus.axis_from_document(first)
    if velocity != consensus.DEFAULT_VELOCITY_M_PER_NS:
        axis = consensus.RadarAxis(
            t0_ns=axis.t0_ns,
            dt_ns=axis.dt_ns,
            n_samples=axis.n_samples,
            n_traces=axis.n_traces,
            velocity_m_per_ns=velocity,
        )

    frames = []
    for path in paths:
        user = path.name[: -len(".gprinterp.json")]
        document = _json.loads(path.read_text())
        frame = consensus.read_gprinterp(path, radargram, user, axis)
        if not frame.empty:
            frames.append(frame)

    traces = np.arange(axis.n_traces, dtype=np.int64)
    if not frames:
        table = pd.DataFrame(index=pd.Index(traces, name="trace"), dtype=float)
        for column in (
            "thickness",
            "thickness_user_count",
            "thickness_user_nmad",
            "cts",
            "cts_user_count",
            "bed_missing_count",
        ):
            table[column] = np.nan
    else:
        picks = pd.concat(frames, ignore_index=True)
        reduced = consensus.reduce_shallowest(picks)
        table = consensus.consensus_table(reduced, traces)

    contributors = Counter()
    difficulties = Counter()
    for path in paths:
        document = _json.loads(path.read_text())
        contributors[path.name[: -len(".gprinterp.json")]] = len(document["features"])
        difficulties[document.get("meta", {}).get("difficulty")] += 1

    def _numbers(column: str) -> list:
        values = table[column].to_numpy(dtype=float)
        count_is_integer = column.endswith("_count")
        out = []
        for value in values:
            if np.isnan(value):
                out.append(None)
            elif count_is_integer:
                out.append(int(value))
            else:
                out.append(round(float(value), 3))
        return out

    payload = {
        "key": radargram,
        "n_traces": axis.n_traces,
        "n_samples": axis.n_samples,
        "twtt": {"t0_ns": axis.t0_ns, "dt_ns": axis.dt_ns},
        "velocity_m_per_ns": axis.velocity_m_per_ns,
        "thickness": _numbers("thickness"),
        "thickness_count": _numbers("thickness_user_count"),
        "thickness_nmad": _numbers("thickness_user_nmad"),
        "cts": _numbers("cts"),
        "cts_count": _numbers("cts_user_count"),
        "bed_missing_count": _numbers("bed_missing_count"),
    }
    entry: RadarIndexEntry = {
        "n_traces": axis.n_traces,
        "n_samples": axis.n_samples,
        "contributors": dict(sorted(contributors.items())),
        "difficulties": dict(difficulties),
        "n_consensus_positions": int(np.isfinite(table["thickness"].to_numpy()).sum()),
        "n_picked_positions": int(np.isfinite(table["cts"].to_numpy()).sum()),
    }
    return payload, entry


RadarIndexEntry = dict


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", type=Path, default=Path("interpretations_gprinterp.zip"))
    parser.add_argument("--interpretations", type=Path, default=None)
    parser.add_argument("--out", type=Path, default=Path("data/reference"))
    parser.add_argument("--velocity", type=float, default=consensus.DEFAULT_VELOCITY_M_PER_NS)
    parser.add_argument("--limit", type=int, default=None, help="Only the first N radargrams.")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)

    if args.interpretations is not None:
        grouped = _iter_documents(args.interpretations)
        source = str(args.interpretations)
        cleanup = None
    else:
        import tempfile

        cleanup = tempfile.TemporaryDirectory()
        with zipfile.ZipFile(args.zip) as archive:
            archive.extractall(cleanup.name)
        grouped = _iter_documents(Path(cleanup.name))
        source = str(args.zip)

    keys = sorted(grouped)
    if args.limit is not None:
        keys = keys[: args.limit]

    index: dict = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "velocity_m_per_ns": args.velocity,
        "radargrams": {},
    }
    for i, key in enumerate(keys, start=1):
        payload, entry = build_one(key, grouped[key], args.velocity)
        (args.out / f"{key}.json").write_text(
            json.dumps(payload, separators=(",", ":")) + "\n"
        )
        index["radargrams"][key] = entry
        print(
            f"[{i}/{len(keys)}] {key}: {entry['n_traces']} traces, "
            f"{len(entry['contributors'])} contributors, "
            f"{entry['n_consensus_positions']} consensus positions",
            file=sys.stderr,
        )

    (args.out / "index.json").write_text(json.dumps(index, indent=2) + "\n")
    print(f"Wrote {len(keys)} radargrams to {args.out}", file=sys.stderr)
    if cleanup is not None:
        cleanup.cleanup()


if __name__ == "__main__":
    main()
