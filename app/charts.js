// Thin Plotly wrappers. Keeping chart construction here means the app code
// stays about data and layout, not about trace styling.

const FONT = { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 12 };
const ACCENT = "#1f6f8b";
const WARN = "#c9553d";

const CONFIG = { displayModeBar: false, responsive: true };

/** Re-fit a chart to its container after the layout around it changes. */
export function resize(element) {
  if (element && element.clientWidth > 0 && element._fullLayout) Plotly.Plots.resize(element);
}

function baseLayout(title, xLabel, yLabel, uirevision) {
  return {
    title: { text: title, font: { ...FONT, size: 14 } },
    font: FONT,
    autosize: true,
    // Changing this token makes Plotly discard the previous axis ranges and
    // re-autorange. Without it, switching metric tabs keeps the old axes, so
    // thickness and CTS (different magnitudes) look zoomed wrongly.
    uirevision,
    margin: { l: 55, r: 20, t: 40, b: 45 },
    // Explicit autorange, so every render (including a metric switch) fits the
    // new data instead of inheriting the previous plot's range.
    xaxis: { title: { text: xLabel }, gridcolor: "#eef1f3", zeroline: false, automargin: true, autorange: true },
    yaxis: { title: { text: yLabel }, gridcolor: "#eef1f3", zeroline: false, automargin: true, autorange: true },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    showlegend: false,
  };
}

export function histogram(element, values, options = {}) {
  const layout = baseLayout(options.title ?? "", options.xLabel ?? "", options.yLabel ?? "positions", options.uirevision);
  Plotly.react(
    element,
    [{ type: "histogram", x: values, marker: { color: options.color ?? ACCENT }, nbinsx: options.bins ?? 40 }],
    layout,
    CONFIG,
  );
}

export function bar(element, labels, values, options = {}) {
  const layout = baseLayout(options.title ?? "", options.xLabel ?? "", options.yLabel ?? "", options.uirevision);
  if (options.horizontal === true) {
    // Give every bar room, but cap very long label sets so the chart stays a
    // readable height (the table below carries the full detail).
    layout.height = options.height ?? Math.min(640, Math.max(320, labels.length * 20 + 80));
  }
  const trace =
    options.horizontal === true
      ? {
          type: "bar",
          orientation: "h",
          y: labels.slice().reverse(),
          x: values.slice().reverse(),
          marker: {
            color: values
              .map((_, index) => (index === options.highlight ? WARN : ACCENT))
              .reverse(),
          },
          text: values.map((value) => (Number.isFinite(value) ? value.toFixed(2) : "")).reverse(),
          textposition: "auto",
          cliponaxis: false,
        }
      : { type: "bar", x: labels, y: values, marker: { color: options.color ?? ACCENT } };
  Plotly.react(element, [trace], layout, CONFIG);
}

export function lines(element, series, options = {}) {
  const layout = baseLayout(options.title ?? "", options.xLabel ?? "", options.yLabel ?? "", options.uirevision);
  if (series.length > 1 || options.legend) layout.showlegend = true;
  if (options.xaxis) Object.assign(layout.xaxis, options.xaxis);
  if (options.yaxis) Object.assign(layout.yaxis, options.yaxis);
  Plotly.react(
    element,
    series.map((item, index) => ({
      type: options.type ?? "scatter",
      mode: options.mode ?? "lines+markers",
      name: item.name,
      x: item.x,
      y: item.y,
      line: { color: item.color ?? [ACCENT, WARN, "#5a8f3d", "#8a5fb0"][index % 4], width: 2 },
      marker: { size: 5 },
      yaxis: item.yaxis ?? "y",
    })),
    layout,
    CONFIG,
  );
}

/**
 * A binned trend: the median line with a shaded 25-75% band, and a tooltip
 * reporting how many positions each bin holds. The individual positions are
 * deliberately not drawn -- at this density they are visual noise.
 */
export function binnedTrend(element, bins, options = {}) {
  const layout = baseLayout(options.title ?? "", options.xLabel ?? "", options.yLabel ?? "", options.uirevision);
  layout.showlegend = bins.length > 0;
  const traces = [];
  if (bins.length) {
    const x = bins.map((bin) => bin.mid);
    const customdata = bins.map((bin) => [bin.count, bin.lo, bin.hi, bin.q25Spread, bin.q75Spread]);
    traces.push({
      type: "scatter",
      mode: "lines",
      name: "25–75%",
      x,
      y: bins.map((bin) => bin.q75Spread),
      line: { width: 0 },
      hoverinfo: "skip",
      legendgroup: "iqr",
    });
    traces.push({
      type: "scatter",
      mode: "lines",
      name: "25–75%",
      x,
      y: bins.map((bin) => bin.q25Spread),
      line: { width: 0 },
      fill: "tonexty",
      fillcolor: "rgba(31, 111, 139, 0.18)",
      hoverinfo: "skip",
      legendgroup: "iqr",
    });
    traces.push({
      type: "scatter",
      mode: "lines+markers",
      name: options.trendName ?? "binned median",
      x,
      y: bins.map((bin) => bin.medianSpread),
      line: { color: ACCENT, width: 2.5 },
      marker: { size: 7, color: ACCENT },
      customdata,
      hovertemplate:
        "angle %{customdata[1]:.1f}–%{customdata[2]:.1f}°" +
        "<br>median %{y:.2f}×" +
        "<br>25–75% %{customdata[3]:.2f}–%{customdata[4]:.2f}×" +
        "<br>%{customdata[0]:,} positions<extra></extra>",
    });
  }
  Plotly.react(element, traces, layout, CONFIG);
}
