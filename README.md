# 884 Household Sustainability Dashboard

A **display-only** dashboard for a household sustainability log. Data is entered by
hand in a Google Sheet (one tab per domain); this project reads those tabs, does the
carbon math, and renders a single static page.

There is **no data-entry UI, no database, and no backend** — by design. The entry
layer is the Google Sheet. This repo is just the read side.

```
Google Sheet tabs ──(published CSV)──▶ ingest.py ──▶ data.json ──▶ index.html
                                          │                (+ data.js mirror)
                                          └─ config.json (factors, sizes, URLs)
```

---

## What's in here

| File | Purpose |
|------|---------|
| `ingest.py` | Pulls each tab's CSV, validates/cleans, computes metrics, writes `data.json` + `data.js`. |
| `config.json` | Everything tunable: home size, container sizes, **emission factors (with cited sources)**, energy-content constants, transport mode rules, and the tab CSV URLs. Nothing is hardcoded in the logic. |
| `index.html` + `assets/` | The dashboard. Vanilla JS + a vendored, pinned Chart.js. No build step. |
| `sample/*.csv` | Realistic sample data so you can see the dashboard before any real data exists. |
| `data.json` / `data.js` | Generated output the page consumes. Committed with the **sample** render so the page works out of the box. |
| `requirements.txt` | One pinned dependency (`pandas`) — only needed to run `ingest.py`. |

---

## Quick start (view the sample dashboard)

The repo ships with a sample `data.json` already generated, so:

```bash
# Easiest: just open it. The page falls back to data.js, so no server is required.
open index.html

# Or serve it (any static server works):
python3 -m http.server 8000   # then visit http://localhost:8000
```

You should see the trailing-12-month CO₂e headline, energy / waste / garden /
transport panels, and a **Journey** tab with the milestone timeline. The **water**
panel is intentionally hidden because that tab has no data yet.

---

## Load your real data

1. **Publish each tab as CSV** in Google Sheets: `File → Share → Publish to web →`
   pick the tab → `CSV`. Paste each URL into `config.json → data_urls`.
2. **Install the one dependency** (a virtualenv keeps it tidy):
   ```bash
   python3 -m venv .venv
   ./.venv/bin/python -m pip install -r requirements.txt
   ```
3. **Run the ingestion** (idempotent — safe to re-run any time):
   ```bash
   ./.venv/bin/python ingest.py            # pulls live CSVs from config.json
   ```
   This overwrites `data.json` and `data.js`. Refresh the page to see new data.

Other modes:
```bash
./.venv/bin/python ingest.py --sample          # rebuild from ./sample/*.csv
./.venv/bin/python ingest.py --source ./mydir  # build from a local folder of <tab>.csv
```

`ingest.py` prints a summary and any **warnings** to stderr (also embedded in
`data.json → warnings` and shown as a "note(s)" badge in the header).

---

## Expected tab & column structure

Headers must match **exactly**. Monthly tabs use `YYYY-MM`; event tabs use `YYYY-MM-DD`.
**Leave a cell blank for "no data" — never type 0** (a real `0` means "measured zero").

| Tab | Columns | Notes |
|-----|---------|-------|
| `energy` | `month, electricity_kWh, natural_gas_therms, propane_gal` | One row per billing month. |
| `waste` | `date, trash_bags, recycle_loads, compost_fills, note` | Log **counts**, not volumes — container sizes live in config. |
| `garden` | `date, crop, weight_lbs, note` | One row per harvest. |
| `transport` | `date, mode, amount, note` | `amount` is **mode-dependent** — see below. |
| `milestones` | `date, title, note` | The Journey timeline. |
| `water` | `month, water_amount` | Parked — leave empty; its panel stays hidden until rows appear. |

**Transport `amount` by mode:**
- `car_gas` → **gallons** at fill-up → emissions = gallons × gasoline factor.
- `ebike` / `bike` → **miles**, treated as ~zero carbon.
- `transit` → **miles**, ~zero carbon here (no transit factor configured).
- Bike + ebike miles are summed into the **"miles not driven"** number.

