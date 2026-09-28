"""Shared implementation of the Mannerfelt et al. (2026) crowd-consensus algorithm.

This is the reference implementation used to precompute the published
consensus that the static website compares uploaded groups against. It mirrors
``ridal/misc/legacy_consensus_reference.py`` exactly; that script is the oracle
and this module exists so the build tooling and tests share one definition.

The algorithm (see ``ridal/assets/examples/dronbreen-20250327-DAT_0066_A1_1``):

* Reduce each contributor's picks to one value per ``(user, layer, trace)``
  with the *shallowest* pick (minimum depth/sample).
* Pool the bed layers (``bed`` and ``bed_no_temperate``) and the CTS layers
  (``bed_no_temperate`` and ``temperate_ice``).
* The consensus value is ``quantile(0.49, interpolation="lower")`` -- the order
  statistic at ``floor(0.49 * (n - 1))`` -- not the median.
* A position is dropped only where *more* contributors say the bed is missing
  (``bed_not_visible``) than say it is present; a tie is kept.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Final, Iterable

import numpy as np
import pandas as pd

#: Layer ids that are answers to "where is the bed".
BED_LAYERS: Final[tuple[str, ...]] = ("bed", "bed_no_temperate")

#: Layer ids that are answers to "where is the cold-temperate transition".
CTS_LAYERS: Final[tuple[str, ...]] = ("bed_no_temperate", "temperate_ice")

#: The layer drawn to say "the bed is not visible here".
MISSING_LAYER: Final[str] = "bed_not_visible"

#: Consensus percentile. 0.49 rather than 0.50 keeps a 50/50 split stable; the
#: published study used this value.
CONSENSUS_Q: Final[float] = 0.49

#: ridal's default radar velocity, in metres per nanosecond. Both processed
#: radargrams in the workspace used this, and the legacy consensus reference
#: reproduces the published thicknesses with it.
DEFAULT_VELOCITY_M_PER_NS: Final[float] = 0.168

#: Layers recognised in the published data. Anything else is reported rather
#: than silently dropped.
KNOWN_LAYERS: Final[frozenset[str]] = frozenset(
    (*BED_LAYERS, MISSING_LAYER, "temperate_ice")
)


def percentile_lower(values: np.ndarray, quantile: float) -> float:
    """Order statistic at ``floor(quantile * (n - 1))``, NaN-skipping.

    Examples
    --------
    >>> percentile_lower(np.array([10.0, 20.0, 30.0, 40.0, 50.0]), 0.49)
    20.0
    """
    finite = np.sort(np.asarray(values, dtype=float))
    finite = finite[~np.isnan(finite)]
    if finite.size == 0:
        return float("nan")
    return float(finite[int(np.floor(quantile * (finite.size - 1)))])


def nmad(values: np.ndarray) -> float:
    """Normalised median absolute deviation, NaN-skipping.

    Examples
    --------
    >>> round(nmad(np.array([1.0, 2.0, 3.0, 4.0, 100.0])), 4)
    1.4826
    """
    finite = np.asarray(values, dtype=float)
    finite = finite[~np.isnan(finite)]
    if finite.size == 0:
        return float("nan")
    return float(1.4826 * np.median(np.abs(finite - np.median(finite))))


@dataclass(frozen=True)
class RadarAxis:
    """Vertical axis metadata for one radargram, taken from a pick document."""

    t0_ns: float
    dt_ns: float
    n_samples: int
    n_traces: int
    velocity_m_per_ns: float = DEFAULT_VELOCITY_M_PER_NS

    def sample_to_depth_m(self, sample: np.ndarray) -> np.ndarray:
        """Convert integer sample indices to depth in metres."""
        twtt_ns = self.t0_ns + self.dt_ns * np.asarray(sample, dtype=float)
        return (twtt_ns / 2.0) * self.velocity_m_per_ns


def _interpolate_feature(coordinates: Iterable[Iterable[float]]) -> tuple[np.ndarray, np.ndarray]:
    """Resample a feature's vertices onto every integer trace it spans.

    Matches ``legacy_consensus_reference.read_picks``: contiguous runs of one
    rounded trace collapse to their mean ``y``, then the line is linearly
    interpolated over the trace span and rounded to whole samples.
    """
    vertices = np.asarray(list(coordinates), dtype=float)
    if vertices.ndim != 2 or vertices.shape[1] != 2 or vertices.size == 0:
        return np.empty(0, dtype=np.int64), np.empty(0, dtype=float)
    vertices = vertices[np.argsort(vertices[:, 0])]

    traces = np.rint(vertices[:, 0]).astype(np.int64)
    starts = np.r_[0, np.flatnonzero(traces[1:] != traces[:-1]) + 1]
    ends = np.r_[starts[1:], traces.size]
    unique_traces = traces[starts]
    mean_y = np.add.reduceat(vertices[:, 1], starts) / (ends - starts)
    if unique_traces.size == 0:
        return np.empty(0, dtype=np.int64), np.empty(0, dtype=float)

    span = np.arange(unique_traces[0], unique_traces[-1] + 1, dtype=np.int64)
    y_on_span = np.rint(np.interp(span, unique_traces, mean_y))
    return span, y_on_span


def read_gprinterp(path: Path, radargram: str, user: str, axis: RadarAxis) -> pd.DataFrame:
    """Read one gprinterp submission into per-trace pick rows.

    Returns
    -------
    pandas.DataFrame
        Columns ``user``, ``layer``, ``trace``, ``sample``, ``depth_m``.
    """
    import json

    document = json.loads(path.read_text())
    rows: list[dict] = []
    for feature in document["features"]:
        properties = feature["properties"]
        layer = properties.get("label")
        if layer not in KNOWN_LAYERS:
            raise ValueError(f"{path}: unknown layer label {layer!r}")
        span, y = _interpolate_feature(feature["geometry"]["coordinates"])
        if span.size == 0:
            continue
        sample = y.astype(np.int64)
        rows.append(
            pd.DataFrame(
                {
                    "user": user,
                    "layer": layer,
                    "trace": span,
                    "sample": sample,
                }
            )
        )
    if not rows:
        return pd.DataFrame(columns=["user", "layer", "trace", "sample"])
    frame = pd.concat(rows, ignore_index=True)
    in_grid = (frame["sample"] >= 0) & (frame["sample"] < axis.n_samples)
    frame = frame.loc[in_grid].copy()
    frame["depth_m"] = axis.sample_to_depth_m(frame["sample"].to_numpy())
    frame["radargram_id"] = radargram
    return frame[["radargram_id", "user", "layer", "trace", "sample", "depth_m"]]


def axis_from_document(document: dict) -> RadarAxis:
    """Build a :class:`RadarAxis` from a gprinterp document's coordinates."""
    anchor = document["coordinates"]["axes"]["y"]["anchor"][0]
    return RadarAxis(
        t0_ns=float(anchor.get("t0", 0.0)),
        dt_ns=float(anchor["dt"]),
        n_samples=int(document["source"]["n_samples"]),
        n_traces=int(document["source"]["n_traces"]),
    )


