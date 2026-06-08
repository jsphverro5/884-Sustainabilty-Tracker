#!/usr/bin/env python3
"""
ingest.py — Household Sustainability Tracker ingestion (DISPLAY layer feed).

Pulls each Google-Sheet tab (published as CSV), validates + cleans it, computes
derived metrics, and writes a single normalized data.json (plus a data.js mirror
so the dashboard works from file:// with no server). Idempotent and re-runnable.

Usage
-----
  python3 ingest.py                 # pull live CSVs from config.json -> data_urls
  python3 ingest.py --sample        # build from bundled ./sample/*.csv (offline)
  python3 ingest.py --source DIR    # build from a local folder of <tab>.csv files
  python3 ingest.py --config config.json --out data.json

Design rules
------------
- Blank cells mean "no data," NOT zero. They stay null all the way to the JSON.
- Domains are OPTIONAL. A tab that is missing, unreachable, has the wrong headers,
  or has zero valid data rows is skipped and reported in "warnings"; its dashboard
  panel is hidden (the JSON simply marks present=false).
- Nothing about carbon math is hardcoded here — every factor comes from config.json.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

# Exact expected headers per tab (the contract with the Google Sheet).
EXPECTED = {
    "energy":     ["month", "electricity_kWh", "natural_gas_therms", "propane_gal"],
    "waste":      ["date", "trash_bags", "recycle_loads", "compost_fills", "note"],
    "garden":     ["date", "crop", "weight_lbs", "note"],
    "transport":  ["date", "mode", "amount", "note"],
    "milestones": ["date", "title", "note"],
    "water":      ["month", "water_amount"],
}

ROUND = 2


class Warnings(list):
    def add(self, msg: str) -> None:
        print(f"  ! {msg}", file=sys.stderr)
        self.append(msg)


# --------------------------------------------------------------------------- #
# Loading & validation
# --------------------------------------------------------------------------- #
def load_csv(tab: str, location: str, warn: Warnings) -> pd.DataFrame | None:
    """Read one tab's CSV. Returns a cleaned DataFrame of valid rows, or None."""
    try:
        # keep_default_na keeps empties as NaN; we never coerce NaN -> 0.
        df = pd.read_csv(location, dtype=str, keep_default_na=True, skip_blank_lines=True)
    except Exception as exc:  # missing file, network error, empty file, etc.
        warn.add(f"[{tab}] could not read CSV ({exc.__class__.__name__}: {exc}). "
                 f"Skipping — its panel will be hidden.")
        return None

    df.columns = [c.strip() for c in df.columns]
    expected = EXPECTED[tab]
    missing = [c for c in expected if c not in df.columns]
    if missing:
        warn.add(f"[{tab}] headers do not match the expected schema "
                 f"(missing {missing}; found {list(df.columns)}). "
                 f"Skipping — its panel will be hidden.")
        return None

    df = df[expected].copy()
    # Trim every string cell; turn '' into NaN so blanks stay 'no data'.
    for c in df.columns:
        df[c] = df[c].map(lambda v: v.strip() if isinstance(v, str) else v)
        df[c] = df[c].replace({"": pd.NA})

    # Drop rows that are entirely blank.
    df = df.dropna(how="all")
    if df.empty:
        warn.add(f"[{tab}] no data rows yet. Skipping — its panel will be hidden.")
        return None
    return df


def to_num(series: pd.Series) -> pd.Series:
    """Coerce to float; non-numeric and blanks become NaN (i.e. 'no data')."""
    return pd.to_numeric(series, errors="coerce")


def _parse_dt(series: pd.Series, tab: str, warn: Warnings, label: str) -> pd.Series:
    """Tolerant date parsing. Google Sheets exports vary (YYYY-MM vs YYYY/MM,
    sometimes with a day), so we normalize separators and parse flexibly rather
    than dropping rows over a slash. Truly unparseable values are flagged."""
    s = (series.astype("string").str.strip()
         .str.replace("/", "-", regex=False)
         .replace({"": pd.NA, "nan": pd.NA, "NaT": pd.NA, "None": pd.NA}))
    dt = pd.to_datetime(s, format="mixed", errors="coerce")
    bad = int((dt.isna() & s.notna()).sum())
    if bad:
        warn.add(f"[{tab}] {bad} row(s) had an unparseable {label}; dropped.")
    return dt


def parse_month(series: pd.Series, tab: str, warn: Warnings) -> pd.Series:
    return _parse_dt(series, tab, warn, "month (expected YYYY-MM)")


