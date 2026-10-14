"""The 20 pc census of stars and brown dwarfs (Kirkpatrick et al. 2024, ApJS 271, 55).

Table 4 lists every known object within 20 pc, decomposed hierarchically into systems and
components. Rows are ordered depth-first; the number of leading dashes in DefaultName gives
the depth ("alpha Cen AB & Proxima Cen" > "--alpha Cen AB" > "----alpha Cen A").
We return one row per *leaf* (an individual object or an unresolved multiple), with
missing astrometry inherited from the nearest ancestor, plus the non-leaf rows' Gaia/HIP ids
so that catalogue entries describing an unresolved pair can be replaced by the leaves.
"""

from __future__ import annotations

import logging
import re

import numpy as np
import pandas as pd

from ..download import CACHE_DIR, exact_int64, fetch

log = logging.getLogger(__name__)

URL = "https://exoplanetarchive.ipac.caltech.edu/data/ExoData/20pcCensus/Kirkpatrick2024_20pcCensus_Table4_Parameters.csv"
FILE = CACHE_DIR / "census20" / "Kirkpatrick2024_20pcCensus_Table4_Parameters.csv"

SOURCE_INFO = {
    "key": "census20",
    "title": "The 20 pc census of stars and brown dwarfs",
    "citation": "Kirkpatrick J. D. et al. 2024, ApJS 271, 55 (doi:10.3847/1538-4365/ad24e2); "
    "machine-readable table via the NASA Exoplanet Archive.",
    "url": "https://exoplanetarchive.ipac.caltech.edu/docs/20pcCensus.html",
    "license": "Published table (AAS); cite the paper",
}

# catalogue-designation columns that may serve as names (in display priority order)
NAME_COLUMNS = [
    "Wolf", "Ross", "L", "LP", "Giclas", "LHS", "LFT", "LTT", "NLTT", "LSPM", "SCR", "UPM", "APMPM", "LEHPM",
    "WT", "SIPS", "PM ", "PM J", "WD", "LAWD", "EGGR", "BD", "CD", "CPD", "2MASS", "WISE", "Karmn",
]


def _num(s: pd.Series) -> pd.Series:
    v = pd.to_numeric(s.str.strip().replace("", np.nan), errors="coerce")
    return v.where(v > -998)


def _prefixed_int(s: pd.Series, prefix: str) -> pd.Series:
    out = s.str.extract(rf"^{prefix}\s*(\d+)\s*$")[0]
    return exact_int64(out)


def _sexagesimal(ra: pd.Series, dec: pd.Series) -> tuple[np.ndarray, np.ndarray]:
    """'00 09 10.68518', '59 08 59.2120' -> degrees (NaN if unparsable)."""

    def parse(v: str, hours: bool) -> float:
        parts = v.replace("=", "").strip().split()
        if len(parts) != 3:
            return np.nan
        try:
            sign = -1.0 if parts[0].startswith("-") else 1.0
            d, m, sec = abs(float(parts[0])), float(parts[1]), float(parts[2])
        except ValueError:
            return np.nan
        val = sign * (d + m / 60 + sec / 3600)
        return val * 15.0 if hours else val

    return (
        np.array([parse(v, True) for v in ra], dtype=float),
        np.array([parse(v, False) for v in dec], dtype=float),
    )


