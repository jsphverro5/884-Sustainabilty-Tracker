/* Household Sustainability Dashboard — display layer.
   Reads data.json (falls back to data.js for file:// viewing), renders panels,
   and HIDES any domain that isn't present. No data entry, no storage, no server. */

(function () {
  "use strict";

  const COLORS = {
    elec: "#5bb8d6", gas: "#e0a93b", propane: "#e0735f",
    s1: "#e0a93b", s2: "#5bb8d6", mo: "#b58be0",
    trash: "#8a96a3", recycle: "#5bb8d6", compost: "#4caf7b",
    green: "#4caf7b", green2: "#7bd6a0", muted: "#9bb0a3", grid: "#2c3a30",
    cropPalette: ["#4caf7b", "#5bb8d6", "#e0a93b", "#b58be0", "#e0735f", "#7bd6a0", "#8a96a3", "#d6cf5b"],
  };

  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 0) =>
    n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });

  // ---- Data loading: prefer data.json; fall back to data.js (file://) -------
  function loadData() {
    return fetch("./data.json", { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .catch(() =>
        new Promise((resolve, reject) => {
          if (window.__DASHBOARD_DATA__) return resolve(window.__DASHBOARD_DATA__);
          const s = document.createElement("script");
          s.src = "./data.js";
          s.onload = () =>
            window.__DASHBOARD_DATA__ ? resolve(window.__DASHBOARD_DATA__) : reject(new Error("no data"));
          s.onerror = () => reject(new Error("Could not load data.json or data.js"));
          document.head.appendChild(s);
        })
      );
  }

  // ---- Chart.js shared defaults --------------------------------------------
  function setChartDefaults() {
    const C = Chart;
    C.defaults.color = COLORS.muted;
    C.defaults.font.family = getComputedStyle(document.body).fontFamily;
    C.defaults.borderColor = COLORS.grid;
    C.defaults.maintainAspectRatio = false;
    C.defaults.plugins.legend.labels.boxWidth = 12;
    C.defaults.plugins.legend.labels.usePointStyle = true;
  }

  const gridScale = (opts = {}) => Object.assign(
    { grid: { color: COLORS.grid }, ticks: { color: COLORS.muted } }, opts);

  // ---- Tabs ----------------------------------------------------------------
  function wireTabs() {
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        const tab = btn.dataset.tab;
        $("view-dashboard").hidden = tab !== "dashboard";
        $("view-journey").hidden = tab !== "journey";
      });
    });
  }

  // ---- Hero ----------------------------------------------------------------
  function renderHero(summary) {
    if (!summary || !summary.trailing_12) return;
    const t = summary.trailing_12;
    $("hero").hidden = false;
    $("hero-total").textContent = fmt(t.total_kg);
    $("bd-s2").textContent = fmt(t.scope2_kg) + " kg";
    $("bd-s1").textContent = fmt(t.scope1_kg) + " kg";
    $("bd-mo").textContent = fmt(t.mobile_kg) + " kg";

    const w = t.window;
    $("hero-window").textContent =
      `Window: ${w.start} → ${w.end}` +
      (w.months_counted < 12 ? ` · only ${w.months_counted} of 12 months have data` : "");

    const trendEl = $("hero-trend");
    if (summary.trend_pct == null) {
      trendEl.innerHTML = `<span class="flat">No prior-year baseline yet to compare.</span>`;
      return;
    }
    const dir = summary.trend_direction;
    const arrow = dir === "down" ? "▼" : dir === "up" ? "▲" : "▬";
    const verb = dir === "down" ? "below" : dir === "up" ? "above" : "vs";
    const prior = summary.prior_12;
    const partial = prior && prior.window.months_counted < 12;
    trendEl.innerHTML =
      `<span class="${dir}">${arrow} ${Math.abs(summary.trend_pct)}% ${verb} prior 12 months</span>` +
      (partial
        ? `<span class="caveat"> — prior window only has ${prior.window.months_counted} month(s) of data, so treat this as indicative.</span>`
        : "");
  }

  // ---- Energy --------------------------------------------------------------
  function renderEnergy(e) {
    if (!e || !e.present) return;
    $("panel-energy").hidden = false;

    if (e.eui && e.eui.value != null) {
      $("eui-readout").innerHTML =
        `Site EUI <b>${fmt(e.eui.value, 1)}</b> kBtu/ft²/yr` +
        (e.eui.annualized ? ` <span title="annualized from ${e.eui.months_counted} months">*</span>` : "");
    }

    const datasets = [
      { label: "Electricity (kWh)", data: e.electricity_kWh, borderColor: COLORS.elec,
        backgroundColor: COLORS.elec, yAxisID: "y", tension: .3, spanGaps: true, pointRadius: 2 },
      { label: "Natural gas (therms)", data: e.natural_gas_therms, borderColor: COLORS.gas,
        backgroundColor: COLORS.gas, yAxisID: "y1", tension: .3, spanGaps: true, pointRadius: 2 },
    ];
    if (e.propane_gal && e.propane_gal.some((v) => v != null)) {
      datasets.push({ label: "Propane (gal)", data: e.propane_gal, borderColor: COLORS.propane,
        backgroundColor: COLORS.propane, yAxisID: "y1", tension: .3, spanGaps: true, pointRadius: 2 });
    }

    new Chart($("chart-energy"), {
      type: "line",
      data: { labels: e.months, datasets },
      options: {
        interaction: { mode: "index", intersect: false },
        scales: {
          x: gridScale({ grid: { display: false } }),
          y: gridScale({ position: "left", title: { display: true, text: "kWh", color: COLORS.muted } }),
          y1: gridScale({ position: "right", grid: { drawOnChartArea: false },
            title: { display: true, text: "therms / gal", color: COLORS.muted } }),
        },
      },
    });
  }

  // ---- Waste ---------------------------------------------------------------
  function renderWaste(w) {
    if (!w || !w.present) return;
    $("panel-waste").hidden = false;

    if (w.overall_diversion != null) {
      $("diversion-readout").innerHTML = `Overall diversion <b>${Math.round(w.overall_diversion * 100)}%</b>`;
    }

    new Chart($("chart-waste"), {
      type: "bar",
      data: {
        labels: w.months,
        datasets: [
          { label: "Trash", data: w.trash_gal, backgroundColor: COLORS.trash, stack: "g" },
          { label: "Recycle", data: w.recycle_gal, backgroundColor: COLORS.recycle, stack: "g" },
          { label: "Compost", data: w.compost_gal, backgroundColor: COLORS.compost, stack: "g" },
        ],
      },
      options: {
        scales: {
          x: gridScale({ stacked: true, grid: { display: false } }),
          y: gridScale({ stacked: true, title: { display: true, text: "gallons", color: COLORS.muted } }),
        },
      },
    });

    const pct = w.overall_diversion == null ? 0 : Math.round(w.overall_diversion * 100);
    $("gauge-pct").textContent = w.overall_diversion == null ? "—" : pct + "%";
    new Chart($("chart-diversion"), {
      type: "doughnut",
      data: {
        labels: ["Diverted", "Landfill"],
        datasets: [{ data: [pct, 100 - pct],
          backgroundColor: [COLORS.green, COLORS.grid], borderWidth: 0 }],
      },
      options: { cutout: "72%", rotation: -90, circumference: 180,
        plugins: { legend: { display: false }, tooltip: { enabled: false } } },
    });
  }

  // ---- Garden --------------------------------------------------------------
  function renderGarden(g) {
    if (!g || !g.present) return;
    $("panel-garden").hidden = false;
    $("garden-readout").innerHTML = `Total <b>${fmt(g.total_lbs, 1)}</b> lbs`;

    const ctx = $("chart-garden");
    let chart;
    const draw = (mode) => {
      const rows = mode === "season" ? g.by_season : g.by_crop;
      const labels = rows.map((r) => mode === "season" ? r.season : r.crop);
      const data = rows.map((r) => r.lbs);
      const colors = labels.map((_, i) => COLORS.cropPalette[i % COLORS.cropPalette.length]);
      if (chart) chart.destroy();
      chart = new Chart(ctx, {
        type: "bar",
        data: { labels, datasets: [{ label: "lbs", data, backgroundColor: colors }] },
        options: {
          indexAxis: "y",
          plugins: { legend: { display: false } },
          scales: {
            x: gridScale({ title: { display: true, text: "pounds", color: COLORS.muted } }),
            y: gridScale({ grid: { display: false } }),
          },
        },
      });
    };
    draw("crop");
    $("garden-toggle").querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        $("garden-toggle").querySelectorAll("button").forEach((x) => x.classList.remove("is-active"));
        b.classList.add("is-active");
        draw(b.dataset.mode);
      });
    });
  }

  // ---- Transport -----------------------------------------------------------
  function renderTransport(t) {
    if (!t || !t.present) return;
    $("panel-transport").hidden = false;
    $("miles-readout").innerHTML =
      `<span class="num">${fmt(t.miles_not_driven)}</span> miles not driven<br>` +
      `<span style="color:var(--muted)">${fmt(t.total_ghg_kg)} kg CO₂e from fuel</span>`;

    const labels = t.by_mode.map((m) => `${m.mode} (${m.unit})`);
    const amounts = t.by_mode.map((m) => m.amount);
    const ghg = t.by_mode.map((m) => m.ghg_kg);
    const colors = t.by_mode.map((m) => (m.is_miles ? COLORS.green : COLORS.mo));

    new Chart($("chart-transport"), {
      type: "bar",
      data: { labels, datasets: [{ label: "amount", data: amounts, backgroundColor: colors }] },
      options: {
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            afterLabel: (c) => ghg[c.dataIndex] ? `${fmt(ghg[c.dataIndex])} kg CO₂e` : "≈0 carbon",
          } },
        },
        scales: {
          x: gridScale({ grid: { display: false } }),
          y: gridScale({ title: { display: true, text: "gallons / miles", color: COLORS.muted } }),
        },
      },
    });
  }

  // ---- Journey timeline ----------------------------------------------------
  function renderJourney(m) {
    const ol = $("timeline");
    if (!m || !m.present || !m.events.length) {
      $("journey-empty").hidden = false;
      return;
    }
    const fmtDate = (iso) => {
      const d = new Date(iso + "T00:00:00");
      return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    };
    m.events.forEach((ev) => {
      const li = document.createElement("li");
      li.innerHTML =
        `<div class="t-date">${fmtDate(ev.date)}</div>` +
        `<div class="t-title"></div>` +
        (ev.note ? `<div class="t-note"></div>` : "");
      li.querySelector(".t-title").textContent = ev.title;
      if (ev.note) li.querySelector(".t-note").textContent = ev.note;
      ol.appendChild(li);
    });
  }

  // ---- Boot ----------------------------------------------------------------
  function boot(data) {
    setChartDefaults();
    wireTabs();

    const gen = data.generated_at ? new Date(data.generated_at).toLocaleString() : "—";
    $("meta").innerHTML =
      `Last updated ${gen}<span class="badge">source: ${data.source || "?"}</span>` +
      (data.warnings && data.warnings.length ? `<span class="badge" title="${data.warnings.join("&#10;")}">${data.warnings.length} note(s)</span>` : "");

    renderHero(data.summary);
    renderEnergy(data.energy);
    renderWaste(data.waste);
    renderGarden(data.garden);
    renderTransport(data.transport);
    renderJourney(data.milestones);

    const anyPanel = (data.domains_present || []).some((d) =>
      ["energy", "waste", "garden", "transport"].includes(d));
    $("dashboard-empty").hidden = anyPanel;
  }

  loadData().then(boot).catch((err) => {
    $("meta").textContent = "Could not load data: " + err.message;
    $("dashboard-empty").hidden = false;
  });
})();