def parse_date(series: pd.Series, tab: str, warn: Warnings) -> pd.Series:
    return _parse_dt(series, tab, warn, "date (expected YYYY-MM-DD)")


def jnum(x):
    """JSON-safe number: NaN/None -> None, else rounded float (or int if whole)."""
    if x is None or (isinstance(x, float) and pd.isna(x)):
        return None
    f = round(float(x), ROUND)
    return int(f) if f == int(f) else f


# --------------------------------------------------------------------------- #
# Domain processors  (each returns a dict; present=False means panel hidden)
# --------------------------------------------------------------------------- #
def process_energy(df, cfg, warn):
    ef = cfg["emission_factors"]
    ec = cfg["energy_content_kbtu"]
    df = df.assign(_m=parse_month(df["month"], "energy", warn)).dropna(subset=["_m"])
    if df.empty:
        return {"present": False}
    df = df.sort_values("_m")
    for c in ("electricity_kWh", "natural_gas_therms", "propane_gal"):
        df[c] = to_num(df[c])
    df = df.drop_duplicates(subset="_m", keep="last")

    elec, gas, prop = df["electricity_kWh"], df["natural_gas_therms"], df["propane_gal"]
    # Per-fuel emissions (kept separate so the dashboard can show a source pie).
    elec_ghg = elec * ef["electricity_kgCO2e_per_kWh"]                    # Scope 2
    gas_ghg = gas * ef["natural_gas_kgCO2_per_therm"]                     # Scope 1
    prop_ghg = prop * ef["propane_kgCO2_per_gal"]                         # Scope 1
    scope2 = elec_ghg
    scope1 = gas_ghg.fillna(0) + prop_ghg.fillna(0)
    scope1 = scope1.where(~(gas.isna() & prop.isna()))                   # all-blank -> NaN
    monthly = scope1.fillna(0) + scope2.fillna(0)
    monthly = monthly.where(~(scope1.isna() & scope2.isna()))

    months = df["_m"].dt.strftime("%Y-%m").tolist()

    # Per-fuel energy in kBtu — one common unit so the graph shows what dominates.
    elec_kbtu = elec * ec["electricity_kbtu_per_kWh"]
    gas_kbtu = gas * ec["natural_gas_kbtu_per_therm"]
    prop_kbtu = prop * ec["propane_kbtu_per_gal"]
    kbtu = elec_kbtu.fillna(0) + gas_kbtu.fillna(0) + prop_kbtu.fillna(0)

    # Site EUI over the trailing 12 months that carry energy data.
    last12 = df["_m"] > (df["_m"].max() - pd.DateOffset(months=12))
    k12 = kbtu[last12]
    n = int(last12.sum())
    sqft = cfg["home_sqft"]
    annualized = n < 12
    eui_val = ((k12.sum() / n) * 12 / sqft) if (n and annualized) else (k12.sum() / sqft if n else None)

    bench = cfg.get("benchmarks", {}).get("residential_site_eui_kbtu_per_sqft_yr")
    eui_delta_pct = (round((eui_val - bench) / bench * 100, 1)
                     if (eui_val is not None and bench) else None)

    return {
        "present": True,
        "months": months,
        "electricity_kWh": [jnum(v) for v in elec],
        "natural_gas_therms": [jnum(v) for v in gas],
        "propane_gal": [jnum(v) for v in prop],
        "electricity_kbtu": [jnum(v) for v in elec_kbtu],
        "natural_gas_kbtu": [jnum(v) for v in gas_kbtu],
        "propane_kbtu": [jnum(v) for v in prop_kbtu],
        "monthly_ghg_kg": [jnum(v) for v in monthly],
        "scope1_kg": [jnum(v) for v in scope1],
        "scope2_kg": [jnum(v) for v in scope2],
        "_series": {  # internal: month -> per-fuel emissions for the rollup + pie
            m: {"elec": None if pd.isna(e) else float(e),
                "gas": None if pd.isna(g) else float(g),
                "propane": None if pd.isna(p) else float(p)}
            for m, e, g, p in zip(months, elec_ghg, gas_ghg, prop_ghg)
        },
        "eui": {
            "value": jnum(eui_val),
            "unit": "kBtu/sqft/yr",
            "months_counted": n,
            "annualized": annualized,
            "benchmark": bench,
            "benchmark_label": cfg.get("benchmarks", {}).get("region_label"),
            "delta_pct": eui_delta_pct,
        },
    }


