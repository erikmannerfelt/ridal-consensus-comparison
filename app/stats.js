// Agreement statistics over an analysed group. Every function is pure: it
// takes the output of the consensus engine and a published reference and
// returns plain numbers, so the same code runs in the browser and in tests.

import { ABS_TOLERANCES, REL_TOLERANCES } from "./constants.js";
import { metricAccessors, nmad, quantileLower } from "./consensus.js";

function median(values) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, fraction) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

/**
 * Compare a per-trace series against the published reference.
 *
 * @param {Float64Array} values     group consensus indexed by trace
 * @param {Array<number|null>} reference published values indexed by trace
 * @returns {object} differences and coverage statistics
 */
export function compareToReference(values, reference) {
  const differences = [];
  const signed = [];
  const referenceValues = [];
  let compared = 0;
  let absoluteWithin = {};
  let relativeWithin = {};
  for (const tol of ABS_TOLERANCES) absoluteWithin[tol] = 0;
  for (const tol of REL_TOLERANCES) relativeWithin[tol] = 0;

  const length = Math.min(values.length, reference.length);
  for (let trace = 0; trace < length; trace += 1) {
    const mine = values[trace];
    const theirs = reference[trace];
    if (!Number.isFinite(mine) || theirs === null || theirs === undefined || !Number.isFinite(theirs)) {
      continue;
    }
    compared += 1;
    const difference = mine - theirs;
    differences.push(Math.abs(difference));
    signed.push(difference);
    referenceValues.push(theirs);
    for (const tol of ABS_TOLERANCES) if (Math.abs(difference) <= tol) absoluteWithin[tol] += 1;
    for (const tol of REL_TOLERANCES) {
      if (Math.abs(difference) <= (Math.abs(theirs) * tol) / 100) relativeWithin[tol] += 1;
    }
  }

  if (compared === 0) {
    return {
      compared: 0,
      coverage: 0,
      medianAbs: NaN,
      meanAbs: NaN,
      bias: NaN,
      rmse: NaN,
      p90Abs: NaN,
      maxAbs: NaN,
      withinAbs: {},
      withinRel: {},
      differences: [],
      signedDifferences: [],
      referenceValues: [],
    };
  }

  for (const tol of ABS_TOLERANCES) absoluteWithin[tol] /= compared;
  for (const tol of REL_TOLERANCES) relativeWithin[tol] /= compared;
  const squared = differences.reduce((sum, value) => sum + value * value, 0);

  return {
    compared,
    coverage: compared / values.length,
    medianAbs: median(differences),
    meanAbs: differences.reduce((sum, value) => sum + value, 0) / compared,
    bias: median(signed),
    rmse: Math.sqrt(squared / compared),
    p90Abs: percentile(differences, 0.9),
    maxAbs: Math.max(...differences),
    withinAbs: absoluteWithin,
    withinRel: relativeWithin,
    differences,
    signedDifferences: signed,
    referenceValues,
  };
}

/** Pool several comparisons into one, ignoring their per-radargram summaries. */
export function poolComparisons(comparisons) {
  const differences = [];
  const signed = [];
  const referenceValues = [];
  for (const comparison of comparisons) {
    differences.push(...comparison.differences);
    signed.push(...comparison.signedDifferences);
    referenceValues.push(...comparison.referenceValues);
  }
  return summariseDifferences(differences, signed, referenceValues);
}

