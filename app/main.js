// Page controller: wire the upload, run the analysis, and render results.
// Every statistic is rendered from one of two mirrored metrics (ice thickness
// or CTS depth) selected by the tabs.

import { ingestFiles } from "./formats.js";
import { analyze, createReference } from "./analysis.js";
import * as charts from "./charts.js";
import { LAYER_LABELS } from "./constants.js";

const $ = (id) => document.getElementById(id);
const state = { reference: null, upload: null, result: null, tolerance: 2, metric: "thickness", view: 0, uirevision: "v0" };

// --- small formatting helpers ----------------------------------------------

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function fmt(value, digits = 2) {
  return isNumber(value) ? value.toFixed(digits) : "–";
}

function pct(value, digits = 1) {
  return isNumber(value) ? `${(value * 100).toFixed(digits)}%` : "–";
}

function shortKey(key) {
  return key.length > 34 ? `${key.slice(0, 31)}…` : key;
}

// Compact chart labels: "amenfonna-20240510-DAT_0044_A1_1" -> "amenfonna 0044".
function shortLabel(key) {
  const match = key.match(/^([a-z_]+)-\d+-dat_(\d+)/i);
  if (match) return `${match[1].replace(/_/g, " ")} ${match[2]}`;
  return shortKey(key);
}