def reduce_shallowest(picks: pd.DataFrame) -> pd.DataFrame:
    """One value per ``(user, layer, trace)``: the minimum depth."""
    return (
        picks.groupby(["user", "layer", "trace"], as_index=False)["depth_m"]
        .min()
    )


def consensus_table(reduced: pd.DataFrame, traces: np.ndarray) -> pd.DataFrame:
    """Compute per-trace consensus columns from reduced picks.

    Parameters
    ----------
    reduced
        Output of :func:`reduce_shallowest`.
    traces
        The trace grid to index the result by.

    Returns
    -------
    pandas.DataFrame
        Indexed by ``trace`` with ``thickness`` (m), ``thickness_user_count``,
        ``thickness_user_nmad``, ``cts`` (m), ``cts_user_count`` and
        ``bed_missing_count``.
    """
    out = pd.DataFrame(index=pd.Index(traces, name="trace"), dtype=float)

    bed = reduced[reduced["layer"].isin(BED_LAYERS)].groupby("trace")["depth_m"]
    cts = reduced[reduced["layer"].isin(CTS_LAYERS)].groupby("trace")["depth_m"]

    out["thickness"] = bed.apply(lambda v: percentile_lower(v.to_numpy(), CONSENSUS_Q))
    out["thickness_user_count"] = bed.count()
    out["thickness_user_nmad"] = bed.apply(lambda v: nmad(v.to_numpy()))
    out["cts"] = cts.apply(lambda v: percentile_lower(v.to_numpy(), CONSENSUS_Q))
    out["cts_user_count"] = cts.count()

    missing = (
        reduced[reduced["layer"] == MISSING_LAYER].groupby("trace")["depth_m"].count()
    )
    out["bed_missing_count"] = missing
    present = out["thickness_user_count"].fillna(0)
    absent = out["bed_missing_count"].fillna(0)
    # Missing wins only where *more* contributors say so; a tie is kept.
    out.loc[absent > present, "thickness"] = np.nan
    return out