function summariseDifferences(differences, signed, referenceValues = []) {
  const compared = differences.length;
  if (compared === 0) {
    return {
      compared: 0,
      medianAbs: NaN,
      meanAbs: NaN,
      bias: NaN,
      rmse: NaN,
      p90Abs: NaN,
      maxAbs: NaN,
      withinAbs: {},
      withinRel: {},
      differences,
      signedDifferences: signed,
      referenceValues,
    };
  }
  const withinAbs = {};
  const withinRel = {};
  for (const tol of ABS_TOLERANCES) withinAbs[tol] = differences.filter((d) => d <= tol).length / compared;
  for (const tol of REL_TOLERANCES) {
    const hits = differences.filter(
      (difference, index) => difference <= (Math.abs(referenceValues[index]) * tol) / 100,
    ).length;
    withinRel[tol] = referenceValues.length === compared ? hits / compared : NaN;
  }
  const squared = differences.reduce((sum, value) => sum + value * value, 0);
  return {
    compared,
    medianAbs: median(differences),
    meanAbs: differences.reduce((sum, value) => sum + value, 0) / compared,
    bias: median(signed),
    rmse: Math.sqrt(squared / compared),
    p90Abs: percentile(differences, 0.9),
    maxAbs: Math.max(...differences),
    withinAbs,
    withinRel,
    differences,
    signedDifferences: signed,
    referenceValues,
  };
}

/** Build per-contributor series (indexed by trace) for one metric. */
function userSeriesFromConsensus(consensus, userMap) {
  const series = new Map();
  for (const [trace, entry] of consensus.byTrace) {
    for (const [user, value] of entry[userMap]) {
      let array = series.get(user);
      if (array === undefined) {
        array = new Float64Array(consensus.nTraces).fill(NaN);
        series.set(user, array);
      }
      array[trace] = value;
    }
  }
  return series;
}

/**
 * Per-contributor statistics: coverage, and agreement with the group's own
 * consensus and with the published reference.
 */
export function perUserStats(consensus, reference, options = {}) {
  const tolerance = options.tolerance ?? 2.0;
  const accessor = metricAccessors(options.metric);
  const series = userSeriesFromConsensus(consensus, accessor.userMap);
  const group = consensus[accessor.series];
  const published = reference?.[accessor.referenceKey] ?? null;

  const users = [...series.keys()].sort();
  const results = [];

  for (const user of users) {
    const values = series.get(user);
    const deviationsGroup = [];
    const deviationsPublished = [];
    let withinGroup = 0;
    let withinPublished = 0;
    let groupCompared = 0;
    let publishedCompared = 0;
    let coverage = 0;

    for (let trace = 0; trace < consensus.nTraces; trace += 1) {
      const value = values[trace];
      if (!Number.isFinite(value)) continue;
      coverage += 1;
      if (Number.isFinite(group[trace])) {
        const difference = value - group[trace];
        deviationsGroup.push(difference);
        groupCompared += 1;
        if (Math.abs(difference) <= tolerance) withinGroup += 1;
      }
      if (published !== null && Number.isFinite(published[trace])) {
        const difference = value - published[trace];
        deviationsPublished.push(difference);
        publishedCompared += 1;
        if (Math.abs(difference) <= tolerance) withinPublished += 1;
      }
    }

    results.push({
      user,
      coverage,
      coverageFraction: consensus.nTraces ? coverage / consensus.nTraces : 0,
      biasVsGroup: median(deviationsGroup),
      medianAbsVsGroup: median(deviationsGroup.map(Math.abs)),
      nmadVsGroup: nmad(deviationsGroup),
      withinGroup: groupCompared ? withinGroup / groupCompared : NaN,
      biasVsPublished: median(deviationsPublished),
      medianAbsVsPublished: median(deviationsPublished.map(Math.abs)),
      nmadVsPublished: nmad(deviationsPublished),
      withinPublished: publishedCompared ? withinPublished / publishedCompared : NaN,
    });
  }

  return { users, results, tolerance };
}

/**
 * Along-track slope of a per-trace series: a central difference over roughly
 * +/- `half` traces, skipping gaps. `distance` is the along-track coordinate
 * (metres); when it is absent, positions are trace indices and the slope is
 * thickness change per trace.
 */
