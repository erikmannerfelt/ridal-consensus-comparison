#!/usr/bin/env python3
"""Build simulated "new group" uploads for the prototype.

Each demo is a zip holding the product an admin can download from a ridal
server for a group of contributors:

* ``picked-layer-points.csv`` -- long, one row per user/layer/trace, with
  ``depth_m`` (the shape of ``GET /api/v1/catalog/level2?format=csv``).

The derived-layer-points product is not used by the site, so it is not built.

A group is a deterministic subset of each radargram's contributors. Comparing
each group's consensus with the published reference (the full contributor set)
is exactly the "simulated new user consensus vs published subset" experiment.

Zips are used rather than loose CSVs so the repository stays small.

Usage
-----
    python3 tools/make_demo.py --zip interpretations_gprinterp.zip \
        --reference data/reference --out data/demo
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import consensus  # noqa: E402

#: How many contributors each simulated group has per radargram. ``None`` means
#: "everyone except two" -- the largest group the data supports.
GROUPS: dict[str, int | None] = {
    "small": 3,
    "medium": 6,
    "large": None,
}

#: Directory of processed radargrams. The site exemplifies only the radargrams
#: that actually have a file here, so the demo matches what can be inspected.
DEFAULT_RADARGRAM_DIR = Path("radargrams")

JOINED_BASE = [
    "radargram_id",
    "revision_id",
    "layer",
    "line_index",
    "point_index",
    "feature_id",
    "trace",
    "sample",
    "distance_m",
    "twtt_ns",
    "depth_m",
    "easting",
    "northing",
    "longitude",
    "latitude",
    "crs",
    "antenna_separation_effective_m",
    "twtt_anchor",
    "user",
]


def select_radargrams(index: dict, radargram_dir: Path) -> list[tuple[str, Path]]:
    """The (reference key, NetCDF path) pairs the directory actually contains.

    Processed radargram files are lower-case while the pick archive keeps the
    original case, so match case-insensitively.
    """
    lookup = {key.lower(): key for key in index["radargrams"]}
    selected: list[tuple[str, Path]] = []
    for path in sorted(radargram_dir.glob("*.nc")):
        key = lookup.get(path.stem.lower())
        if key is None:
            print(f"  note: {path.name} has no published reference; skipped", file=sys.stderr)
        else:
            selected.append((key, path))
    if not selected:
        raise SystemExit(f"no radargrams found under {radargram_dir}")
    return selected


def build_group_points(
    root: Path, keys: list[str], axes: dict[str, consensus.RadarAxis], chosen: dict[str, list[str]]
) -> pd.DataFrame:
    """All raw pick points for the chosen contributors, as long-format rows."""
    frames = []
    for key in keys:
        axis = axes[key]
        for path in sorted(root.glob(f"{key}/*.gprinterp.json")):
            user = path.name[: -len(".gprinterp.json")]
            if user not in chosen[key]:
                continue
            frame = consensus.read_gprinterp(path, key, user, axis)
            if not frame.empty:
                frames.append(frame)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def group_consensus(
    points: pd.DataFrame, key: str, axis: consensus.RadarAxis
) -> pd.DataFrame:
    """Consensus over one group's points for one radargram."""
    subset = points[points["radargram_id"] == key]
    traces = np.arange(axis.n_traces, dtype=np.int64)
    if subset.empty:
        return consensus.consensus_table(
            pd.DataFrame(columns=["user", "layer", "trace", "depth_m"]), traces
        )
    return consensus.consensus_table(consensus.reduce_shallowest(subset), traces)


def read_distances(selected: list[tuple[str, Path]]) -> dict[str, np.ndarray]:
    """Along-track distance per trace, read from each processed radargram."""
    import xarray as xr

    distances: dict[str, np.ndarray] = {}
    for key, path in selected:
        with xr.open_dataset(path) as dataset:
            distances[key] = dataset["distance"].values.astype(float)
    return distances


