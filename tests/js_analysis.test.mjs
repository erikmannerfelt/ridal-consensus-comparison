// End-to-end check of the analysis pipeline in Node, using the committed
// reduced-pick fixture and the real on-disk published reference.
//
//   node tests/js_analysis.test.mjs

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { analyze, createReference } from "../app/analysis.js";
import { detectKind, parseText, rowsFromRecords } from "../app/formats.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.error(`  FAIL ${name} ${detail}`);
    failures += 1;
  }
}

// fetch shim: map data/reference/*.json to files under the repository root.
const fetchImpl = async (url) => {
  const text = await readFile(resolve(root, url), "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(text) };
};

const fixture = JSON.parse(readFileSync(resolve(root, "tests/fixtures/js_crosscheck.json"), "utf8"));
const pickedRows = fixture.rows.map(([userIndex, layer, trace, depth]) => ({
  radargram_id: fixture.key,
  user: fixture.users[userIndex],
  layer,
  trace,
  depth_m: depth,
}));

const reference = await createReference("data/reference", fetchImpl);
check("reference index loads", reference.available, reference.error ?? "");

const upload = { kind: "picked", rows: pickedRows, sources: ["fixture"], warnings: [] };
const result = await analyze(upload, { reference, tolerance: 2, bootstrap: true, replicates: 4, maxTraces: 250 });
const thickness = result.metrics.thickness;
const cts = result.metrics.cts;

check("fixture radargram has a reference", thickness.radargrams[0].publishedAvailable);
check("comparison covers many positions", thickness.aggregate.compared > 100, `${thickness.aggregate.compared}`);
check(
  "fixture consensus matches published",
  thickness.aggregate.withinAbs[2] > 0.98,
  `within-2m=${thickness.aggregate.withinAbs[2]}`,
);
check("per-user stats produced", thickness.radargrams[0].perUser.results.length === fixture.users.length);
check("bootstrap curve produced", thickness.bootstrap.curve.length > 1);
check(
  "steepness is skipped without along-track distance",
  thickness.slopeSpread === null && result.warnings.some((warning) => warning.includes("distance")),
  JSON.stringify({ slopeSpread: thickness.slopeSpread, warnings: result.warnings }),
);
check(
  "bootstrap error falls towards the full group",
  thickness.bootstrap.curve.at(-1).medianAbs <= thickness.bootstrap.curve[0].medianAbs + 1e-9,
);
check("validation reports contributors", result.validation.users.length === fixture.users.length);

// CTS is the mirrored metric: only positions with real CTS picks are compared.
check("CTS comparison exists", cts.aggregate !== null && cts.aggregate.compared > 0, JSON.stringify(cts.aggregate?.compared));
check("CTS compares fewer positions than thickness", cts.aggregate.compared <= thickness.aggregate.compared);
check(
  "CTS per-user stats produced",
  cts.radargrams[0].perUser.results.length > 0 && cts.radargrams[0].perUser.results.length <= fixture.users.length,
);

// Format classification: only picked points are accepted.
check("picked columns detected", detectKind(["user", "layer", "depth_m", "trace"]) === "picked");
check("derived columns are not accepted", detectKind(["user", "trace", "thickness_m"]) === "unknown");
const parsed = rowsFromRecords([{ radargram_id: "x", user: "a", layer: "bed", trace: "3", depth_m: "12.5" }]);
check("picked record normalised", parsed.kind === "picked" && parsed.rows[0].trace === 3 && parsed.rows[0].depth_m === 12.5);

// Only the legacy layer ids are comparable; new ids are rejected, not guessed.
const unsupported = rowsFromRecords([
  { radargram_id: "x", user: "a", layer: "cts", trace: 1, depth_m: 2 },
  { radargram_id: "x", user: "a", layer: "maybe_bed", trace: 2, depth_m: 3 },
  { radargram_id: "x", user: "a", layer: "bed", trace: 3, depth_m: 4 },
]);
check(
  "new layer ids are rejected with the legacy-only note",
  unsupported.rows.length === 1 && unsupported.warnings.some((warning) => warning.includes("legacy ids")),
  JSON.stringify(unsupported),
);

// A derived GeoJSON is recognised only to explain why it is unused.
const derivedGeoJson = {
  type: "FeatureCollection",
  ridal: { product_level: 2, sources: [{ items: [{ id: "any_bed", properties: ["any_bed_m"] }] }] },
  features: [{ type: "Feature", properties: { radargram_id: "x", trace: 1, any_bed_m: 40 } }],
};
const customDerived = parseText(JSON.stringify(derivedGeoJson), "derived.geojson");
check(
  "derived GeoJSON is refused with guidance",
  customDerived.kind === "derived" && customDerived.rows.length === 0 &&
    customDerived.warnings[0].includes("picked layer points"),
  JSON.stringify(customDerived),
);

// A picked GeoJSON also carries a `ridal` block, but without items: it must
// still be read as picked, not mistaken for a derived product.
const pickedGeoJson = {
  type: "FeatureCollection",
  ridal: { product_level: 2, sources: [{ radargram_id: "x", spacing_m: 1 }] },
  features: [
    { type: "Feature", properties: { radargram_id: "x", layer: "bed", user: "erik", trace: 1, depth_m: 30, distance_m: 5 } },
  ],
};
const pickedFromGeoJson = parseText(JSON.stringify(pickedGeoJson), "picked.geojson");
check(
  "picked GeoJSON with a ridal block stays picked",
  pickedFromGeoJson.kind === "picked" && pickedFromGeoJson.rows[0].distance_m === 5,
  JSON.stringify(pickedFromGeoJson),
);

console.log(`\n  thickness within 2 m: ${(result.metrics.thickness.aggregate.withinAbs[2] * 100).toFixed(1)}%`);
console.log(`  thickness median |diff|: ${result.metrics.thickness.aggregate.medianAbs.toFixed(3)} m`);
console.log(`  CTS       within 2 m: ${(result.metrics.cts.aggregate.withinAbs[2] * 100).toFixed(1)}%`);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll JavaScript analysis checks passed.");