def load(refresh: bool = False) -> pd.DataFrame:
    path = fetch(URL, FILE, refresh=refresh)
    raw = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8")
    raw = raw[raw["DefaultName"].str.strip() != ""].reset_index(drop=True)
    dashes = raw["DefaultName"].str.extract(r"^(-*)")[0].str.len().to_numpy()
    depth = dashes // 2
    n = len(raw)
    is_leaf = np.ones(n, bool)
    is_leaf[:-1] = depth[1:] <= depth[:-1]
    # parent index of every row (depth-first order)
    parent = np.full(n, -1)
    stack: list[int] = []
    for i in range(n):
        while stack and depth[stack[-1]] >= depth[i]:
            stack.pop()
        parent[i] = stack[-1] if stack else -1
        stack.append(i)
    root = np.arange(n)
    for i in range(n):
        r = i
        while parent[r] >= 0:
            r = parent[r]
        root[i] = r

    df = pd.DataFrame(
        {
            "census_row": np.arange(n),
            "census_name": raw["DefaultName"].str.lstrip("-").str.strip(),
            "depth": depth,
            "is_leaf": is_leaf,
            "parent_row": parent,
            "system_row": root,
            "n_comps_row": pd.to_numeric(raw["#CompsOnThisRow"], errors="coerce"),
            "common_name": raw["CommonName"].str.strip().replace("", pd.NA),
            "bayer_flamsteed": raw["Bayer/Flamsteed"].str.strip().replace("", pd.NA),
            "gaia": _prefixed_int(raw["Gaia"], r"Gaia [DE]*R\d"),
            "hip": _prefixed_int(raw["HIP"], "HIP"),
            "hd_name": raw["HD"].str.strip().replace("", pd.NA),
            "hr_name": raw["HR"].str.strip().replace("", pd.NA),
            "gj": raw["GJ"].str.strip().replace("", pd.NA),
            "var_name": raw["V*"].str.strip().replace("", pd.NA),
            "tyc": raw["TYC"].str.replace("TYC", "").str.strip().replace("", pd.NA),
            "ra": _num(raw["RA (deg)"]),
            "dec": _num(raw["Dec (deg)"]),
            "epoch": _num(raw["Epoch"]),
            "plx": _num(raw["Parallax (mas)"]),
            "plx_err": _num(raw["Parallax_unc (mas)"]),
            "pmra": _num(raw["PMRA (mas/yr)"]),
            "pmdec": _num(raw["PMDec (mas/yr)"]),
            "spt_opt": raw["SpecTypeOpt"].str.strip().replace("", pd.NA),
            "spt_nir": raw["SpecTypeNIR"].str.strip().replace("", pd.NA),
            "teff": _num(raw["Teff (K)"]),
            "mass": _num(raw["AdoptedInitialMass (Msun)"]),
            "wd_name": raw["WD"].str.strip().replace("", pd.NA),
            "gmag": _num(raw["G (mag)"]),
            "bp": _num(raw["G_BP (mag)"]),
            "rp": _num(raw["G_RP (mag)"]),
            "jmag": _num(raw["J2MASS (mag)"]).fillna(_num(raw["JMKO (mag)"])),
            "n_planets": _num(raw["#Planets"]),
        }
    )
    # decimal coordinates are missing for many rows; fall back to the sexagesimal columns
    sra, sdec = _sexagesimal(raw["SexagesimalRA"], raw["SexagesimalDec"])
    missing = df["ra"].isna().to_numpy()
    df.loc[missing, "ra"] = sra[missing]
    df.loc[missing, "dec"] = sdec[missing]
    df.loc[missing & df["epoch"].isna().to_numpy(), "epoch"] = 2000.0

    # other catalogue names as a list
    names = []
    for i in range(n):
        lst = []
        for c in NAME_COLUMNS:
            v = raw.at[i, c].strip() if c in raw else ""
            if v:
                lst.extend(x.strip() for x in v.split("|") if x.strip())
        names.append(lst)
    df["catalog_names"] = names

    # inherit astrometry from the nearest ancestor that has it
    for col_group in (["ra", "dec", "epoch", "pmra", "pmdec"], ["plx", "plx_err"]):
        key = col_group[0]
        vals = {c: df[c].to_numpy(dtype=float).copy() for c in col_group}
        for i in range(n):
            if np.isnan(vals[key][i]):
                p = parent[i]
                while p >= 0 and np.isnan(vals[key][p]):
                    p = parent[p]
                if p >= 0:
                    for c in col_group:
                        vals[c][i] = vals[c][p]
        for c in col_group:
            df[c] = vals[c]

    sun = df["census_name"].eq("Sun")
    df = df[~sun].copy()
    df["system_size"] = df.groupby("system_row")["is_leaf"].transform("sum")
    df["bp_rp"] = df["bp"] - df["rp"]
    spt = df["spt_nir"].fillna(df["spt_opt"])
    # optical types are preferred for stars, near-infrared types for L/T/Y dwarfs
    spt = np.where(df["spt_opt"].notna() & ~df["spt_opt"].fillna("").str.match(r"^\s*[LTY]"), df["spt_opt"], spt)
    df["spect"] = pd.Series(spt, index=df.index).replace("", pd.NA)
    bd_type = df["spect"].fillna("").str.match(r"^\s*(sd|esd|d)?[LTY]\d")
    df["brown_dwarf"] = bd_type | (df["spect"].isna() & (df["teff"] < 2200))
    df["white_dwarf"] = df["wd_name"].notna() | df["spect"].fillna("").str.match(r"^\s*D[ABOQZCX]")
    log.info(
        "20 pc census: %d rows, %d leaves, %d brown dwarfs, %d white dwarfs",
        len(df), int(df["is_leaf"].sum()), int((df["brown_dwarf"] & df["is_leaf"]).sum()), int((df["white_dwarf"] & df["is_leaf"]).sum()),
    )
    return df.reset_index(drop=True)


def strip_component_note(name: str | None) -> str | None:
    """'Rigil Kentaurus (A)' -> 'Rigil Kentaurus'."""
    if not isinstance(name, str):
        return None
    return re.sub(r"\s*\([A-Za-z]{1,3}\)\s*$", "", name).strip() or None