export function alongTrackSlope(values, distance = null, half = 10) {
  const n = values.length;
  const slope = new Float64Array(n).fill(NaN);
  const finite = (index) => index >= 0 && index < n && Number.isFinite(values[index]);
  for (let trace = 0; trace < n; trace += 1) {
    if (!Number.isFinite(values[trace])) continue;
    let before = trace - half;
    while (before > 0 && !finite(before)) before -= 1;
    let after = trace + half;
    while (after < n - 1 && !finite(after)) after += 1;
    if (!finite(before) || !finite(after) || before === after) continue;
    const span = distance ? distance[after] - distance[before] : after - before;
    if (!(span > 0)) continue;
    slope[trace] = (values[after] - values[before]) / span;
  }
  return slope;
}

/** Spearman rank correlation, NaN pairs dropped. */
export function spearman(xs, ys) {
  const x = [];
  const y = [];
  for (let i = 0; i < xs.length; i += 1) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) {
      x.push(xs[i]);
      y.push(ys[i]);
    }
  }
  if (x.length < 3) return NaN;
  const rank = (values) => {
    const order = values.map((value, index) => [value, index]).sort((a, b) => a[0] - b[0]);
    const ranks = new Float64Array(values.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
      const average = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) ranks[order[k][1]] = average;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(x);
  const ry = rank(y);
  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  const mx = mean([...rx]);
  const my = mean([...ry]);
  let numerator = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i += 1) {
    numerator += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? numerator / Math.sqrt(dx * dy) : NaN;
}

/**
 * Relate the along-track slope angle to the contributor spread.
 *
 * The slope is expressed as an angle in degrees (thickness change over
 * travelled distance), and the spread is divided by the radargram's own median
 * spread before pooling, so the relation is not dominated by radargrams that
 * happen to be more uncertain overall (a Simpson's-paradox artefact of mixing
 * scales). The result's y values are therefore "spread relative to the
 * radargram typical".
 *
 * Positions are grouped into equal-width bins along the angle; each bin
 * carries the median spread and the 25-75% range, and the first and last bin
 * are anchored to the data's angle range so the trend spans it.
 *
 * @param {Array<{slope: Float64Array, spread: Float64Array}>} entries
 * @param {number} binCount
 */
export function summariseSlopeSpread(entries, binCount = 8) {
  const x = [];
  const y = [];
  for (const entry of entries) {
    const finiteSpread = [];
    for (const value of entry.spread) if (Number.isFinite(value)) finiteSpread.push(value);
    const scale = median(finiteSpread);
    if (!(scale > 0)) continue;
    for (let trace = 0; trace < entry.slope.length; trace += 1) {
      const slope = entry.slope[trace];
      if (Number.isFinite(slope) && Number.isFinite(entry.spread[trace])) {
        x.push((Math.atan(Math.abs(slope)) * 180) / Math.PI);
        y.push(entry.spread[trace] / scale);
      }
    }
  }
  const result = { n: x.length, bins: [], spearman: spearman(x, y) };
  if (x.length === 0) return result;

  let minAngle = Infinity;
  let maxAngle = -Infinity;
  for (const value of x) {
    if (value < minAngle) minAngle = value;
    if (value > maxAngle) maxAngle = value;
  }
  const width = maxAngle > minAngle ? (maxAngle - minAngle) / binCount : 0;
  const buckets = Array.from({ length: binCount }, () => ({ y: [] }));
  for (let i = 0; i < x.length; i += 1) {
    const index = width > 0 ? Math.min(binCount - 1, Math.floor((x[i] - minAngle) / width)) : 0;
    buckets[index].y.push(y[i]);
  }
  for (let index = 0; index < binCount; index += 1) {
    const values = buckets[index].y;
    if (values.length === 0) continue;
    values.sort((a, b) => a - b);
    const lo = minAngle + index * width;
    const hi = index === binCount - 1 ? maxAngle : minAngle + (index + 1) * width;
    result.bins.push({
      lo,
      hi,
      mid: (lo + hi) / 2,
      medianSpread: orderStatistic(values, 0.5),
      q25Spread: orderStatistic(values, 0.25),
      q75Spread: orderStatistic(values, 0.75),
      count: values.length,
    });
  }
  // Anchor the ends to the real angle range so the trend spans the data.
  result.bins[0].mid = minAngle;
  result.bins.at(-1).mid = maxAngle;
  result.minAngle = minAngle;
  result.maxAngle = maxAngle;
  const first = result.bins[0];
  const last = result.bins.at(-1);
  result.flattestMedian = first.medianSpread;
  result.steepestMedian = last.medianSpread;
  result.flattestQ25 = first.q25Spread;
  result.steepestQ25 = last.q25Spread;
  result.flattestQ75 = first.q75Spread;
  result.steepestQ75 = last.q75Spread;
  return result;
}