def process_waste(df, cfg, warn):
    sizes = cfg["waste_container_gal"]
    df = df.assign(_d=parse_date(df["date"], "waste", warn)).dropna(subset=["_d"])
    if df.empty:
        return {"present": False}
    for c in ("trash_bags", "recycle_loads", "compost_fills"):
        df[c] = to_num(df[c])
    df["trash_gal"] = df["trash_bags"].fillna(0) * sizes["trash_bag_gal"]
    df["recycle_gal"] = df["recycle_loads"].fillna(0) * sizes["recycle_load_gal"]
    df["compost_gal"] = df["compost_fills"].fillna(0) * sizes["compost_caddy_gal"]
    df["_m"] = df["_d"].dt.to_period("M").astype(str)

    g = df.groupby("_m")[["trash_gal", "recycle_gal", "compost_gal"]].sum().sort_index()
    total = g.sum(axis=1)
    diversion = (g["recycle_gal"] + g["compost_gal"]) / total.where(total > 0)

    grand = g.sum()
    grand_total = float(grand.sum())
    overall = (float(grand["recycle_gal"] + grand["compost_gal"]) / grand_total) if grand_total else None

    return {
        "present": True,
        "months": list(g.index),
        "trash_gal": [jnum(v) for v in g["trash_gal"]],
        "recycle_gal": [jnum(v) for v in g["recycle_gal"]],
        "compost_gal": [jnum(v) for v in g["compost_gal"]],
        "total_gal": [jnum(v) for v in total],
        "monthly_diversion": [jnum(v) for v in diversion],
        "overall_diversion": jnum(overall),
    }


def _season_label(ts):
    y, mth = ts.year, ts.month
    if mth in (3, 4, 5):   return f"Spring {y}", y * 4 + 1
    if mth in (6, 7, 8):   return f"Summer {y}", y * 4 + 2
    if mth in (9, 10, 11): return f"Fall {y}",   y * 4 + 3
    label_year = y + 1 if mth == 12 else y       # Dec belongs to the next winter
    return f"Winter {label_year}", label_year * 4 + 0


def process_garden(df, cfg, warn):
    df = df.assign(_d=parse_date(df["date"], "garden", warn)).dropna(subset=["_d"])
    df["weight_lbs"] = to_num(df["weight_lbs"])
    df = df.dropna(subset=["weight_lbs"])
    df["crop"] = df["crop"].fillna("(unspecified)")
    if df.empty:
        return {"present": False}

    by_crop = (df.groupby("crop")["weight_lbs"].sum()
               .sort_values(ascending=False))
    seasons = df["_d"].map(_season_label)
    df["_season"] = [s[0] for s in seasons]
    df["_sk"] = [s[1] for s in seasons]
    season_g = (df.groupby(["_sk", "_season"])["weight_lbs"].sum()
                .reset_index().sort_values("_sk"))

    return {
        "present": True,
        "total_lbs": jnum(df["weight_lbs"].sum()),
        "by_crop": [{"crop": c, "lbs": jnum(v)} for c, v in by_crop.items()],
        "by_season": [{"season": r["_season"], "lbs": jnum(r["weight_lbs"])}
                      for _, r in season_g.iterrows()],
    }


def process_transport(df, cfg, warn):
    t = cfg["transport"]
    ef = cfg["emission_factors"]
    df = df.assign(_d=parse_date(df["date"], "transport", warn)).dropna(subset=["_d"])
    df["amount"] = to_num(df["amount"])
    df["mode"] = df["mode"].fillna("").str.strip().str.lower()
    df = df[(df["mode"] != "") & df["amount"].notna()]
    if df.empty:
        return {"present": False}

    def row_ghg(r):
        if r["mode"] in t["fuel_modes"]:
            return r["amount"] * ef[t["fuel_modes"][r["mode"]]]
        return 0.0  # miles modes (bike/ebike/transit) carry no factor here

    def row_unit(mode):
        if mode in t["fuel_modes"]:
            return "gal"
        if mode in t["miles_modes"]:
            return "mi"
        return "unit"

    df["_ghg"] = df.apply(row_ghg, axis=1)
    df["_m"] = df["_d"].dt.to_period("M").astype(str)

    by_mode = []
    for mode, sub in df.groupby("mode"):
        by_mode.append({
            "mode": mode,
            "unit": row_unit(mode),
            "amount": jnum(sub["amount"].sum()),
            "ghg_kg": jnum(sub["_ghg"].sum()),
            "is_miles": mode in t["miles_modes"],
        })
    by_mode.sort(key=lambda d: (d["ghg_kg"] or 0), reverse=True)

    miles_not_driven = df.loc[df["mode"].isin(t["miles_not_driven_modes"]), "amount"].sum()
    monthly = df.groupby("_m")["_ghg"].sum()

    # Avoided emissions: gas those bike/ebike miles would have burned in the car.
    mpg = t.get("avoided_vehicle_mpg")
    avoided = (miles_not_driven / mpg * ef["gasoline_kgCO2_per_gal"]) if mpg else None

    return {
        "present": True,
        "by_mode": by_mode,
        "total_ghg_kg": jnum(df["_ghg"].sum()),
        "miles_not_driven": jnum(miles_not_driven),
        "avoided_co2e_kg": jnum(avoided),
        "avoided_basis_mpg": mpg,
        "_series": {m: float(v) for m, v in monthly.items()},  # internal rollup
    }


