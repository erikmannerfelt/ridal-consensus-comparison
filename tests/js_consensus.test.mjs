// Cross-checks the browser consensus engine against the Python reference.
//
//   node tests/js_consensus.test.mjs
//
// Test 1 rebuilds one radargram's consensus from a committed reduced-pick
// fixture and compares it with data/reference/<key>.json, which the Python
// engine produced. Tests 2-3 pin the pure functions with hand-computed cases.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { consensusFromReduced, nmad, quantileLower, reducePicks } from "../app/consensus.js";
import { compareToReference, poolComparisons, alongTrackSlope, summariseSlopeSpread } from "../app/stats.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name} ${detail}`);
    failures += 1;
  }
}

function approx(a, b, tolerance) {
  if (!Number.isFinite(a) && !Number.isFinite(b)) return true;
  return Math.abs(a - b) <= tolerance;
}

// --- Test 1: JS consensus vs the Python reference ---------------------------
const fixture = JSON.parse(readFileSync(resolve(root, "tests/fixtures/js_crosscheck.json"), "utf8"));
const reference = JSON.parse(readFileSync(resolve(root, fixture.reference), "utf8"));
const reduced = fixture.rows.map(([userIndex, layer, trace, depth]) => ({
  user: fixture.users[userIndex],
  layer,
  trace,
  depth,
}));
const consensus = consensusFromReduced(reduced, fixture.n_traces);

let maxThicknessError = 0;
let maxCountError = 0;
let compared = 0;
let nullnessMismatches = 0;
for (let trace = 0; trace < fixture.n_traces; trace += 1) {
  const mine = consensus.thickness[trace];
  const theirs = reference.thickness[trace];
  if (!Number.isFinite(mine) && theirs === null) continue;
  if (Number.isFinite(mine) !== (theirs !== null)) {
    nullnessMismatches += 1;
    continue;
  }
  if (!Number.isFinite(mine) || theirs === null) continue;
  compared += 1;
  maxThicknessError = Math.max(maxThicknessError, Math.abs(mine - theirs));
  const theirCount = reference.thickness_count[trace];
  if (theirCount !== null) maxCountError = Math.max(maxCountError, Math.abs(consensus.thicknessCount[trace] - theirCount));
}
check("no null-ness disagreements", nullnessMismatches === 0, `mismatches=${nullnessMismatches}`);
check("fixture covers many traces", compared > 100, `compared=${compared}`);
check("thickness matches to rounding", maxThicknessError <= 1e-3, `max|err|=${maxThicknessError}`);
check("contributor counts match", maxCountError === 0, `max|err|=${maxCountError}`);

// --- Test 2: pure functions -------------------------------------------------
check("quantileLower 0.49 of five picks", quantileLower([10, 20, 30, 40, 50], 0.49) === 20);
check("quantileLower ignores NaN", quantileLower([NaN, 20, 10, 30], 0.49) === 10);
check("nmad of a known sample", approx(nmad([1, 2, 3, 4, 100]), 1.4826, 1e-9));

// The missing-bed rule: a tie keeps the bed, a majority of "not visible" drops it.
const tie = consensusFromReduced(
  [
    { user: "a", layer: "bed", trace: 0, depth: 10 },
    { user: "b", layer: "bed_not_visible", trace: 0, depth: 50 },
  ],
  1,
);
check("a bed/missing tie keeps the bed", Number.isFinite(tie.thickness[0]) && tie.thickness[0] === 10);
const lost = consensusFromReduced(
  [
    { user: "a", layer: "bed", trace: 0, depth: 10 },
    { user: "b", layer: "bed_not_visible", trace: 0, depth: 50 },
    { user: "c", layer: "bed_not_visible", trace: 0, depth: 50 },
  ],
  1,
);
check("a missing majority drops the bed", !Number.isFinite(lost.thickness[0]));

// Reducer: the shallowest pick per user/layer/trace wins.
const shallowestRows = reducePicks([
  { user: "a", layer: "bed", trace: 0, depth_m: 10 },
  { user: "a", layer: "bed", trace: 0, depth_m: 3 },
  { user: "b", layer: "bed", trace: 0, depth_m: 8 },
]);
const reducedShallowest = consensusFromReduced(shallowestRows.rows, 1);
check("shallowest reduction", reducedShallowest.thickness[0] === 3 && reducedShallowest.thicknessCount[0] === 2);

// --- Test 3: comparison and pooling ----------------------------------------
const values = Float64Array.from([10, 11, NaN, 20]);
const referenceSeries = [10, 13, 5, 18];
const comparison = compareToReference(values, referenceSeries);
check("comparison counts only jointly defined traces", comparison.compared === 3);
check("comparison median absolute difference", comparison.medianAbs === 2);
check("within-1m fraction", Math.abs(comparison.withinAbs[1] - 1 / 3) < 1e-9);
const pooled = poolComparisons([comparison, comparison]);
check("pooling doubles the sample", pooled.compared === 6 && pooled.medianAbs === 2);

// --- Test 4: along-track slope vs contributor spread ------------------------
// A central difference leaves the two endpoints without a value (NaN), so the
// checks look at the interior.
const distances = Float64Array.from([0, 1, 2, 3, 4, 5, 6]);
const flat = Float64Array.from([10, 10, 10, 10, 10, 10, 10]);
const squares = Float64Array.from([0, 1, 4, 9, 16, 25, 36]); // slope 2t in the interior
const linear = Float64Array.from([0, 2, 4, 6, 8, 10, 12]);

const flatSlope = alongTrackSlope(flat, distances, 1);
const squareSlope = alongTrackSlope(squares, distances, 1);
const interior = (array) => [...array].slice(1, -1);
check("a flat series has zero slope", interior(flatSlope).every((value) => Math.abs(value) < 1e-12));
check("a square series has slope 2t", interior(squareSlope).every((value, index) => Math.abs(value - 2 * (index + 1)) < 1e-12));
check("slope falls back to trace spacing", interior(alongTrackSlope(linear, null, 1)).every((value) => value === 2));

const spread = squareSlope.map((value) => value / 10);
const summary = summariseSlopeSpread([{ slope: squareSlope, spread }], 4);
check("only interior positions enter the slope/spread summary", summary.n === 5, `n=${summary.n}`);
check("slope and spread are perfectly correlated here", Math.abs(summary.spearman - 1) < 1e-9);
check(
  "steepest positions have the largest spread",
  summary.steepestMedian > summary.flattestMedian,
  `${summary.steepestMedian} vs ${summary.flattestMedian}`,
);
check(
  "the trend is anchored to the data's full angle range",
  Math.abs(summary.bins[0].mid - summary.minAngle) < 1e-12 &&
    Math.abs(summary.bins.at(-1).mid - summary.maxAngle) < 1e-12,
);
check(
  "angles are degrees",
  Math.abs(summary.minAngle - (Math.atan(2) * 180) / Math.PI) < 1e-9,
  `${summary.minAngle}`,
);
check(
  "each bin has a 25-75% range around its median",
  summary.bins.every((bin) => bin.q25Spread <= bin.medianSpread && bin.medianSpread <= bin.q75Spread),
);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll JavaScript consensus checks passed.");
