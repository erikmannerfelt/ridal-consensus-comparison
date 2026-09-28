# Ridal consensus comparison

A static website for asking **“how well does a group of radar interpreters agree,
and how close are they to the published consensus?”**

Upload the products a [ridal](https://github.com/erikmannerfelt/ridal) server
can already download for a group, and the page computes, for **ice thickness**
and **CTS depth** in parallel (two tabs, thickness first, every statistic
mirrored):

- **Group vs published** — median difference, bias, RMS and the share of
  positions within tolerance, per radargram and pooled, with the headline
  “your group is within *x* m of the published consensus”. The CTS tab only
  uses positions where contributors actually picked a CTS, so the “no
  temperate ice” value never enters the comparison.
- **Per-contributor statistics** (hidden behind a disclosure by default) —
  coverage, and each contributor's deviation from the group's own consensus
  and from published.
- **Steepness vs disagreement** — the consensus' along-track slope as an
  angle in degrees against the contributor spread at the same position, shown
  as a binned median with its 25–75% range (hover for the position count).
  Spread is normalised within each radargram, and radargrams without
  `distance_m` are left out.
- **Convergence** — a bootstrap curve showing how close a random subgroup of
  *k* contributors gets to the published consensus, i.e. how many interpreters
  are enough.

It is entirely client-side: no server, no data leaves the browser, and it
deploys to GitHub Pages as-is.

## Quick start

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Then either drop a ridal download onto the page, or press one of the
**simulated group** buttons (3 / 6 / most contributors) to see the whole
workflow immediately. `file://` will not work because the page fetches the
reference data; use a local server or GitHub Pages.

## Where the uploads come from

The page accepts the **picked layer points** download a ridal server offers for
a group or the whole catalog:

| Product | ridal route |
|---|---|
| **Picked layer points** | `/api/v1/{catalog,groups/<id>}/level2?format=csv&every_user=true` |

CSV and GeoJSON both work, and either can be dropped individually or inside a
zip. Each row carries `user`, `layer`, `trace`, `depth_m` and `distance_m`
(`distance_m` is needed for the steepness panel). If a zip also contains the
derived product, it is ignored with a note.

**Only the legacy layer ids are supported**, because only they are comparable
to the published consensus: `bed`, `bed_no_temperate`, `temperate_ice` and
`bed_not_visible`. Newer ids such as `cts` or `maybe_bed` answer different
questions and are rejected (with a warning) rather than guessed at. The
derived-layer-points product is not used at all: it is less capable and its
item ids need not match the study’s, so the consensus is always recomputed from
picked points.

Raw `gprinterp` picks are not accepted in the browser (the reference builder
uses them internally) — export picked points instead.

## How the comparison works

The published reference is the same crowd-consensus algorithm as the
Mannerfelt et al. (2026) study. The published interpretations are accessed from
[doi.org/10.5281/zenodo.17882299](https://doi.org/10.5281/zenodo.17882299).
The algorithm:

1. Reduce each contributor’s picks to one value per `(user, layer, trace)` with
   the **shallowest** pick.
2. Pool the bed layers (`bed`, `bed_no_temperate`); the consensus value is
   `quantile(0.49, interpolation="lower")` — the order statistic at
   `floor(0.49·(n−1))`, **not** the median.
3. Drop a position only where more contributors say the bed is not visible
   than say it is; a tie is kept.

`tools/consensus.py` implements this and is validated against the study’s own
`expected_consensus.csv` oracle (median error 0 on ice thickness). The browser
engine in `app/consensus.js` is a port of it and is cross-checked against the
Python output in the tests. The reference for all 138 radargrams is
precomputed into `data/reference/` and fetched per radargram, so only what an
upload covers is downloaded.

Depth in the reference is converted from each pick’s own TWTT anchor with a
constant `0.168 m/ns` (ridal’s default, matching the processed radargrams in
this workspace), so no NetCDF files are needed.

## Simulated groups

`data/demo/group-{small,medium,large}.zip` are deterministic subsets of the
published contributors over the **three radargrams that have a processed file
in `radargrams/`** (`bergmesterbreen-…-0033`, `elfenbeinbreen-…-0435`,
`ragna_mariebreen-…-0404`), shaped exactly like the ridal downloads. The
along-track distance in the CSVs is read from those `.nc` files. They are the
“split the published consensus into a simulated new group” experiment, and
their expected numbers when built were:

| group | contributors/radargram | median \|diff\| | within 2 m |
|---|---|---|---|
| small | 3 | 0.38 m | 92.3% |
| medium | 6 | 0.15 m | 99.5% |
| large | up to all-but-two | 0.00 m | 100.0% |

Re-run `tools/make_demo.py` after adding a `.nc` file to `radargrams/` to bring
that radargram into the demos.

## Repository layout

```
index.html, assets/        the site (Plotly, JSZip, PapaParse vendored)
app/                       consensus engine, format readers, statistics, UI
data/reference/            precomputed published consensus, one JSON per radargram
data/demo/                 simulated group uploads
tools/build_reference.py   pick zip -> data/reference
tools/make_demo.py         pick zip -> data/demo
tools/consensus.py         shared consensus engine (validated)
tools/export_fixture.py    reduced-pick fixture for the JS cross-check
tests/                     Python oracle test + Node cross-checks
```

## Rebuilding the data

```bash
# Published reference from the interpretation archive (about 2 minutes).
python3 tools/build_reference.py --zip interpretations_gprinterp.zip --out data/reference

# Simulated group uploads.
python3 tools/make_demo.py --zip interpretations_gprinterp.zip --reference data/reference --out data/demo

# Reduced-pick fixture for the JS tests.
python3 tools/export_fixture.py --zip interpretations_gprinterp.zip
```

`interpretations_gprinterp.zip` is the archive this prototype was built from;
`radargrams/` is git-ignored (large, and the site does not display radargrams).

## Tests

```bash
python3 tests/test_consensus.py   # against the study's oracle fixture
npm test                          # JS consensus cross-check + analysis pipeline
```

## Deploying to GitHub Pages

The site is static. Commit `index.html`, `app/`, `assets/`, `data/reference/`
and `data/demo/`, push to a GitHub repository, then enable **Pages → Deploy
from branch → main / root**. Relative paths mean it works under
`https://<user>.github.io/<repo>/` unchanged.

## Caveats

- Picked points at ridal’s default `auto` spacing are resampled; the closest
  match to the published per-trace consensus is
  `?spacing=per-trace`.
- The comparison quantity is ice thickness (`thickness_m`). The study’s
  `temperate` column is a rule-based quantity and is deliberately not compared.
- `0.168 m/ns` is assumed for the reference depth axis; radargrams processed
  with another velocity should be rebuilt with `--velocity`.
- Statistics are computed in the browser; a very large upload (tens of
  thousands of traces across all users) takes a moment and holds the rows in
  memory.
