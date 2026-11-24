#!/usr/bin/env python3
"""Refresh data/economy.json for the Economic Chart Portfolio page.

Pulls every series from FRED's public CSV download
(https://fred.stlouisfed.org/graph/fredgraph.csv), which needs no API key,
and writes them in the shape the page expects. Uses only the Python
standard library.

    python3 scripts/update_economy_data.py

The series list mirrors Smardash (indicators.go, main.go, shading.go).
Metro series IDs can't be derived from CBSA codes, so the first run reads
them from FRED's release tables and saves them in data/metro_series.json.
Later runs reuse that file; pass --refresh-metros to rebuild it.
"""

import csv
import io
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "economy.json"
METRO_CACHE = ROOT / "data" / "metro_series.json"
STATE_SHAPES = ROOT / "data" / "shapes" / "state_shapes.json"
METRO_SHAPES = ROOT / "data" / "shapes" / "metro_shapes.json"

FRED = "https://fred.stlouisfed.org"
NATIONAL_START = "2000-01-01"
REGIONAL_START = "2019-01-01"
BATCH = 12  # the CSV download returns at most 12 series per request

# Personal periods shaded on every time chart (inclusive start, exclusive end).
PERSONAL_PERIODS = [("At the Fed", "2022-06-30", "2025-07-25")]

# ---------------------------------------------------------------- national
# dataset -> [(column, series, transformation, quarterly)]
NATIONAL = {
    "cpi_monthly": [("cpi_yoy", "CPIAUCSL", "pc1", False), ("core_yoy", "CPILFESL", "pc1", False),
                    ("cpi_ann", "CPIAUCSL", "pca", False), ("core_ann", "CPILFESL", "pca", False)],
    "cpi_quarterly": [("cpi_yoy", "CPIAUCSL", "pc1", True), ("core_yoy", "CPILFESL", "pc1", True),
                      ("cpi_ann", "CPIAUCSL", "pca", True), ("core_ann", "CPILFESL", "pca", True)],
    "gdp_contrib": [("gdp", "A191RL1Q225SBEA", "lin", False), ("consumption", "DPCERY2Q224SBEA", "lin", False),
                    ("investment", "A006RY2Q224SBEA", "lin", False), ("net_exports", "A019RY2Q224SBEA", "lin", False),
                    ("government", "A822RY2Q224SBEA", "lin", False)],
    "unemp_monthly": [("u3", "UNRATE", "lin", False), ("u6", "U6RATE", "lin", False)],
    "unemp_quarterly": [("u3", "UNRATE", "lin", True), ("u6", "U6RATE", "lin", True)],
}

