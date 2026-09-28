// Shared constants for the consensus engine. Mirrors tools/consensus.py.

/** Layer ids that answer "where is the bed". */
export const BED_LAYERS = ["bed", "bed_no_temperate"];

/** Layer ids that answer "where is the cold-temperate transition". */
export const CTS_LAYERS = ["bed_no_temperate", "temperate_ice"];

/** The layer drawn to say "the bed is not visible here". */
export const MISSING_LAYER = "bed_not_visible";

/** Every layer id the published data uses.
 *
 * Only these legacy ids are comparable to the published consensus. Newer
 * layer ids such as `cts` or `maybe_bed` are intentionally NOT accepted: they
 * answer different questions, so accepting them would silently shift the
 * consensus. Keep this list and the note in README.md in step.
 */
export const KNOWN_LAYERS = new Set([
  ...BED_LAYERS,
  MISSING_LAYER,
  "temperate_ice",
]);

/** Consensus percentile. 0.49, not 0.50 (see tools/consensus.py). */
export const CONSENSUS_Q = 0.49;

/** Layer id -> human label. */
export const LAYER_LABELS = {
  bed: "Glacier bed",
  bed_no_temperate: "Glacier bed (no temperate ice above)",
  temperate_ice: "Temperate ice (CTS)",
  bed_not_visible: "Glacier bed not visible",
};

/** Default absolute tolerances (m) offered for "within tolerance" stats. */
export const ABS_TOLERANCES = [1, 2, 5];

/** Default relative tolerances (%) offered for "within tolerance" stats. */
export const REL_TOLERANCES = [5, 10, 25];
