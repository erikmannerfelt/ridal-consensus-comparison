// The crowd-consensus algorithm, at its core a per-trace order statistic.
//
// This is a faithful port of tools/consensus.py (itself a reproduction of the
// published study) so the site and the precomputed reference cannot disagree.
// See that module for the reasoning behind 0.49 and the missing-bed rule.

import { BED_LAYERS, CTS_LAYERS, CONSENSUS_Q, MISSING_LAYER } from "./constants.js";

const BED = new Set(BED_LAYERS);
const CTS = new Set(CTS_LAYERS);

/** True when a value is a usable finite number. */
export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Order statistic at floor(q * (n - 1)), NaN-skipping.
 * This is pandas' quantile(q, interpolation="lower"); it never interpolates.
 */
export function quantileLower(values, q = CONSENSUS_Q) {
  const finite = [];
  for (const v of values) if (isFiniteNumber(v)) finite.push(v);
  if (finite.length === 0) return NaN;
  finite.sort((a, b) => a - b);
  return finite[Math.floor(q * (finite.length - 1))];
}

/** Normalised median absolute deviation, NaN-skipping. */
export function nmad(values) {
  const finite = [];
  for (const v of values) if (isFiniteNumber(v)) finite.push(v);
  if (finite.length === 0) return NaN;
  const median = quantileMedian(finite);
  const deviations = finite.map((v) => Math.abs(v - median));
  return 1.4826 * quantileMedian(deviations);
}

function quantileMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Collapse long pick rows to one value per (user, layer, trace): the
 * shallowest depth, because stray picks on multiples lie below the reflector.
 */
export function reducePicks(rows) {
  const best = new Map();
  const users = new Set();
  const layers = new Set();
  for (const row of rows) {
    const trace = Math.round(Number(row.trace));
    const depth = Number(row.depth_m);
    if (!isFiniteNumber(trace) || !isFiniteNumber(depth)) continue;
    users.add(row.user);
    layers.add(row.layer);
    const key = `${row.user}\u0000${row.layer}\u0000${trace}`;
    const current = best.get(key);
    if (current === undefined || depth < current.depth) {
      best.set(key, { user: row.user, layer: row.layer, trace, depth });
    }
  }
  return {
    rows: [...best.values()],
    users: [...users].sort(),
    layers: [...layers].sort(),
  };
}

/**
 * Compute the per-trace consensus from reduced picks.
 *
 * Returns typed arrays indexed by integer trace, plus per-trace maps of each
 * contributor's own value that the inter-user and per-user statistics need.
 */
export function consensusFromReduced(reducedRows, nTraces) {
  const thickness = new Float64Array(nTraces).fill(NaN);
  const thicknessCount = new Int32Array(nTraces);
  const thicknessNmads = new Float64Array(nTraces).fill(NaN);
  const cts = new Float64Array(nTraces).fill(NaN);
  const ctsCount = new Int32Array(nTraces);
  const ctsNmads = new Float64Array(nTraces).fill(NaN);
  const missingCount = new Int32Array(nTraces);

  const byTrace = new Map();
  for (const row of reducedRows) {
    if (row.trace < 0 || row.trace >= nTraces) continue;
    let entry = byTrace.get(row.trace);
    if (entry === undefined) {
      entry = { bed: [], cts: [], userBed: new Map(), userCts: new Map(), missing: 0 };
      byTrace.set(row.trace, entry);
    }
    if (BED.has(row.layer)) {
      entry.bed.push(row.depth);
      const mine = entry.userBed.get(row.user);
      if (mine === undefined || row.depth < mine) entry.userBed.set(row.user, row.depth);
    }
    if (CTS.has(row.layer)) {
      entry.cts.push(row.depth);
      const mine = entry.userCts.get(row.user);
      if (mine === undefined || row.depth < mine) entry.userCts.set(row.user, row.depth);
    }
    if (row.layer === MISSING_LAYER) entry.missing += 1;
  }

  for (const [trace, entry] of byTrace) {
    if (entry.bed.length) {
      thickness[trace] = quantileLower(entry.bed, CONSENSUS_Q);
      thicknessCount[trace] = entry.bed.length;
      thicknessNmads[trace] = nmad(entry.bed);
    }
    if (entry.cts.length) {
      cts[trace] = quantileLower(entry.cts, CONSENSUS_Q);
      ctsCount[trace] = entry.cts.length;
      ctsNmads[trace] = nmad(entry.cts);
    }
    missingCount[trace] = entry.missing;
    if (entry.missing > entry.bed.length) thickness[trace] = NaN;
  }

  return {
    nTraces,
    thickness,
    thicknessCount,
    thicknessNmads,
    cts,
    ctsCount,
    ctsNmads,
    missingCount,
    byTrace,
  };
}

/**
 * Field names for one comparable quantity. Both thickness and CTS depth are
 * per-trace layers with a group consensus, a per-contributor map and a
 * published reference, so every statistic can be mirrored between them.
 */
export function metricAccessors(metric) {
  if (metric === "cts") {
    return {
      key: "cts",
      label: "CTS depth",
      unit: "m",
      series: "cts",
      count: "ctsCount",
      nmadField: "ctsNmads",
      userMap: "userCts",
      referenceKey: "cts",
    };
  }
  return {
    key: "thickness",
    label: "Ice thickness",
    unit: "m",
    series: "thickness",
    count: "thicknessCount",
    nmadField: "thicknessNmads",
    userMap: "userBed",
    referenceKey: "thickness",
  };
}