# ---------------------------------------------------------------- indicators
# (id, group, title, note, transformation, unit, scale, decimals, freq, ref, ref_label)
INDICATORS = [
    ("PSAVERT", "Household finances", "Personal saving rate", "Share of disposable income saved. BEA.", "lin", "%", 1, 1, "M", None, ""),
    ("DSPIC96", "Household finances", "Real disposable income", "Change from a year earlier, inflation-adjusted. BEA.", "pc1", "%", 1, 1, "M", 0, ""),
    ("RSFSXMV", "Household finances", "Retail sales ex autos and gas", "Change from a year earlier, not inflation-adjusted. Census.", "pc1", "%", 1, 1, "M", 0, ""),
    ("TOTALSL", "Household finances", "Consumer credit outstanding", "Change from a year earlier. Federal Reserve G.19.", "pc1", "%", 1, 1, "M", 0, ""),
    ("TDSP", "Household finances", "Household debt service ratio", "Debt payments as a share of disposable income. Federal Reserve.", "lin", "%", 1, 2, "Q", None, ""),
    ("DRCCLACBS", "Household finances", "Credit card delinquency rate", "All commercial banks. Federal Reserve.", "lin", "%", 1, 2, "Q", None, ""),
    ("UMCSENT", "Household finances", "Consumer sentiment", "Index, 1966 Q1 = 100. University of Michigan.", "lin", "", 1, 1, "M", None, ""),
    ("MICH", "Household finances", "Expected inflation, next 12 months", "Median household expectation. University of Michigan.", "lin", "%", 1, 1, "M", None, ""),

    ("PCEPILFE", "Underlying inflation", "Core PCE inflation", "Change from a year earlier, ex food and energy. The Fed's target measure. BEA.", "pc1", "%", 1, 1, "M", 2, "2% target"),
    ("PCETRIM12M159SFRBDAL", "Underlying inflation", "Trimmed mean PCE inflation", "12-month rate, dropping the most extreme price changes. Dallas Fed.", "lin", "%", 1, 1, "M", 2, "2%"),
    ("CORESTICKM159SFRBATL", "Underlying inflation", "Sticky-price core CPI", "12-month rate for prices that change slowly. Atlanta Fed.", "lin", "%", 1, 1, "M", None, ""),
    ("CUSR0000SAH1", "Underlying inflation", "Shelter inflation", "CPI shelter, change from a year earlier. BLS.", "pc1", "%", 1, 1, "M", None, ""),

    ("LNS12300060", "Labor market", "Prime-age employment rate", "Share of people aged 25–54 with a job. BLS.", "lin", "%", 1, 1, "M", None, ""),
    ("JTSJOL", "Labor market", "Job openings", "Millions, JOLTS. BLS.", "lin", "M", 0.001, 2, "M", None, ""),
    ("JTSQUR", "Labor market", "Quits rate", "Quits as a share of employment, JOLTS. BLS.", "lin", "%", 1, 1, "M", None, ""),
    ("ICSA", "Labor market", "Initial jobless claims", "Weekly, thousands, seasonally adjusted. Labor Department.", "lin", "K", 0.001, 0, "W", None, ""),
    ("CCSA", "Labor market", "Continuing jobless claims", "Weekly, millions, seasonally adjusted. Labor Department.", "lin", "M", 0.000001, 2, "W", None, ""),
    ("FRBATLWGT3MMAUMHWGO", "Labor market", "Wage growth tracker", "Median 12-month wage growth of individuals, 3-month average. Atlanta Fed.", "lin", "%", 1, 1, "M", None, ""),
    ("ECIWAG", "Labor market", "Employment Cost Index: wages", "Private industry, change from a year earlier. BLS.", "pc1", "%", 1, 1, "Q", None, ""),

    ("DCICLAIMS", "DC and federal jobs", "DC initial jobless claims", "Weekly, not seasonally adjusted. Labor Department.", "lin", "", 1, 0, "W", None, ""),
    ("DCUR", "DC and federal jobs", "DC unemployment rate", "Seasonally adjusted. BLS.", "lin", "%", 1, 1, "M", None, ""),
    ("SMU11000009091000001", "DC and federal jobs", "Federal jobs located in DC", "Thousands, not seasonally adjusted. BLS.", "lin", "K", 1, 1, "M", None, ""),
    ("SMU11479009091000001", "DC and federal jobs", "Federal jobs in the DC metro", "Thousands, not seasonally adjusted. BLS.", "lin", "K", 1, 1, "M", None, ""),
    ("CES9091000001", "DC and federal jobs", "Federal jobs nationwide", "Millions, seasonally adjusted. BLS.", "lin", "M", 0.001, 3, "M", None, ""),

    ("DFF", "Rates and financial conditions", "Federal funds rate", "Effective rate, daily. Federal Reserve.", "lin", "%", 1, 2, "D", None, ""),
    ("SOFR", "Rates and financial conditions", "SOFR", "Secured overnight financing rate, daily. NY Fed.", "lin", "%", 1, 2, "D", None, ""),
    ("T10Y2Y", "Rates and financial conditions", "Yield curve: 10-year minus 2-year", "Daily. Below zero means inverted. Treasury.", "lin", " pp", 1, 2, "D", 0, "0"),
    ("T10Y3M", "Rates and financial conditions", "Yield curve: 10-year minus 3-month", "Daily. Below zero means inverted. Treasury.", "lin", " pp", 1, 2, "D", 0, "0"),
    ("BAMLH0A0HYM2", "Rates and financial conditions", "High-yield credit spread", "Option-adjusted spread over Treasuries, daily. ICE BofA (FRED carries only the last 3 years).", "lin", " pp", 1, 2, "D", None, ""),
    ("NFCI", "Rates and financial conditions", "Financial conditions index", "Weekly. Above zero is tighter than average. Chicago Fed.", "lin", "", 1, 2, "W", 0, "average"),

    ("MORTGAGE30US", "Housing", "30-year mortgage rate", "Weekly average. Freddie Mac.", "lin", "%", 1, 2, "W", None, ""),
    ("HOUST", "Housing", "Housing starts", "Thousands of units, annual rate. Census.", "lin", "K", 1, 0, "M", None, ""),
    ("PERMIT", "Housing", "Building permits", "Thousands of units, annual rate. Census.", "lin", "K", 1, 0, "M", None, ""),
    ("CSUSHPINSA", "Housing", "Home prices", "Case-Shiller national index, change from a year earlier. S&P.", "pc1", "%", 1, 1, "M", 0, ""),

    ("SAHMREALTIME", "Recession signals", "Sahm rule indicator", "Rise in the 3-month average unemployment rate above its low in the past year. Real-time.", "lin", " pp", 1, 2, "M", 0.5, "0.50 signal"),
    ("GDPNOW", "Recession signals", "GDPNow nowcast", "Atlanta Fed's running estimate of real GDP growth, annualized, for the latest quarter.", "lin", "%", 1, 1, "Q", 0, ""),
]

