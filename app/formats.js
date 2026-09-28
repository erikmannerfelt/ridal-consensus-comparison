// Reading ridal's merged "picked layer points" export: long format, one row
// per user/layer/trace, as CSV or GeoJSON, optionally inside a zip.
//
// Only the legacy layer ids are supported, because only they are comparable to
// the published consensus and ridal's derived layers: `bed`, `bed_no_temperate`,
// `temperate_ice` and `bed_not_visible`. Newer ids such as `cts` or
// `maybe_bed` answer different questions and would silently shift the
// consensus, so they are rejected with an explanation rather than guessed at.
//
// The "derived layer points" product is intentionally not supported: it is
// less capable (no per-contributor statistics) and its item ids need not match
// the study's, so the site recomputes the consensus from picked points instead.

import { KNOWN_LAYERS } from "./constants.js";

/** Message shown when a derived-layer-points product is offered. */
const DERIVED_HINT =
  'Derived layer points are not used here; download and upload "picked layer points" ' +
  "(layer + depth_m + user) instead.";

function headerSet(fields) {
  return new Set(fields.map((field) => String(field)));
}

/** Classify a parsed table: only the picked-points shape is accepted. */
export function detectKind(fields) {
  const set = headerSet(fields);
  const hasPicked = set.has("layer") && set.has("depth_m") && set.has("user");
  return hasPicked ? "picked" : "unknown";
}

function number(value) {
  if (value === "" || value === null || value === undefined) return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** Does this column list look like a derived-layer-points product? */
function looksDerived(fields) {
  return fields.some((key) => /^thickness(_m|_ns|_samples)?$/.test(key) || /cts(_m|_ns|_samples)?$/.test(key));
}

/**
 * Turn records (objects keyed by column name) into normalised picked rows.
 * Returns { kind, rows, warnings, notes }.
 */
export function rowsFromRecords(records) {
  if (records.length === 0) {
    return { kind: "unknown", rows: [], warnings: ["The file has no rows."], notes: [] };
  }
  const fields = Object.keys(records[0]);
  if (detectKind(fields) !== "picked") {
    return {
      kind: looksDerived(fields) ? "derived" : "unknown",
      rows: [],
      warnings: [
        looksDerived(fields)
          ? DERIVED_HINT
          : 'Could not recognise this file. Expected a merged "picked layer points" ' +
            "download (layer + depth_m + user).",
      ],
      notes: [],
    };
  }

  const rows = [];
  const unsupportedLayers = new Map();
  let missingDepth = 0;
  for (const record of records) {
    const depth = number(record.depth_m);
    const trace = number(record.trace);
    if (!Number.isFinite(depth) || !Number.isFinite(trace)) {
      missingDepth += 1;
      continue;
    }
    const layer = String(record.layer ?? "");
    if (!KNOWN_LAYERS.has(layer)) {
      unsupportedLayers.set(layer, (unsupportedLayers.get(layer) ?? 0) + 1);
      continue;
    }
    rows.push({
      radargram_id: String(record.radargram_id ?? ""),
      user: String(record.user ?? ""),
      layer,
      trace,
      depth_m: depth,
      distance_m: number(record.distance_m),
    });
  }

  const warnings = [];
  if (unsupportedLayers.size > 0) {
    const names = [...unsupportedLayers.keys()].map((name) => (name ? `'${name}'` : "(empty)")).join(", ");
    const total = [...unsupportedLayers.values()].reduce((a, b) => a + b, 0);
    warnings.push(
      `${total} rows used unsupported layer id(s) ${names} and were skipped. Only the legacy ids ` +
        "bed, bed_no_temperate, temperate_ice and bed_not_visible are comparable to the published " +
        "consensus (e.g. 'cts' and 'maybe_bed' are not).",
    );
  }
  if (missingDepth) warnings.push(`${missingDepth} rows had no usable trace/depth and were skipped.`);
  return { kind: "picked", rows, warnings, notes: [] };
}

/** Parse one CSV or GeoJSON text blob into normalised picked rows. */
export function parseText(text, name = "") {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let document;
    try {
      document = JSON.parse(trimmed);
    } catch (error) {
      return { kind: "unknown", rows: [], warnings: [`${name}: invalid JSON (${error.message}).`], notes: [] };
    }
    return parseGeoJson(document, name);
  }
  if (typeof Papa === "undefined") {
    return { kind: "unknown", rows: [], warnings: ["CSV parser not loaded."], notes: [] };
  }
  const result = Papa.parse(trimmed, { header: true, dynamicTyping: true, skipEmptyLines: true });
  const parsed = rowsFromRecords(result.data);
  if (result.errors?.length) {
    parsed.warnings.push(`${name}: ${result.errors.length} CSV parse warning(s).`);
  }
  parsed.notes = parsed.notes ?? [];
  return parsed;
}