/** Order statistic at floor(q * (n - 1)) of an already-sorted array. */
function orderStatistic(sorted, q) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.floor(q * (sorted.length - 1))];
}

/**
 * Bootstrap the published-subset experiment: how close does a random subgroup
 * of k contributors get to the published consensus, and how does that improve
 * as k grows?
 *
 * @param {Array<{consensus: object, reference: object|null}>} radargrams
 */
export function bootstrapConvergence(radargrams, options = {}) {
  const replicates = options.replicates ?? 20;
  const maxTraces = options.maxTraces ?? 800;
  const tolerance = options.tolerance ?? 2.0;
  const rng = options.random ?? Math.random;
  const accessor = metricAccessors(options.metric);
  const sizes = [...new Set(radargrams.map((r) => (r.consensus.byTrace.size ? countUsers(r.consensus, accessor.userMap) : 0)))]
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  if (sizes.length === 0) return { sizes: [], curve: [] };
  const maxSize = Math.max(...sizes);
  const kList = [];
  for (let k = 2; k <= maxSize; k += 1) kList.push(k);

  const accumulators = new Map();
  for (const k of kList) accumulators.set(k, { errors: [], within: [], total: 0 });

  for (const { consensus, reference } of radargrams) {
    const published = reference?.[accessor.referenceKey] ?? null;
    if (!published) continue;
    const users = [...new Set([...consensus.byTrace.values()].flatMap((e) => [...e[accessor.userMap].keys()]))];
    if (users.length < 2) continue;
    const traces = sampleTraces(consensus, maxTraces, rng);
    if (traces.length === 0) continue;

    for (const k of kList) {
      if (k > users.length) continue;
      const bucket = accumulators.get(k);
      for (let replicate = 0; replicate < replicates; replicate += 1) {
        const subset = shuffle(users, rng).slice(0, k);
        for (const trace of traces) {
          const expected = published[trace];
          if (expected === null || expected === undefined || !Number.isFinite(expected)) continue;
          const entry = consensus.byTrace.get(trace);
          if (entry === undefined) continue;
          const values = [];
          for (const user of subset) {
            const value = entry[accessor.userMap].get(user);
            if (Number.isFinite(value)) values.push(value);
          }
          if (values.length === 0) continue;
          const estimate = quantileLower(values);
          const error = Math.abs(estimate - expected);
          bucket.errors.push(error);
          bucket.within.push(error <= tolerance ? 1 : 0);
          bucket.total += 1;
        }
      }
    }
  }

  const curve = kList.map((k) => {
    const bucket = accumulators.get(k);
    return {
      k,
      medianAbs: median(bucket.errors),
      p90Abs: percentile(bucket.errors, 0.9),
      within: bucket.within.length ? bucket.within.reduce((a, b) => a + b, 0) / bucket.within.length : NaN,
      samples: bucket.errors.length,
    };
  });
  return { sizes: kList, curve, replicates, tolerance };
}

function countUsers(consensus, userMap) {
  const users = new Set();
  for (const entry of consensus.byTrace.values()) for (const user of entry[userMap].keys()) users.add(user);
  return users.size;
}

function sampleTraces(consensus, maxTraces, rng) {
  const all = [...consensus.byTrace.keys()];
  if (all.length <= maxTraces) return all;
  return shuffle(all, rng).slice(0, maxTraces);
}

function shuffle(array, rng) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