def to_picked_csv(
    points: pd.DataFrame, axes: dict[str, consensus.RadarAxis], distances: dict[str, np.ndarray]
) -> str:
    """Render group points in the level-2 CSV column order."""
    points = points.copy()
    points["revision_id"] = ""
    points["line_index"] = 0
    points["point_index"] = points.groupby(
        ["radargram_id", "user", "layer"], sort=False
    ).cumcount()
    points["feature_id"] = ""
    points["distance_m"] = [
        round(float(distances[rg][trace]), 4) if 0 <= trace < len(distances[rg]) else ""
        for rg, trace in zip(points["radargram_id"], points["trace"].astype(int))
    ]
    points["easting"] = ""
    points["northing"] = ""
    points["longitude"] = ""
    points["latitude"] = ""
    points["crs"] = ""
    points["antenna_separation_effective_m"] = ""
    points["twtt_anchor"] = ""
    points["twtt_ns"] = [
        round(axes[rg].t0_ns + axes[rg].dt_ns * s, 4)
        for rg, s in zip(points["radargram_id"], points["sample"])
    ]
    points["depth_m"] = points["depth_m"].round(6)
    return points[JOINED_BASE].to_csv(index=False)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", type=Path, default=Path("interpretations_gprinterp.zip"))
    parser.add_argument("--interpretations", type=Path, default=None)
    parser.add_argument("--reference", type=Path, default=Path("data/reference"))
    parser.add_argument("--out", type=Path, default=Path("data/demo"))
    parser.add_argument("--radargrams", type=Path, default=DEFAULT_RADARGRAM_DIR)
    parser.add_argument("--seed", type=int, default=20260928)
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    index = json.loads((args.reference / "index.json").read_text())
    selected = select_radargrams(index, args.radargrams)
    keys = [key for key, _ in selected]
    distances = read_distances(selected)
    print(f"Demo radargrams ({len(keys)}): {', '.join(keys)}", file=sys.stderr)

    cleanup = None
    if args.interpretations is not None:
        root = args.interpretations
    else:
        cleanup = tempfile.TemporaryDirectory()
        with zipfile.ZipFile(args.zip) as archive:
            archive.extractall(cleanup.name)
        root = Path(cleanup.name)

    axes: dict[str, consensus.RadarAxis] = {}
    for key in keys:
        first = sorted((root / key).glob("*.gprinterp.json"))[0]
        axes[key] = consensus.axis_from_document(json.loads(first.read_text()))

    rng = random.Random(args.seed)
    for name, size in GROUPS.items():
        chosen: dict[str, list[str]] = {}
        for key in keys:
            users = sorted(index["radargrams"][key]["contributors"])
            shuffled = users[:]
            rng.shuffle(shuffled)
            take = max(1, len(users) - 2) if size is None else min(size, len(users))
            chosen[key] = sorted(shuffled[:take])

        points = build_group_points(root, keys, axes, chosen)
        picked_csv = to_picked_csv(points, axes, distances)

        # Report how close this group lands, so the demo's expected numbers are
        # visible when it is built.
        errors = []
        for key in keys:
            table = group_consensus(points, key, axes[key])
            published = json.loads((args.reference / f"{key}.json").read_text())
            mine = table["thickness"].to_numpy(dtype=float)
            theirs = np.array(
                [np.nan if v is None else v for v in published["thickness"]], dtype=float
            )
            both = np.isfinite(mine) & np.isfinite(theirs)
            if both.any():
                errors.extend(np.abs(mine[both] - theirs[both]).tolist())
        error = np.array(errors)
        within = float(np.mean(error <= 2.0) * 100) if error.size else float("nan")
        print(
            f"  group-{name}: {len(chosen[keys[0]])} users/rg, {len(points)} points, "
            f"median|err|={np.median(error):.2f} m, within 2 m={within:.1f}%",
            file=sys.stderr,
        )

        destination = args.out / f"group-{name}.zip"
        with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("picked-layer-points.csv", picked_csv)
        print(f"  wrote {destination} ({destination.stat().st_size / 1e6:.1f} MB)", file=sys.stderr)

    if cleanup is not None:
        cleanup.cleanup()


if __name__ == "__main__":
    main()
