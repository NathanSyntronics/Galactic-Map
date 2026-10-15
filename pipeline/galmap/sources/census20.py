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

URL = "https://exoplanetarchive.ipac.caltech.edu/data/Contributed/20pcCensus/Kirkpatrick2024_20pcCensus_Table4_Parameters.csv"
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
    # -999 marks a missing value (only exactly that: proper motions can be below -998 mas/yr)
    return v.where(v != -999.0)


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


# For objects without a measured parallax the census notes often give an estimate:
# "Expected parallax is 64.2 mas", "Estimates are distance 17.6 pc", "d~19.9 pc", "at ~20 pc".
_EST_PLX = re.compile(r"[Ee]xpected parallax is (?:>=|≥|~)?\s*([\d.]+) mas")
_EST_DIST = re.compile(r"(?:\bd\s*~\s*|[Dd]istance(?: estimate)?(?: for [^.;()]*?)?(?: is)?\s+~?|\bat\s*~\s*)(\d+(?:\.\d+)?)\s*pc")
EST_REL_ERR = 0.15  # typical uncertainty of the spectrophotometric distances


def estimated_parallax(note: str) -> float:
    """Parallax (mas) implied by an estimate in the census notes, or NaN."""
    if not isinstance(note, str):
        return np.nan
    m = _EST_PLX.search(note)
    if m:
        return float(m.group(1))
    m = _EST_DIST.search(note)
    if m and 1.0 < float(m.group(1)) < 40.0:
        return 1000.0 / float(m.group(1))
    return np.nan


def _inherit(df: pd.DataFrame, parent: np.ndarray, cols: list[str]) -> None:
    """Rows lacking cols[0] take all of cols from their nearest ancestor that has it."""
    key = cols[0]
    vals = {c: df[c].to_numpy(dtype=float).copy() for c in cols}
    for i in range(len(df)):
        if np.isnan(vals[key][i]):
            p = parent[i]
            while p >= 0 and np.isnan(vals[key][p]):
                p = parent[p]
            if p >= 0:
                for c in cols:
                    vals[c][i] = vals[c][p]
    for c in cols:
        df[c] = vals[c]


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
    df["plx_estimated"] = 0.0
    _inherit(df, parent, ["ra", "dec", "epoch", "pmra", "pmdec"])
    est = raw["GeneralNotes"].map(estimated_parallax).to_numpy(float) if "GeneralNotes" in raw else np.full(n, np.nan)
    # a trigonometric parallax that is unusable ("poorly constrained") gives way to the estimate
    p0, e0 = df["plx"].to_numpy(float), df["plx_err"].to_numpy(float)
    poor = np.isfinite(p0) & ((p0 <= 0) | (e0 / np.where(p0 > 0, p0, 1.0) > 0.5)) & np.isfinite(est)
    df.loc[poor, "plx"] = est[poor]
    df.loc[poor, "plx_err"] = EST_REL_ERR * est[poor]
    df.loc[poor, "plx_estimated"] = 1.0
    own_plx = df["plx"].notna().to_numpy().copy()
    _inherit(df, parent, ["plx", "plx_err", "plx_estimated"])
    # still no parallax: use the estimate from the notes (and pass it on to the components)
    use = np.isnan(df["plx"].to_numpy(float)) & np.isfinite(est)
    df.loc[use, "plx"] = est[use]
    df.loc[use, "plx_err"] = EST_REL_ERR * est[use]
    df.loc[use, "plx_estimated"] = 1.0
    own_plx |= use
    _inherit(df, parent, ["plx", "plx_err", "plx_estimated"])
    df["plx_estimated"] = df["plx_estimated"] > 0
    _unify_tight_systems(df, parent, own_plx)
    log.info("20 pc census: %d objects placed by an estimated distance", int((df["plx_estimated"] & df["is_leaf"]).sum()))

    _propagate_to_primary_leaf(df, parent)

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


def _leaf_component(name: str) -> str | None:
    m = re.search(r"\s([A-H][a-c]?)$", name)
    return m.group(1) if m else None