def process_milestones(df, cfg, warn):
    df = df.assign(_d=parse_date(df["date"], "milestones", warn)).dropna(subset=["_d"])
    df = df[df["title"].notna()]
    if df.empty:
        return {"present": False}
    df = df.sort_values("_d")
    events = [{
        "date": d.strftime("%Y-%m-%d"),
        "title": str(title),
        "note": (None if pd.isna(note) else str(note)),
    } for d, title, note in zip(df["_d"], df["title"], df["note"])]
    return {"present": True, "events": events}


def process_water(df, cfg, warn):
    # Parked for now; present only if real rows exist.
    df = df.assign(_m=parse_month(df["month"], "water", warn)).dropna(subset=["_m"])
    df["water_amount"] = to_num(df["water_amount"])
    df = df.dropna(subset=["water_amount"])
    if df.empty:
        return {"present": False}
    df = df.sort_values("_m")
    return {
        "present": True,
        "months": df["_m"].dt.strftime("%Y-%m").tolist(),
        "water_amount": [jnum(v) for v in df["water_amount"]],
    }


PROCESSORS = {
    "energy": process_energy,
    "waste": process_waste,
    "garden": process_garden,
    "transport": process_transport,
    "milestones": process_milestones,
    "water": process_water,
}


# --------------------------------------------------------------------------- #
# Eco-score — the "brain" for the sustainability pet (Tamagotchi)
# --------------------------------------------------------------------------- #
def compute_eco_score(domains, summary, cfg):
    """Blend the available metrics into a 0-100 score + a cute pet state.

    Only scores domains that have data, then renormalizes — so a household with
    just energy still gets a fair score. Each factor is mapped to 0..1.
    """
    def clamp01(x):
        return max(0.0, min(1.0, x))

    factors = []  # (label, value 0..1, friendly tip when low)

    # Emissions trend: going down is good. Only counts with a real prior baseline
    # (a partial prior window makes the % misleading, so skip it then).
    prior = summary.get("prior_12") if summary else None
    reliable_prior = bool(prior and prior["window"]["months_counted"] >= 6)
    if summary and summary.get("trend_pct") is not None and reliable_prior:
        t = summary["trend_pct"]
        factors.append(("Lowering emissions", clamp01(0.5 - t / 40.0),
                        "Trim the biggest source to bend the trend down."))

    # Waste diversion.
    w = domains.get("waste", {})
    if w.get("present") and w.get("overall_diversion") is not None:
        factors.append(("Diverting waste", clamp01(w["overall_diversion"] / 0.6),
                        "Recycle and compost more to divert from the landfill."))

    # Miles not driven (bike/ebike).
    tr = domains.get("transport", {})
    if tr.get("present") and tr.get("miles_not_driven") is not None:
        factors.append(("Riding, not driving", clamp01(tr["miles_not_driven"] / 500.0),
                        "Swap a few car trips for the bike or ebike."))

    # Energy intensity vs benchmark (lower EUI is better).
    e = domains.get("energy", {})
    eui = e.get("eui", {}) if e.get("present") else {}
    if eui.get("value") is not None and eui.get("benchmark"):
        ratio = eui["value"] / eui["benchmark"]
        factors.append(("Efficient home", clamp01((1.2 - ratio) / 0.4),
                        "Tighten up energy use to beat a typical home's intensity."))

    if not factors:
        return {"score": None, "stage": "seedling", "emoji": "\U0001F331",
                "title": "Plant me!", "message": "Add some data and I'll start to grow.",
                "factors": []}

    # With only one signal we can't fairly judge overall sustainability — show an
    # encouraging "getting started" state instead of a harsh verdict.
    if len(factors) < 2:
        return {"score": None, "stage": "seedling", "emoji": "\U0001F331",
                "title": "Just getting started",
                "message": "I only see one kind of data so far — add waste, garden, and "
                           "transport and I'll really come to life! 🌱",
                "factors": [{"label": l, "pct": round(v * 100)} for l, v, _ in factors]}

    score = round(sum(v for _, v, _ in factors) / len(factors) * 100)

    # Map score -> pet stage (a growing plant-buddy).
    if score >= 80:
        stage, emoji, title = "thriving", "\U0001F333", "Thriving!"          # deciduous tree
    elif score >= 60:
        stage, emoji, title = "happy", "\U0001F33F", "Happy & growing"        # herb
    elif score >= 40:
        stage, emoji, title = "sprouting", "\U0001F331", "Sprouting along"    # seedling
    elif score >= 20:
        stage, emoji, title = "thirsty", "\U0001FAB4", "A little thirsty"     # potted plant
    else:
        stage, emoji, title = "wilting", "\U0001F940", "Needs some love"      # wilted flower

    # Pick the weakest factor as the actionable tip.
    weakest = min(factors, key=lambda f: f[1])
    best = max(factors, key=lambda f: f[1])
    if score >= 80:
        message = f"You're crushing it — especially {best[0].lower()}. Keep it up!"
    else:
        message = weakest[2]

    return {
        "score": score,
        "stage": stage,
        "emoji": emoji,
        "title": title,
        "message": message,
        "factors": [{"label": l, "pct": round(v * 100)} for l, v, _ in factors],
    }