/** Parse a GeoJSON FeatureCollection (picked points only). */
export function parseGeoJson(document, name = "") {
  // Raw gprinterp picks carry a `label` and a geometry rather than the
  // level-2 columns; point the admin at the export this tool consumes.
  if (document?.schema === "gprinterp") {
    return {
      kind: "unknown",
      rows: [],
      warnings: [
        `${name}: this looks like raw gprinterp picks. Export "picked layer points" from ridal instead.`,
      ],
      notes: [],
    };
  }
  // A derived export names its items in a top-level `ridal` block; recognise
  // it only to explain why it is not used.
  const derivedItems = (document?.ridal?.sources ?? []).flatMap((source) => source.items ?? []);
  if (derivedItems.length > 0) {
    return { kind: "derived", rows: [], warnings: [DERIVED_HINT], notes: [] };
  }
  const features = Array.isArray(document) ? document : document?.features;
  if (!Array.isArray(features)) {
    return { kind: "unknown", rows: [], warnings: [`${name}: not a GeoJSON FeatureCollection.`], notes: [] };
  }
  const records = features.map((feature) => feature.properties ?? {});
  return rowsFromRecords(records);
}

/** Read a File/Blob as text. */
function readAsText(file) {
  return file.text();
}

function readAsArrayBuffer(file) {
  return file.arrayBuffer();
}

/**
 * Ingest a list of uploaded files (CSV/GeoJSON, or zips containing them).
 * Only picked layer points are used; derived products are ignored with a note.
 * Returns { kind, rows, sources, warnings, notes }.
 */
export async function ingestFiles(fileList, onProgress = () => {}) {
  const files = [...fileList];
  const collected = [];
  const sources = [];
  const readWarnings = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    onProgress({ file: file.name, index, total: files.length });
    const lower = file.name.toLowerCase();

    if (lower.endsWith(".zip")) {
      if (typeof JSZip === "undefined") {
        readWarnings.push("Zip support not loaded; cannot read " + file.name);
        continue;
      }
      const archive = await JSZip.loadAsync(await readAsArrayBuffer(file));
      const entries = Object.values(archive.files).filter(
        (entry) => !entry.dir && /\.(csv|geojson|json)$/i.test(entry.name),
      );
      for (const entry of entries) {
        const text = await entry.async("string");
        collected.push(parseText(text, `${file.name}:${entry.name}`));
        sources.push(`${file.name}:${entry.name}`);
      }
      continue;
    }

    const text = await readAsText(file);
    collected.push(parseText(text, file.name));
    sources.push(file.name);
  }

  const picked = collected.filter((result) => result.kind === "picked");
  const derived = collected.filter((result) => result.kind === "derived");
  const others = collected.filter((result) => result.kind !== "picked" && result.kind !== "derived");

  if (picked.length === 0) {
    const warnings = [...readWarnings, ...others.flatMap((result) => result.warnings)];
    if (derived.length > 0) warnings.push(DERIVED_HINT);
    if (warnings.length === 0) {
      warnings.push('Could not recognise the upload. Expected a "picked layer points" download.');
    }
    return { kind: "unknown", rows: [], sources, warnings, notes: [] };
  }

  // concat, not push(...rows): a large merge exceeds the argument limit.
  const rows = picked.reduce((all, result) => all.concat(result.rows), []);
  const warnings = [
    ...readWarnings,
    ...picked.flatMap((result) => result.warnings),
    ...others.flatMap((result) => result.warnings),
  ];
  const notes = picked.flatMap((result) => result.notes ?? []);
  if (derived.length > 0) {
    notes.unshift("The upload also contained a derived product, which is not used; only picked layer points were read.");
  }
  return { kind: "picked", rows, sources, warnings, notes };
}