function cell(text, className = "") {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function renderTable(table, headers, rows) {
  table.innerHTML = "";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const header of headers) {
    const th = document.createElement("th");
    th.textContent = header;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const entry of row) {
      if (entry instanceof HTMLElement) tr.appendChild(entry);
      else tr.appendChild(cell(String(entry)));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

// --- upload / run -----------------------------------------------------------

async function runFiles(files) {
  if (!files || files.length === 0) return;
  setStatus(`Reading ${files.length} file(s)…`);
  try {
    const upload = await ingestFiles(files, (progress) =>
      setStatus(`Reading ${progress.file} (${progress.index + 1}/${progress.total})…`),
    );
    if (upload.kind === "unknown" || upload.rows.length === 0) {
      setStatus(upload.warnings.join(" ") || "No usable rows found.", true);
      return;
    }
    state.upload = upload;
    await runAnalysis();
  } catch (error) {
    setStatus(`Could not read the upload: ${error.message}`, true);
  }
}

async function runAnalysis() {
  setStatus("Computing agreement…");
  try {
    const result = await analyze(state.upload, {
      reference: state.reference,
      tolerance: state.tolerance,
    });
    state.result = result;
    if (!result.metrics[state.metric]) state.metric = "thickness";
    // Reveal the results before drawing: a chart built inside a display:none
    // container keeps a degenerate size and its axes look wrongly zoomed.
    $("results").hidden = false;
    setStatus(null);
    render(result);
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error(error);
    setStatus(`Analysis failed: ${error.message}`, true);
  }
}

function setStatus(message, isError = false) {
  const element = $("status");
  if (message === null) {
    element.hidden = true;
    return;
  }
  element.hidden = false;
  element.className = isError ? "status error" : "status";
  element.textContent = message;
}

// --- rendering --------------------------------------------------------------

function render(result) {
  renderValidation(result);
  renderTabs(result);
  renderMetric(result);
}

function metricAvailable(metric) {
  return metric.aggregate !== null || metric.bootstrap !== null || metric.slopeSpread !== null ||
    metric.radargrams.some((radargram) => radargram.nTracesWithData > 0);
}

function renderTabs(result) {
  const tabs = $("metric-tabs");
  tabs.innerHTML = "";
  for (const key of ["thickness", "cts"]) {
    const metric = result.metrics[key];
    const button = document.createElement("button");
    button.className = `tab${key === state.metric ? " active" : ""}`;
    button.textContent = metric.label;
    button.disabled = !metricAvailable(metric);
    button.addEventListener("click", () => {
      state.metric = key;
      render(result);
    });
    tabs.appendChild(button);
  }
}

function renderMetric(result) {
  // A fresh token resets every chart's axes, so switching quantity never
  // leaves the new plot on the old one's ranges.
  state.view += 1;
  state.uirevision = `metric-${state.metric}-${state.view}`;
  renderHeadline(result.metrics[state.metric]);
  renderComparison(result.metrics[state.metric]);
  renderUsers(result.metrics[state.metric]);
  renderBootstrap(result.metrics[state.metric]);
  renderSlopeSpread(result.metrics[state.metric]);
  resizeCharts();
}

// Re-fit every visible chart once the browser has laid the panels out; a
// chart drawn while hidden would otherwise keep a zero/degenerate size.
function resizeCharts() {
  requestAnimationFrame(() => {
    for (const element of document.querySelectorAll(".chart")) charts.resize(element);
  });
}

function card(label, value, sub, primary = false) {
  const element = document.createElement("div");
  element.className = `card${primary ? " primary" : ""}`;
  element.innerHTML = `<div class="label"></div><div class="value"></div><div class="sub"></div>`;
  element.querySelector(".label").textContent = label;
  element.querySelector(".value").textContent = value;
  element.querySelector(".sub").textContent = sub ?? "";
  return element;
}

function renderValidation(result) {
  const validation = $("validation");
  validation.innerHTML = "";
  const items = [
    ["Product", "Picked layer points (per contributor)"],
    ["Radargrams", result.validation.radargrams],
    ["With published reference", result.validation.radargramsWithReference],
    ["Contributors", result.validation.users.length || "–"],
    ["Rows", result.validation.picks.toLocaleString()],
    ["Layers", result.validation.layers.length ? result.validation.layers.map((l) => LAYER_LABELS[l] ?? l).join(", ") : "–"],
    ["Tolerance", `${result.validation.tolerance} m`],
  ];
  for (const [label, value] of items) {
    const div = document.createElement("div");
    div.innerHTML = `<b>${label}:</b> `;
    div.appendChild(document.createTextNode(String(value)));
    validation.appendChild(div);
  }
  const notes = $("notes");
  notes.innerHTML = "";
  for (const note of result.notes ?? []) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = note;
    notes.appendChild(p);
  }
  const warnings = $("warnings");
  warnings.innerHTML = "";
  for (const warning of result.warnings ?? []) {
    const p = document.createElement("p");
    p.textContent = warning;
    warnings.appendChild(p);
  }
}

function renderHeadline(metric) {
  const headline = $("headline");
  headline.innerHTML = "";
  const comparison = metric.aggregate;
  if (!comparison || comparison.compared === 0) {
    headline.appendChild(card("Comparison", "–", `No published ${metric.label.toLowerCase()} positions for these radargrams.`));
    return;
  }
  headline.appendChild(
    card(
      "Match with published",
      pct(comparison.withinAbs[state.tolerance]),
      `${metric.label} within ${state.tolerance} m of the published consensus`,
      true,
    ),
  );
  headline.appendChild(card("Median difference", `${fmt(comparison.medianAbs)} m`, "median |group − published|"));
  headline.appendChild(card("Median bias", `${fmt(comparison.bias)} m`, "group − published; positive means the group picked deeper"));
  headline.appendChild(card("Positions compared", comparison.compared.toLocaleString(), "where both define a value"));
  headline.appendChild(card("90th percentile", `${fmt(comparison.p90Abs)} m`, "90% of positions differ by less than this"));
}

function renderComparison(metric) {
  const comparison = metric.aggregate;
  if (!comparison || comparison.compared === 0) {
    $("diff-hist").innerHTML = "";
    $("radargram-bars").innerHTML = "";
    renderTable($("radargram-table"), [], []);
    return;
  }
  charts.histogram($("diff-hist"), comparison.signedDifferences, {
    title: "Difference at each position (group − published)",
    xLabel: "difference (m)",
    yLabel: "positions",
    color: "#1f6f8b",
    uirevision: state.uirevision,
  });

  const rows = metric.radargrams
    .filter((radargram) => radargram.comparison)
    .sort((a, b) => (a.comparison.withinAbs[state.tolerance] ?? 0) - (b.comparison.withinAbs[state.tolerance] ?? 0));
  charts.bar(
    $("radargram-bars"),
    rows.map((radargram) => shortLabel(radargram.key)),
    rows.map((radargram) => (radargram.comparison.withinAbs[state.tolerance] ?? 0) * 100),
    { title: `Positions within ${state.tolerance} m, per radargram`, xLabel: "%", horizontal: true, highlight: 0, uirevision: state.uirevision },
  );

  const header = ["Radargram", "Contributors", "Traces with data", "Compared", "Median |diff| (m)", `Within ${state.tolerance} m`, "Bias (m)", "Coverage"];
  const tableRows = rows.map((radargram) => {
    const row = radargram.comparison;
    const within = row.withinAbs[state.tolerance];
    return [
      shortKey(radargram.key),
      radargram.users.length || "–",
      radargram.nTracesWithData.toLocaleString(),
      row.compared.toLocaleString(),
      fmt(row.medianAbs),
      cell(pct(within), within >= 0.9 ? "good" : within < 0.7 ? "bad" : ""),
      fmt(row.bias),
      pct(row.coverage),
    ];
  });
  renderTable($("radargram-table"), header, tableRows);
}

function aggregateUsers(metric) {
  const accumulators = new Map();
  for (const radargram of metric.radargrams) {
    if (!radargram.perUser) continue;
    for (const user of radargram.perUser.results) {
      let acc = accumulators.get(user.user);
      if (acc === undefined) {
        acc = {
          user: user.user,
          radargrams: 0,
          coverage: 0,
          medianAbsVsGroup: [],
          withinGroup: [],
          medianAbsVsPublished: [],
          withinPublished: [],
        };
        accumulators.set(user.user, acc);
      }
      acc.radargrams += 1;
      acc.coverage += isNumber(user.coverageFraction) ? user.coverageFraction : 0;
      for (const key of ["medianAbsVsGroup", "withinGroup", "medianAbsVsPublished", "withinPublished"]) {
        if (isNumber(user[key])) acc[key].push(user[key]);
      }
    }
  }
  const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN);
  return [...accumulators.values()].map((acc) => ({
    user: acc.user,
    radargrams: acc.radargrams,
    coverage: acc.coverage / acc.radargrams,
    medianAbsVsGroup: average(acc.medianAbsVsGroup),
    withinGroup: average(acc.withinGroup),
    medianAbsVsPublished: average(acc.medianAbsVsPublished),
    withinPublished: average(acc.withinPublished),
  }));
}