STATE_POSTAL = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
    "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
    "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT",
    "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
    "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
    "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY",
}

# FRED release 113 (metro area employment and unemployment): table ids for
# the unemployment rate, smoothed seasonally adjusted and not seasonally adjusted.
METRO_RELEASE, METRO_SA_TABLE, METRO_NSA_TABLE = 113, 181413, 180976


# ---------------------------------------------------------------- HTTP
def get(url, tries=4):
    last = None
    for attempt in range(tries):
        if attempt:
            time.sleep(2 + 3 * attempt)
        try:
            # Python's default User-Agent works; FRED drops some custom ones.
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read().decode("utf-8")
        except Exception as e:  # noqa: BLE001 - retry anything network-ish
            last = e
    raise RuntimeError(f"could not fetch {url}: {last}")


def fred_csv(ids, start, transformation=None, quarterly=False):
    """Return {series_id: {date: float|None}} for one or more series."""
    q = {"id": ",".join(ids), "cosd": ",".join([start] * len(ids))}
    if transformation and transformation != "lin":
        q["transformation"] = ",".join([transformation] * len(ids))
    if quarterly:
        q["fq"] = ",".join(["Quarterly"] * len(ids))
        q["fam"] = ",".join(["avg"] * len(ids))
    text = get(f"{FRED}/graph/fredgraph.csv?" + urllib.parse.urlencode(q, safe=","))
    rows = list(csv.reader(io.StringIO(text)))
    if not rows or rows[0][0] not in ("observation_date", "DATE"):
        raise RuntimeError(f"unexpected CSV for {ids}: {text[:200]}")
    # columns are named like CPIAUCSL or CPIAUCSL_PC1; match by name, never by position
    cols = {h.split("_")[0]: i for i, h in enumerate(rows[0]) if i}
    missing = [sid for sid in ids if sid not in cols]
    if missing:
        raise RuntimeError(f"FRED left out {missing} (it returns at most {BATCH} series per request)")
    out = {sid: {} for sid in ids}
    for row in rows[1:]:
        d = row[0]
        if d < start:
            continue
        for sid in ids:
            out[sid][d] = num(row[cols[sid]])
    return out


def num(v):
    v = (v or "").strip()
    if v in ("", "."):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def tidy(x):
    return None if x is None else float(f"{x:.6g}")


def trim_tail(rows, cols):
    """Drop trailing rows where every column is empty (e.g. a quarter in progress)."""
    while rows and all(rows[-1].get(c) is None for c in cols):
        rows.pop()
    return rows


# ---------------------------------------------------------------- pulls
def pull_national():
    out = {}
    for name, cols in NATIONAL.items():
        vals = []
        for col, sid, tr, quarterly in cols:
            vals.append(fred_csv([sid], NATIONAL_START, tr, quarterly)[sid])
        dates = sorted(set().union(*vals))
        rows = [{"date": d, **{c[0]: vals[i].get(d) for i, c in enumerate(cols)}} for d in dates]
        out[name] = trim_tail(rows, [c[0] for c in cols])
        print(f"  {name}: {len(out[name])} rows")
    return out


def pull_indicators():
    out = []
    for sid, group, title, note, tr, unit, scale, dec, freq, ref, ref_label in INDICATORS:
        series = fred_csv([sid], NATIONAL_START, tr)[sid]
        obs = []
        for d in sorted(series):
            v = series[d]
            if v is None:
                if freq == "D":
                    continue  # market holidays: skip rather than break the line
                obs.append([d, None])
            else:
                obs.append([d, tidy(v * scale)])
        while obs and obs[-1][1] is None:
            obs.pop()
        row = {"id": sid, "group": group, "title": title, "note": note, "unit": unit,
               "decimals": dec, "freq": freq, "obs": obs}
        if ref is not None:
            row["ref"], row["ref_label"] = ref, ref_label
        out.append(row)
    print(f"  indicators: {len(out)} series")
    return out


def pull_shading():
    rec = fred_csv(["USREC"], "1999-01-01")["USREC"]
    out, start, last = [], None, None
    for d in sorted(rec):
        on = rec[d] == 1
        if on and start is None:
            start = d
        if not on and start is not None:
            out.append({"kind": "recession", "label": "Recession", "start": start, "end": d})
            start = None
        last = d
    if start is not None:
        y, m = int(last[:4]), int(last[5:7]) + 1
        if m > 12:
            y, m = y + 1, 1
        out.append({"kind": "recession", "label": "Recession", "start": start, "end": f"{y:04d}-{m:02d}-01"})
    for label, s, e in PERSONAL_PERIODS:
        out.append({"kind": "personal", "label": label, "start": s, "end": e})
    return out


