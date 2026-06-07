/* Our Sustainability Nest — display layer.
   Reads data.json (falls back to data.js for file:// viewing), renders panels,
   and HIDES any domain that isn't present. No data entry, no storage, no server. */

(function () {
  "use strict";

  // Soft pastel chart palette
  const C = {
    elec: "#6cc8e6", gas: "#ffb877", propane: "#ff9ec7",
    s1: "#ffb877", s2: "#6cc8e6", mo: "#b79cff",
    trash: "#c9c2d6", recycle: "#6cc8e6", compost: "#5fd0a8",
    mint: "#5fd0a8", sky: "#6cc8e6", pink: "#ff9ec7", lav: "#b79cff",
    peach: "#ffb877", lemon: "#ffd86b", muted: "#9a93ad", grid: "#efeaf5",
    ink: "#4a4360",
    pie: ["#6cc8e6", "#ffb877", "#b79cff", "#ff9ec7", "#5fd0a8", "#ffd86b"],
    crops: ["#5fd0a8", "#6cc8e6", "#ffb877", "#b79cff", "#ff9ec7", "#ffd86b", "#c9c2d6", "#9ad6b4"],
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

  function setChartDefaults() {
    const D = Chart.defaults;
    D.color = C.muted;
    D.font.family = getComputedStyle(document.body).fontFamily;
    D.font.weight = 600;
    D.borderColor = C.grid;
    D.maintainAspectRatio = false;
    D.plugins.legend.labels.boxWidth = 12;
    D.plugins.legend.labels.usePointStyle = true;
    D.plugins.tooltip.backgroundColor = "#fff";
    D.plugins.tooltip.titleColor = C.ink;
    D.plugins.tooltip.bodyColor = C.ink;
    D.plugins.tooltip.borderColor = C.grid;
    D.plugins.tooltip.borderWidth = 1;
    D.plugins.tooltip.padding = 10;
    D.plugins.tooltip.cornerRadius = 12;
    D.plugins.tooltip.titleFont = { weight: 700 };
  }

  const axis = (opts = {}) => Object.assign(
    { grid: { color: C.grid }, ticks: { color: C.muted }, border: { display: false } }, opts);

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

  // ---- Sustainability pet (Tamagotchi) -------------------------------------
  function renderPet(eco) {
    if (!eco) return;
    $("pet-card").hidden = false;
    $("pet-emoji").textContent = eco.emoji || "🌱";
    $("pet-title").textContent = eco.title || "Sprouty";
    $("pet-message").textContent = eco.message || "";
    const ring = $("pet-ring");
    if (eco.score != null) {
      ring.style.setProperty("--score", eco.score);
      $("pet-score").textContent = eco.score + "/100";
    } else {
      ring.style.setProperty("--score", 0);
      $("pet-score").textContent = "—";
    }
    const box = $("pet-factors");
    box.innerHTML = "";
    (eco.factors || []).forEach((f) => {
      const row = document.createElement("div");
      row.className = "pf-row";
      row.innerHTML = `<span>${f.label}</span><span class="pf-bar"><span class="pf-fill" style="width:${f.pct}%"></span></span>`;
      box.appendChild(row);
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
      trendEl.innerHTML = `<span class="flat">No prior-year baseline yet to compare 🌱</span>`;
      return;
    }
    const dir = summary.trend_direction;
    const arrow = dir === "down" ? "▼" : dir === "up" ? "▲" : "▬";
    const verb = dir === "down" ? "below" : dir === "up" ? "above" : "vs";
    const prior = summary.prior_12;
    const partial = prior && prior.window.months_counted < 12;
    trendEl.innerHTML =
      `<span class="${dir}">${arrow} ${Math.abs(summary.trend_pct)}% ${verb} prior 12 months</span>` +
      (partial ? `<span class="caveat"> — prior window has only ${prior.window.months_counted} month(s), so treat as indicative.</span>` : "");
  }

  // ---- How we compare ------------------------------------------------------
  function renderCompare(summary, energy) {
    const cmp = summary && summary.comparison;
    const eui = energy && energy.present ? energy.eui : null;
    if (!cmp && !(eui && eui.benchmark)) return;
    $("compare").hidden = false;

    if (cmp) {
      $("cmp-region").textContent = cmp.region_label || "a typical home";
      const better = cmp.delta_pct < 0;
      const el = $("cmp-co2");
      el.textContent = `${Math.abs(cmp.delta_pct)}% ${better ? "lower" : "higher"}`;
      el.className = "ci-value " + (better ? "good" : "bad");
      $("cmp-co2-sub").textContent =
        `${fmt(cmp.your_annual_kg)} vs ${fmt(cmp.typical_annual_kg)} kg/yr` +
        (cmp.annualized ? ` (annualized from ${cmp.months_counted} mo)` : "") +
        (better ? " 🎉" : "");
    } else {
      $("cmp-co2").parentElement.style.display = "none";
    }

    if (eui && eui.benchmark) {
      const d = eui.delta_pct;
      const better = d <= 0;
      const el = $("cmp-eui");
      el.textContent = `${fmt(eui.value, 1)} kBtu/ft²/yr`;
      el.className = "ci-value " + (Math.abs(d) <= 5 ? "" : better ? "good" : "bad");
      const word = Math.abs(d) <= 5 ? "about typical" : `${Math.abs(d)}% ${better ? "below" : "above"} typical`;
      $("cmp-eui-sub").textContent = `${word} (≈${eui.benchmark} for ${eui.benchmark_label || "a typical home"})`;
    } else {
      $("cmp-eui").parentElement.style.display = "none";
    }
  }

  // ---- Energy (single unit: kBtu) ------------------------------------------
  function renderEnergy(e, notes) {
    if (!e || !e.present) return;
    $("panel-energy").hidden = false;

    if (e.eui && e.eui.value != null) {
      const d = e.eui.delta_pct;
      let chip = "";
      if (d != null) {
        const cls = Math.abs(d) <= 5 ? "neutral" : d < 0 ? "good" : "bad";
        const txt = Math.abs(d) <= 5 ? "≈ typical" : `${d > 0 ? "+" : ""}${d}% vs typical`;
        chip = ` <span class="chip ${cls}">${txt}</span>`;
      }
      $("eui-readout").innerHTML =
        `Site EUI <b>${fmt(e.eui.value, 1)}</b> kBtu/ft²/yr${chip}` +
        (e.eui.annualized ? ` <span title="annualized from ${e.eui.months_counted} months">*</span>` : "");
    }

    const ds = [
      { label: "Electricity", data: e.electricity_kbtu, backgroundColor: C.elec, stack: "k" },
      { label: "Natural gas", data: e.natural_gas_kbtu, backgroundColor: C.gas, stack: "k" },
    ];
    if (e.propane_kbtu && e.propane_kbtu.some((v) => v != null)) {
      ds.push({ label: "Propane", data: e.propane_kbtu, backgroundColor: C.propane, stack: "k" });
    }
    new Chart($("chart-energy"), {
      type: "bar",
      data: { labels: e.months, datasets: ds },
      options: {
        interaction: { mode: "index", intersect: false },
        borderRadius: 6,
        scales: {
          x: axis({ stacked: true, grid: { display: false } }),
          y: axis({ stacked: true, title: { display: true, text: "kBtu", color: C.muted } }),
        },
      },
    });

    const future = notes && notes.future_actions && notes.future_actions[0];
    if (future) { $("energy-idea").hidden = false; $("energy-idea").innerHTML = "💡 <b>Idea:</b> " + future; }
  }

  // ---- Emissions pie -------------------------------------------------------
  function renderEmissions(summary) {
    const rows = summary && summary.emissions_by_source;
    if (!rows || !rows.length) return;
    $("panel-emissions").hidden = false;
    const labels = rows.map((r) => r.source);
    const data = rows.map((r) => r.kg);
    const colors = rows.map((_, i) => C.pie[i % C.pie.length]);
    const total = data.reduce((a, b) => a + b, 0);

    new Chart($("chart-emissions"), {
      type: "doughnut",
      data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: "#fff", borderWidth: 3 }] },
      options: {
        cutout: "58%",
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => `${c.label}: ${fmt(c.parsed)} kg (${Math.round(c.parsed / total * 100)}%)` } },
        },
      },
    });

    const ul = $("emissions-legend");
    ul.innerHTML = "";
    rows.forEach((r, i) => {
      const li = document.createElement("li");
      li.innerHTML =
        `<span class="sw" style="background:${colors[i]}"></span>` +
        `<span>${r.source} <span class="sc">· ${r.scope}</span></span>` +
        `<span class="lv">${Math.round(r.kg / total * 100)}%</span>`;
      ul.appendChild(li);
    });
  }

  // ---- Waste ---------------------------------------------------------------
  function renderWaste(w) {
    if (!w || !w.present) return;
    $("panel-waste").hidden = false;
    if (w.overall_diversion != null)
      $("diversion-readout").innerHTML = `Overall diversion <b>${Math.round(w.overall_diversion * 100)}%</b>`;

    new Chart($("chart-waste"), {
      type: "bar",
      data: {
        labels: w.months,
        datasets: [
          { label: "Trash", data: w.trash_gal, backgroundColor: C.trash, stack: "g" },
          { label: "Recycle", data: w.recycle_gal, backgroundColor: C.recycle, stack: "g" },
          { label: "Compost", data: w.compost_gal, backgroundColor: C.compost, stack: "g" },
        ],
      },
      options: {
        borderRadius: 6,
        scales: {
          x: axis({ stacked: true, grid: { display: false } }),
          y: axis({ stacked: true, title: { display: true, text: "gallons", color: C.muted } }),
        },
      },
    });

    const pct = w.overall_diversion == null ? 0 : Math.round(w.overall_diversion * 100);
    $("gauge-pct").textContent = w.overall_diversion == null ? "—" : pct + "%";
    new Chart($("chart-diversion"), {
      type: "doughnut",
      data: { labels: ["Diverted", "Landfill"], datasets: [{ data: [pct, 100 - pct], backgroundColor: [C.mint, C.grid], borderWidth: 0 }] },
      options: { cutout: "72%", rotation: -90, circumference: 180, plugins: { legend: { display: false }, tooltip: { enabled: false } } },
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
      const labels = rows.map((r) => (mode === "season" ? r.season : r.crop));
      const data = rows.map((r) => r.lbs);
      const colors = labels.map((_, i) => C.crops[i % C.crops.length]);
      if (chart) chart.destroy();
      chart = new Chart(ctx, {
        type: "bar",
        data: { labels, datasets: [{ label: "lbs", data, backgroundColor: colors }] },
        options: {
          indexAxis: "y", borderRadius: 6,
          plugins: { legend: { display: false } },
          scales: { x: axis({ title: { display: true, text: "pounds", color: C.muted } }), y: axis({ grid: { display: false } }) },
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
      `<span class="num">${fmt(t.miles_not_driven)}</span> miles not driven 🚲<br>` +
      `<span style="color:var(--muted)">${fmt(t.total_ghg_kg)} kg CO₂e from fuel</span>`;

    const labels = t.by_mode.map((m) => `${m.mode} (${m.unit})`);
    const amounts = t.by_mode.map((m) => m.amount);
    const ghg = t.by_mode.map((m) => m.ghg_kg);
    const colors = t.by_mode.map((m) => (m.is_miles ? C.mint : C.lav));

    new Chart($("chart-transport"), {
      type: "bar",
      data: { labels, datasets: [{ label: "amount", data: amounts, backgroundColor: colors }] },
      options: {
        borderRadius: 6,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { afterLabel: (c) => (ghg[c.dataIndex] ? `${fmt(ghg[c.dataIndex])} kg CO₂e` : "≈0 carbon 💚") } },
        },
        scales: { x: axis({ grid: { display: false } }), y: axis({ title: { display: true, text: "gallons / miles", color: C.muted } }) },
      },
    });

    if (t.avoided_co2e_kg != null) {
      $("avoided-box").hidden = false;
      $("avoided-box").innerHTML =
        `🌿 By biking instead of driving, you avoided roughly <b>${fmt(t.avoided_co2e_kg)} kg CO₂e</b>` +
        (t.avoided_basis_mpg ? ` <span style="color:var(--muted)">(vs a ${t.avoided_basis_mpg} mpg car)</span>` : "") + ".";
    }
  }

  // ---- Journey timeline ----------------------------------------------------
  function renderJourney(m) {
    const ol = $("timeline");
    if (!m || !m.present || !m.events.length) { $("journey-empty").hidden = false; return; }
    const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    m.events.forEach((ev) => {
      const li = document.createElement("li");
      li.innerHTML = `<div class="t-date">${fmtDate(ev.date)}</div><div class="t-title"></div>` + (ev.note ? `<div class="t-note"></div>` : "");
      li.querySelector(".t-title").textContent = ev.title;
      if (ev.note) li.querySelector(".t-note").textContent = ev.note;
      ol.appendChild(li);
    });
  }

  // ---- Boot ----------------------------------------------------------------
  function boot(data) {
    setChartDefaults();
    wireTabs();
    const notes = (data.config_echo && data.config_echo.notes) || {};

    const gen = data.generated_at ? new Date(data.generated_at).toLocaleString() : "—";
    $("meta").innerHTML =
      `Updated ${gen}<span class="badge">source: ${data.source || "?"}</span>` +
      (data.warnings && data.warnings.length ? `<span class="badge" title="${data.warnings.join("&#10;")}">${data.warnings.length} note(s)</span>` : "");

    renderPet(data.eco_score);
    renderHero(data.summary);
    renderCompare(data.summary, data.energy);
    renderEnergy(data.energy, notes);
    renderEmissions(data.summary);
    renderWaste(data.waste);
    renderGarden(data.garden);
    renderTransport(data.transport);
    renderJourney(data.milestones);

    const anyPanel = (data.domains_present || []).some((d) => ["energy", "waste", "garden", "transport"].includes(d));
    $("dashboard-empty").hidden = anyPanel;
  }

  loadData().then(boot).catch((err) => {
    $("meta").textContent = "Could not load data: " + err.message;
    $("dashboard-empty").hidden = false;
  });
})();