# --------------------------------------------------------------------------- #
# Household CO2e rollup (trailing 12 vs prior 12)
# --------------------------------------------------------------------------- #
def build_summary(energy, transport, cfg, warn):
    """Combine monthly energy (per-fuel) and mobile (transport) CO2e."""
    e_series = energy.get("_series", {}) if energy.get("present") else {}
    t_series = transport.get("_series", {}) if transport.get("present") else {}
    months = sorted(set(e_series) | set(t_series))
    if not months:
        return None

    def fuels(m):
        d = e_series.get(m, {})
        return d.get("elec"), d.get("gas"), d.get("propane")

    def month_total(m):
        e, g, p = fuels(m)
        mob = t_series.get(m)
        parts = [x for x in (e, g, p, mob) if x is not None]
        return sum(parts) if parts else None

    latest = pd.Period(months[-1], "M")

    def window(end_period, n=12):
        start = end_period - (n - 1)
        wmonths = [str(end_period - i) for i in range(n)]
        tot = elec = gas = prop = mob = 0.0
        counted = 0
        for m in wmonths:
            mt = month_total(m)
            if mt is None:
                continue
            counted += 1
            e, g, p = fuels(m)
            elec += e or 0; gas += g or 0; prop += p or 0
            mob += t_series.get(m, 0.0)
            tot += mt
        return {
            "total_kg": jnum(tot),
            "scope1_kg": jnum(gas + prop), "scope2_kg": jnum(elec), "mobile_kg": jnum(mob),
            "by_source": {"electricity": jnum(elec), "natural_gas": jnum(gas),
                          "propane": jnum(prop), "gasoline": jnum(mob)},
            "window": {"start": str(start), "end": str(end_period),
                       "months_counted": counted},
        }

    trailing = window(latest)
    prior_end = latest - 12
    prior = window(prior_end)
    has_prior = prior["window"]["months_counted"] > 0

    trend_pct = trend_dir = None
    if has_prior and prior["total_kg"]:
        trend_pct = round((trailing["total_kg"] - prior["total_kg"]) / prior["total_kg"] * 100, 1)
        trend_dir = "down" if trend_pct < -0.5 else "up" if trend_pct > 0.5 else "flat"

    # Emissions-by-source list for the pie (trailing-12, biggest first).
    src_labels = {"electricity": "Electricity", "natural_gas": "Natural gas",
                  "propane": "Propane", "gasoline": "Gasoline (transport)"}
    src_scope = {"electricity": "Scope 2", "natural_gas": "Scope 1",
                 "propane": "Scope 1", "gasoline": "Mobile"}
    by_source = [{"source": src_labels[k], "scope": src_scope[k], "kg": v}
                 for k, v in trailing["by_source"].items() if v]
    by_source.sort(key=lambda d: d["kg"], reverse=True)

    # Friendly "vs a typical home" comparison. Only count the benchmark pieces we
    # actually measure, so an energy-only dataset isn't compared against a
    # household that also includes a car (which would flatter us unfairly).
    b = cfg.get("benchmarks", {})
    comparison = None
    typ_total = 0
    scope_bits = []
    if e_series:
        typ_total += b.get("typical_home_energy_co2e_kg_per_yr", 0); scope_bits.append("home energy")
    if t_series:
        typ_total += b.get("typical_vehicle_co2e_kg_per_yr", 0); scope_bits.append("driving")
    typ_total = typ_total or None
    if typ_total and trailing["window"]["months_counted"] >= 1:
        mc = trailing["window"]["months_counted"]
        annual = trailing["total_kg"] * 12 / mc       # annualize partial windows
        comparison = {
            "region_label": b.get("region_label"),
            "your_annual_kg": jnum(annual),
            "typical_annual_kg": typ_total,
            "delta_pct": round((annual - typ_total) / typ_total * 100, 1),
            "annualized": mc < 12,
            "months_counted": mc,
            "covers": " + ".join(scope_bits),   # what the comparison includes
            "partial": len(scope_bits) < 2,     # true until both energy + transport exist
        }

    return {
        "trailing_12": trailing,
        "prior_12": prior if has_prior else None,
        "trend_pct": trend_pct,
        "trend_direction": trend_dir,
        "emissions_by_source": by_source,
        "comparison": comparison,
    }


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def resolve_location(tab, args, cfg):
    if args.sample:
        return str(Path(__file__).parent / "sample" / f"{tab}.csv"), "sample"
    if args.source:
        return str(Path(args.source) / f"{tab}.csv"), f"local:{args.source}"
    return cfg["data_urls"][tab], "live"