def month_range(start, end):
    y, m = int(start[:4]), int(start[5:7])
    out = []
    while f"{y:04d}-{m:02d}-01" <= end:
        out.append(f"{y:04d}-{m:02d}-01")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def pull_regional(areas, key, name_key):
    """areas: [{key: code, name_key: name, series_id: id}] -> compact {dates, areas}."""
    vals = {}
    ids = [a["series_id"] for a in areas]
    for i in range(0, len(ids), BATCH):
        vals.update(fred_csv(ids[i:i + BATCH], REGIONAL_START))
        time.sleep(0.5)
    last = max((d for s in vals.values() for d, v in s.items() if v is not None), default=REGIONAL_START)
    dates = month_range(REGIONAL_START, last)
    return {
        "dates": dates,
        "areas": [{key: a[key], name_key: a[name_key], "series_id": a["series_id"],
                   "rates": [vals[a["series_id"]].get(d) for d in dates]} for a in areas],
    }


def state_areas():
    shapes = json.loads(STATE_SHAPES.read_text())
    names = {s["fips"]: s["name"] for s in shapes}
    return [{"fips": f, "state": names.get(f, p), "series_id": p + "UR"} for f, p in sorted(STATE_POSTAL.items())]


def metro_areas(refresh=False):
    if METRO_CACHE.exists() and not refresh:
        cached = json.loads(METRO_CACHE.read_text())
        if cached:
            return cached
    print("  reading metro series IDs from FRED (one time, takes a few minutes)…")
    # every metro's smoothed seasonally adjusted series, from the per-state release tables
    top = get(f"{FRED}/release/tables?rid={METRO_RELEASE}&eid={METRO_SA_TABLE}")
    states = sorted(set(re.findall(r'eid=(\d+)"[^>]*aria-label="[^"]+? \d+ records"', top)) - {str(METRO_SA_TABLE)})
    sa = {}
    for eid in states:
        page = get(f"{FRED}/release/tables?rid={METRO_RELEASE}&eid={eid}")
        for sid, name in re.findall(r'<a href="/series/([A-Z0-9]+)"[^>]*>([^<]+)</a>', page):
            sa.setdefault(sid, name.strip())
        time.sleep(0.3)
    # each series page links its BLS twin, LAUMT{state FIPS}{CBSA code}..., which gives the map code
    shapes = json.loads(METRO_SHAPES.read_text())
    want = {m["code"] for m in shapes}
    areas, unmatched = [], []
    for sid, name in sorted(sa.items(), key=lambda kv: kv[1]):
        m = re.search(r"LAUMT\d{2}(\d{5})", get(f"{FRED}/series/{sid}"))
        time.sleep(0.2)
        if m and m.group(1) in want:
            areas.append({"code": m.group(1), "metro": name, "series_id": sid})
        else:
            unmatched.append((sid, name, m.group(1) if m else None))
    # fallback: a few pages have no BLS link; match those by name when the map label is unambiguous
    norm = lambda t: re.sub(r"[^a-z]", "", t.lower())
    labels = {}
    for sh in shapes:
        labels.setdefault(norm(sh["label"]), []).append(sh["code"])
    taken = {a["code"] for a in areas}
    for sid, name, code in unmatched:
        hits = labels.get(norm(name.split(", ")[0]), [])
        if len(hits) == 1 and hits[0] not in taken:
            areas.append({"code": hits[0], "metro": name, "series_id": sid})
            taken.add(hits[0])
            print(f"    matched {name} ({sid}) to CBSA {hits[0]} by name")
        else:
            print(f"    skipped {name} ({sid}): " + (f"CBSA {code} isn't on the map (discontinued area)" if code else "no CBSA code found"))
    areas.sort(key=lambda a: a["metro"])
    METRO_CACHE.write_text(json.dumps(areas, indent=1) + "\n")
    print(f"  saved {len(areas)} metro series IDs to {METRO_CACHE.relative_to(ROOT)}")
    return areas


def main():
    refresh = "--refresh-metros" in sys.argv
    t0 = time.time()
    print("Pulling from FRED (public CSV download, no key)…")
    datasets = pull_national()
    datasets["indicators"] = pull_indicators()
    datasets["shading"] = pull_shading()
    datasets["state_unemp"] = pull_regional(state_areas(), "fips", "state")
    print(f"  state_unemp: {len(datasets['state_unemp']['areas'])} states, through {datasets['state_unemp']['dates'][-1]}")
    datasets["metro_unemp"] = pull_regional(metro_areas(refresh), "code", "metro")
    print(f"  metro_unemp: {len(datasets['metro_unemp']['areas'])} metros, through {datasets['metro_unemp']['dates'][-1]}")
    out = {
        "meta": {"pulled_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
                 "seconds": round(time.time() - t0, 1), "source": "FRED, Federal Reserve Bank of St. Louis"},
        "datasets": datasets,
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB) in {out['meta']['seconds']} s")


if __name__ == "__main__":
    main()
