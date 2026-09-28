// Orchestration: turn an ingested upload into a full statistical result,
// fetching the precomputed published reference per radargram as needed.
//
// Every statistic is computed twice, for ice thickness and for CTS depth, so
// the page can switch between the two mirrored views. The CTS numbers only
// ever use positions where contributors actually picked a CTS, because the
// "no temperate ice" value would otherwise dominate.

import { consensusFromReduced, metricAccessors, reducePicks } from "./consensus.js";
import {
  alongTrackSlope,
  bootstrapConvergence,
  compareToReference,
  perUserStats,
  poolComparisons,
  summariseSlopeSpread,
} from "./stats.js";

const CACHE = new Map();
const METRIC_KEYS = ["thickness", "cts"];

async function loadJson(url, fetchImpl) {
  if (CACHE.has(url)) return CACHE.get(url);
  const promise = fetchImpl(url).then((response) => {
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  });
  CACHE.set(url, promise);
  return promise;
}

/**
 * Load the published-reference index and expose a cached per-radargram loader.
 *
 * @param {string} baseUrl directory holding index.json and <key>.json
 * @param {Function} fetchImpl injected for tests; defaults to window.fetch
 */
export async function createReference(baseUrl, fetchImpl = fetch) {
  let index = null;
  try {
    index = await loadJson(`${baseUrl}/index.json`, fetchImpl);
  } catch (error) {
    return { available: false, error: error.message, index: null, has: () => false, get: async () => null };
  }
  const lookup = new Map(Object.keys(index.radargrams).map((key) => [key.toLowerCase(), key]));
  return {
    available: true,
    error: null,
    index,
    // Reference keys keep the pick archive's directory case; uploads use
    // ridal's lower-case radargram ids, so match case-insensitively.
    has: (key) => lookup.has(String(key).toLowerCase()),
    async get(key) {
      const original = lookup.get(String(key).toLowerCase());
      if (original === undefined) return null;
      return loadJson(`${baseUrl}/${original}.json`, fetchImpl);
    },
  };
}

function groupByRadargram(rows) {
  const groups = new Map();
  let missingId = 0;
  for (const row of rows) {
    const key = String(row.radargram_id ?? "").trim().toLowerCase();
    if (!key) {
      missingId += 1;
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return { groups, missingId };
}

/** Along-track distance per trace, or null when the upload carries none. */
function distanceByTrace(rows, nTraces) {
  const distance = new Float64Array(nTraces).fill(NaN);
  let any = false;
  for (const row of rows) {
    const trace = Math.round(Number(row.trace));
    const value = Number(row.distance_m);
    if (!Number.isFinite(trace) || trace < 0 || trace >= nTraces || !Number.isFinite(value)) continue;
    distance[trace] = value;
    any = true;
  }
  return any ? distance : null;
}

function maxTrace(rows) {
  let max = -1;
  for (const row of rows) {
    const trace = Math.round(Number(row.trace));
    if (Number.isFinite(trace) && trace > max) max = trace;
  }
  return max;
}

function countFinite(array) {
  let count = 0;
  for (const value of array) if (Number.isFinite(value)) count += 1;
  return count;
}

/**
 * Analyse an ingested upload.
 *
 * @param {{kind: string, rows: Array, sources: Array, warnings: Array, notes: Array}} upload
 * @param {object} options { reference, tolerance, bootstrap, replicates, maxTraces }
 */
export async function analyze(upload, options = {}) {
  const tolerance = options.tolerance ?? 2.0;
  const reference = options.reference ?? { available: false, has: () => false, get: async () => null };
  const { groups, missingId } = groupByRadargram(upload.rows);
  const keys = [...groups.keys()].sort();

  const warnings = [...(upload.warnings ?? [])];
  const notes = [...(upload.notes ?? [])];
  if (missingId) warnings.push(`${missingId} rows had no radargram_id and were skipped.`);

  const accumulators = Object.fromEntries(
    METRIC_KEYS.map((metric) => [metric, { comparisons: [], bootstrapInputs: [], slopeEntries: [] }]),
  );
  const metrics = Object.fromEntries(
    METRIC_KEYS.map((metric) => {
      const accessor = metricAccessors(metric);
      return [metric, { key: metric, label: accessor.label, unit: accessor.unit, radargrams: [], aggregate: null, bootstrap: null, slopeSpread: null }];
    }),
  );
  const slopeWithoutDistance = new Set();
  const allUsers = new Set();
  const allLayers = new Set();
  let picks = 0;

  for (const key of keys) {
    const rows = groups.get(key);
    picks += rows.length;
    const published = await reference.get(key);
    const nTraces = published?.n_traces ?? maxTrace(rows) + 1;

    const reduced = reducePicks(rows);
    const consensus = consensusFromReduced(reduced.rows, nTraces);
    for (const user of reduced.users) allUsers.add(user);
    for (const layer of reduced.layers) allLayers.add(layer);
    const distance = distanceByTrace(rows, nTraces);
    if (!distance) slopeWithoutDistance.add(key);

    for (const metric of METRIC_KEYS) {
      const accessor = metricAccessors(metric);
      const group = consensus[accessor.series];
      const comparison = published ? compareToReference(group, published[accessor.referenceKey]) : null;
      const usable = comparison && comparison.compared > 0 ? comparison : null;
      metrics[metric].radargrams.push({
        key,
        nTraces,
        users: reduced.users,
        nPicks: rows.length,
        nTracesWithData: countFinite(group),
        comparison: usable,
        perUser: perUserStats(consensus, published, { tolerance, metric }),
        publishedAvailable: Boolean(published),
      });
      if (usable) accumulators[metric].comparisons.push(usable);
      if (published) accumulators[metric].bootstrapInputs.push({ consensus, reference: published });
      if (distance) {
        accumulators[metric].slopeEntries.push({
          slope: alongTrackSlope(group, distance, 10),
          spread: consensus[accessor.nmadField],
        });
      }
    }
  }

  for (const metric of METRIC_KEYS) {
    const accumulator = accumulators[metric];
    metrics[metric].aggregate = accumulator.comparisons.length ? poolComparisons(accumulator.comparisons) : null;
    if (options.bootstrap !== false && accumulator.bootstrapInputs.length > 0) {
      metrics[metric].bootstrap = bootstrapConvergence(accumulator.bootstrapInputs, {
        tolerance,
        metric,
        replicates: options.replicates ?? 20,
        maxTraces: options.maxTraces ?? 600,
      });
    }
    if (accumulator.slopeEntries.length > 0) {
      metrics[metric].slopeSpread = { ...summariseSlopeSpread(accumulator.slopeEntries), unit: "degrees" };
    }
  }

  const withoutReference = metrics.thickness.radargrams.filter((radargram) => !radargram.publishedAvailable).map((radargram) => radargram.key);
  if (withoutReference.length) {
    warnings.push(
      `${withoutReference.length} radargram(s) have no published reference and are shown without a comparison: ` +
        withoutReference.join(", "),
    );
  }
  if (slopeWithoutDistance.size > 0) {
    warnings.push(
      `Steepness needs along-track distance; ${slopeWithoutDistance.size} radargram(s) carry no ` +
        `distance_m and were left out: ${[...slopeWithoutDistance].join(", ")}`,
    );
  }

  return {
    kind: upload.kind,
    sources: upload.sources,
    warnings,
    notes,
    metrics,
    validation: {
      radargrams: keys.length,
      radargramsWithReference: keys.length - withoutReference.length,
      users: [...allUsers].sort(),
      layers: [...allLayers].sort(),
      picks,
      tolerance,
      referenceAvailable: reference.available,
    },
  };
}