def main():
    ap = argparse.ArgumentParser(description="Build data.json for the sustainability dashboard.")
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--sample", action="store_true", help="use bundled ./sample/*.csv")
    ap.add_argument("--source", help="folder of local <tab>.csv files")
    ap.add_argument("--out", default="data.json")
    args = ap.parse_args()

    cfg_path = Path(args.config)
    cfg = json.loads(cfg_path.read_text())
    warn = Warnings()

    _, source_label = resolve_location("energy", args, cfg)
    print(f"Ingesting ({source_label}) ...", file=sys.stderr)

    domains = {}
    for tab, proc in PROCESSORS.items():
        location, _ = resolve_location(tab, args, cfg)
        df = load_csv(tab, location, warn)
        domains[tab] = proc(df, cfg, warn) if df is not None else {"present": False}

    summary = build_summary(domains["energy"], domains["transport"], cfg, warn)
    eco = compute_eco_score(domains, summary, cfg)

    # Strip internal-only keys before serializing.
    for d in domains.values():
        d.pop("_series", None)

    present = [k for k, v in domains.items() if v.get("present")]
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source_label,
        "config_echo": {
            "home_sqft": cfg["home_sqft"],
            "waste_container_gal": cfg["waste_container_gal"],
            "emission_factors": cfg["emission_factors"],
            "benchmarks": cfg.get("benchmarks", {}),
            "notes": cfg.get("notes", {}),
        },
        "domains_present": present,
        "summary": summary,
        "eco_score": eco,
        "warnings": list(warn),
        **domains,
    }

    out_path = Path(args.out)
    payload = json.dumps(out, indent=2)
    out_path.write_text(payload + "\n")
    # data.js mirror so index.html renders from file:// with no server.
    js_path = out_path.with_suffix(".js")
    js_path.write_text("window.__DASHBOARD_DATA__ = " + payload + ";\n")

    print(f"\nWrote {out_path} and {js_path}", file=sys.stderr)
    print(f"Domains present: {', '.join(present) or '(none)'}", file=sys.stderr)
    if summary:
        t = summary["trailing_12"]
        print(f"Trailing-12 CO2e: {t['total_kg']} kg "
              f"(scope1 {t['scope1_kg']}, scope2 {t['scope2_kg']}, mobile {t['mobile_kg']})",
              file=sys.stderr)
    if warn:
        print(f"{len(warn)} warning(s) — see above.", file=sys.stderr)


if __name__ == "__main__":
    main()