def _propagate_to_primary_leaf(df: pd.DataFrame, parent: np.ndarray) -> None:
    """Names and HIP numbers given only on a system row ("alpha CMi AB": Procyon (A), * alf CMi,
    HIP 37279) are moved to the component they belong to: the one named in a "(A)"-style marker,
    otherwise the first (primary) leaf below the system row."""
    n = len(df)
    children: dict[int, list[int]] = {}
    for i in range(n):
        if parent[i] >= 0:
            children.setdefault(int(parent[i]), []).append(i)

    def leaves_below(i: int) -> list[int]:
        out, stack = [], [i]
        while stack:
            k = stack.pop()
            ch = children.get(k)
            if not ch:
                out.append(k)
            else:
                stack.extend(reversed(ch))
        return out

    is_leaf = df["is_leaf"].to_numpy()
    moved = 0
    for i in np.nonzero(~is_leaf)[0]:
        leaves = leaves_below(int(i))
        if not leaves:
            continue
        cn = df.at[i, "common_name"]
        target = leaves[0]
        if isinstance(cn, str):
            m = re.search(r"\(([A-H][a-c]?)\)\s*$", cn)
            if m:
                for lf in leaves:
                    if _leaf_component(df.at[lf, "census_name"]) == m.group(1):
                        target = lf
                        break
        for col in ("common_name", "bayer_flamsteed", "var_name", "hd_name", "hr_name"):
            v = df.at[i, col]
            if isinstance(v, str) and not isinstance(df.at[target, col], str):
                df.at[target, col] = v
                moved += 1
        h = df.at[i, "hip"]
        if pd.notna(h) and pd.isna(df.at[target, "hip"]) and not (df["hip"] == h).fillna(False).to_numpy(bool)[leaves].any():
            df.at[target, "hip"] = h
    log.debug("census: %d system-level names moved to components", moved)


TIGHT_SYSTEM_AU = 2000.0


def _unify_tight_systems(df: pd.DataFrame, parent: np.ndarray, own_plx: np.ndarray) -> None:
    """Components of a tight system (all leaves within TIGHT_SYSTEM_AU in projection) are placed at
    one common distance. Their individual parallaxes are often perturbed by the orbital motion or
    mix Hipparcos and Gaia values, which would put components a few au apart light-years apart in
    depth (Wolf 424 A/B: 231.1 vs 223.5 mas). The common value is the error-weighted mean when the
    measured parallaxes agree, otherwise the system row's own measurement or the most precise one."""
    n = len(df)
    children: dict[int, list[int]] = {}
    for i in range(n):
        if parent[i] >= 0:
            children.setdefault(int(parent[i]), []).append(i)
    is_leaf = df["is_leaf"].to_numpy()
    ra, dec = df["ra"].to_numpy(float), df["dec"].to_numpy(float)
    plx, err = df["plx"].to_numpy(float).copy(), df["plx_err"].to_numpy(float).copy()
    est = df["plx_estimated"].to_numpy(bool).copy()

    def leaves_below(i: int) -> list[int]:
        out, stack = [], [i]
        while stack:
            k = stack.pop()
            ch = children.get(k)
            if not ch:
                out.append(k)
            else:
                stack.extend(ch)
        return out

    unified = 0

    def visit(i: int) -> None:
        nonlocal unified
        leaves = [k for k in leaves_below(i) if is_leaf[k]]
        if len(leaves) >= 2 and np.isfinite(ra[leaves]).all():
            u = np.stack([np.cos(np.radians(dec[leaves])) * np.cos(np.radians(ra[leaves])),
                          np.cos(np.radians(dec[leaves])) * np.sin(np.radians(ra[leaves])),
                          np.sin(np.radians(dec[leaves]))], axis=1)
            sep = np.degrees(np.arccos(np.clip(u @ u.T, -1, 1))).max() * 3600.0
            p_med = np.nanmedian(plx[leaves])
            if np.isfinite(p_med) and p_med > 0 and sep * 1000.0 / p_med < TIGHT_SYSTEM_AU:
                meas = [k for k in leaves if own_plx[k] and not est[k] and np.isfinite(err[k]) and err[k] > 0]
                if meas:
                    p, e = plx[meas], err[meas]
                    w = 1.0 / e**2
                    mean = float((w * p).sum() / w.sum())
                    chi2 = float((((p - mean) / e) ** 2).sum()) / max(len(meas) - 1, 1)
                    if chi2 <= 4.0:
                        val, verr = mean, float(1.0 / np.sqrt(w.sum()))
                    elif own_plx[i] and np.isfinite(plx[i]) and np.isfinite(err[i]):
                        val, verr = plx[i], err[i]
                    else:
                        k = meas[int(np.argmin(e))]
                        val, verr = plx[k], err[k]
                    changed = [k for k in leaves if plx[k] != val]
                    plx[leaves], err[leaves], est[leaves] = val, verr, False
                    unified += len(changed)
                return
        for c in children.get(i, []):
            visit(c)

    for i in np.nonzero(parent < 0)[0]:
        visit(int(i))
    df["plx"], df["plx_err"], df["plx_estimated"] = plx, err, est
    log.info("20 pc census: %d components of tight systems moved to their system's common distance", unified)


def strip_component_note(name: str | None) -> str | None:
    """'Rigil Kentaurus (A)' -> 'Rigil Kentaurus'."""
    if not isinstance(name, str):
        return None
    return re.sub(r"\s*\([A-Za-z]{1,3}\)\s*$", "", name).strip() or None