function renderUsers(metric) {
  const users = aggregateUsers(metric);
  const panel = $("per-user-panel");
  if (users.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const sorted = [...users].sort((a, b) => b.medianAbsVsGroup - a.medianAbsVsGroup);
  charts.bar(
    $("user-bars"),
    sorted.map((user) => user.user),
    sorted.map((user) => user.medianAbsVsGroup),
    { title: "Deviation from the group's own consensus (median |diff|)", xLabel: "m", horizontal: true, highlight: 0, uirevision: state.uirevision },
  );
  charts.bar(
    $("user-coverage"),
    sorted.map((user) => user.user),
    sorted.map((user) => user.coverage * 100),
    { title: `Coverage: share of traces with a ${metric.label.toLowerCase()} pick`, xLabel: "%", horizontal: true, uirevision: state.uirevision },
  );

  const header = ["Contributor", "Radargrams", "Coverage", "Median |diff| vs group (m)", "Within group", "Median |diff| vs published (m)", "Within published"];
  const rows = sorted.map((user) => [
    user.user,
    user.radargrams,
    pct(user.coverage),
    fmt(user.medianAbsVsGroup),
    pct(user.withinGroup),
    fmt(user.medianAbsVsPublished),
    pct(user.withinPublished),
  ]);
  renderTable($("user-table"), header, rows);
}

function renderBootstrap(metric) {
  const panel = $("bootstrap-panel");
  if (!metric.bootstrap || metric.bootstrap.curve.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const curve = metric.bootstrap.curve;
  const tolerance = metric.bootstrap.tolerance;
  charts.lines(
    $("bootstrap-within"),
    [
      {
        name: `Within ${tolerance} m`,
        x: curve.map((point) => point.k),
        y: curve.map((point) => point.within * 100),
        color: "#3f7d4f",
      },
    ],
    { title: `Share of ${metric.label.toLowerCase()} within ${tolerance} m of published, by subgroup size`, xLabel: "Number of contributors", yLabel: "% within tolerance", uirevision: state.uirevision, xaxis: { dtick: 1, tickformat: "d" } },
  );

  const target = curve.find((point) => point.within >= 0.9);
  const takeaway = $("bootstrap-takeaway");
  if (target) {
    const full = curve.at(-1);
    takeaway.innerHTML =
      `About <b>${target.k} contributors</b> are needed for 90% of ${metric.label.toLowerCase()} positions to land within ` +
      `${tolerance} m of the published consensus; the full group reaches ` +
      `<b>${(full.within * 100).toFixed(0)}%</b> with a median difference of ${fmt(full.medianAbs)} m.`;
  } else {
    const full = curve.at(-1);
    takeaway.innerHTML =
      `Even the full group stays below 90% within ${tolerance} m (best ${(full.within * 100).toFixed(0)}%, ` +
      `median difference ${fmt(full.medianAbs)} m). Consider a looser tolerance to see the trend.`;
  }
}

function renderSlopeSpread(metric) {
  const panel = $("slope-panel");
  const slope = metric.slopeSpread;
  if (!slope || slope.n === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  charts.binnedTrend($("slope-chart"), slope.bins, {
    title: `Contributor spread vs along-track ${metric.label.toLowerCase()} slope`,
    xLabel: "slope angle (° from horizontal)",
    yLabel: "spread relative to the radargram typical",
    trendName: "binned median",
    uirevision: state.uirevision,
  });
  const trend =
    slope.spearman >= 0.15 ? "rises with" : slope.spearman <= -0.15 ? "falls with" : "shows little relation to";
  const flatRange = `${fmt(slope.flattestQ25, 2)}–${fmt(slope.flattestQ75, 2)}×`;
  const steepRange = `${fmt(slope.steepestQ25, 2)}–${fmt(slope.steepestQ75, 2)}×`;
  const medianShift = slope.steepestMedian - slope.flattestMedian;
  const medianWord = medianShift > 0.1 ? "rises" : medianShift < -0.1 ? "falls" : "stays about the same";
  $("slope-takeaway").innerHTML =
    `Across <b>${slope.n.toLocaleString()}</b> positions, the contributor spread ${trend} the along-track slope ` +
    `(Spearman ρ = ${fmt(slope.spearman, 2)}). The median relative spread ${medianWord}, from ` +
    `<b>${fmt(slope.flattestMedian, 2)}×</b> on the flattest ice (${fmt(slope.minAngle, 1)}–${fmt(slope.bins[0]?.hi, 1)}°) ` +
    `to <b>${fmt(slope.steepestMedian, 2)}×</b> at the steepest (${fmt(slope.bins.at(-1)?.lo, 1)}–${fmt(slope.maxAngle, 1)}°); ` +
    `the middle 50% runs ${flatRange} flat and ${steepRange} steep.`;
}

// --- wiring -----------------------------------------------------------------

function wireUpload() {
  const dropzone = $("dropzone");
  const input = $("file-input");
  dropzone.addEventListener("click", () => input.click());
  dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") input.click();
  });
  input.addEventListener("change", () => runFiles(input.files));
  for (const event of ["dragenter", "dragover"]) {
    dropzone.addEventListener(event, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
  }
  for (const event of ["dragleave", "drop"]) {
    dropzone.addEventListener(event, (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    });
  }
  dropzone.addEventListener("drop", (e) => runFiles(e.dataTransfer.files));

  for (const button of document.querySelectorAll("[data-demo]")) {
    button.addEventListener("click", async () => {
      setStatus(`Loading ${button.textContent.trim()} demo…`);
      try {
        const response = await fetch(`data/demo/${button.dataset.demo}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        await runFiles([new File([blob], button.dataset.demo, { type: "application/zip" })]);
      } catch (error) {
        setStatus(`Could not load the demo: ${error.message}`, true);
      }
    });
  }

  $("tolerance").addEventListener("change", (event) => {
    const value = Number(event.target.value);
    if (Number.isFinite(value) && value > 0) {
      state.tolerance = value;
      if (state.upload) runAnalysis();
    }
  });

  // The per-contributor charts start collapsed; fit them on first open.
  $("per-user-panel").addEventListener("toggle", () => resizeCharts());

  $("download-json").addEventListener("click", () => {
    if (!state.result) return;
    const text = JSON.stringify(state.result, (key, value) => {
      if (ArrayBuffer.isView(value)) return Array.from(value);
      return value;
    }, 2);
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "consensus-results.json";
    anchor.click();
    URL.revokeObjectURL(url);
  });
}

async function init() {
  wireUpload();
  state.reference = await createReference("data/reference");
  const status = $("reference-status");
  if (state.reference.available) {
    const count = Object.keys(state.reference.index.radargrams).length;
    status.className = "pill pill-ok";
    status.textContent = `Reference loaded · ${count} radargrams`;
  } else {
    status.className = "pill pill-warn";
    status.textContent = "No reference available";
  }
}

init();