A tab that is missing, unreachable, has the wrong headers, or has zero data rows is
**skipped**, and its dashboard panel is **hidden** (never an empty chart).

---

## Milestones tab

The original `milestones` URL pointed at the **same `gid` as `transport`** (wrong tab).
It's now fixed: `config.json → data_urls.milestones` points at the published CSV for the
milestones tab (`gid=728110704`) in the tracker workbook. That URL is public and returns
the correct `date, title, note` headers — it just has **no data rows yet**, so on a live
run `ingest.py` reports "no data rows" and **hides the Journey timeline** until you add
milestones to the sheet (graceful, no crash).

(The sample data already includes milestones, which is why the Journey tab renders in the
committed sample render.)

---

## How the metrics are derived

- **Household CO₂e (headline):** trailing 12 months vs the prior 12 months. Grouped
  GHG-Protocol style: **Scope 1** = natural gas + propane, **Scope 2** = electricity,
  and **Mobile** (transport) shown *separately* and explicitly **not** labeled a formal
  scope. The trend caveats itself when the prior window has < 12 months of data.
- **Energy → Site EUI:** delivered energy converted to kBtu (`config.energy_content_kbtu`)
  over the trailing 12 months, divided by `home_sqft`. If fewer than 12 months exist it's
  annualized and flagged with `*`.
- **Waste → diversion:** counts × container sizes → gallons;
  `diversion = (recycle_gal + compost_gal) / total_gal`. Labeled a **trend indicator**,
  not a precise %, because volume ≠ mass.
- **Garden:** cumulative pounds by crop and by meteorological season.
- **Transport:** per-mode amount + emissions, total **miles not driven** (bike + ebike), and
  **avoided emissions** = miles_not_driven ÷ `transport.avoided_vehicle_mpg` × gasoline factor.
- **Energy graph:** every fuel is converted to one common unit (**kBtu**) so the stacked
  bars show what we actually use most.
- **Emissions pie:** trailing-12 CO₂e split by source (electricity / natural gas / propane /
  gasoline), each tagged with its GHG-Protocol grouping.
- **"How we compare":** annual footprint and Site EUI vs editable benchmarks in
  `config.json → benchmarks` (`a typical home` — EIA RECS EUI + EPA home/vehicle figures).
  Clearly framed as rough benchmarks, not precise rankings.
- **Sustainability pet 🌱 (eco-score):** a 0–100 score blended from the available metrics
  (emissions trend, waste diversion, miles not driven, energy intensity vs benchmark). It
  drives the cute plant-buddy's mood and tip. Only scores domains that have data.
- **Ideas note:** `config.json → notes.future_actions` renders as a 💡 callout (e.g. the
  Xcel Windsource suggestion to offset Scope 2 electricity).

---

## Emission factors & sources

All factors live in `config.json → emission_factors`, with full citations in
`config.json → _sources` (JSON has no comments, so provenance lives there). Summary —
**verify these against the cited EPA documents before trusting the numbers:**

| Factor | Value | Source |
|--------|-------|--------|
| Electricity | `0.5133 kg CO₂e/kWh` | EPA **eGRID2022**, **RMPA (WECC Rockies)** subregion, CO₂e total output rate 1,131.7 lb/MWh. **Confirm your utility is in the RMPA subregion.** |
| Natural gas | `5.30 kg CO₂/therm` | EPA GHG Equivalencies / Emission Factors Hub 2025 (0.0053 mt CO₂/therm). |
| Propane | `5.72 kg CO₂/gal` | EPA GHG Emission Factors Hub 2025, Stationary Combustion. |
| Gasoline | `8.887 kg CO₂/gal` | EPA (8,887 g CO₂/gal); EPA/DOT 2010 rulemaking, IPCC 2006. |

---

## Constraints honored

- No data-entry UI, no database, no server required to view.
- Static page; vanilla JS + Chart.js (vendored & pinned in `assets/`); no build step,
  no framework, no `localStorage`.
- Minimal, pinned Python dependency (`pandas`), used only by the ingestion script.
- Optional domains: empty/missing tabs are hidden, not rendered as empty charts.
