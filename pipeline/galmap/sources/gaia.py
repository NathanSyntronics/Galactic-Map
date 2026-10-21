"""Gaia DR3 astrometry and photometry, and the Hipparcos new reduction, from the Gaia archive.

AT-HYG has Gaia DR3 ids and distances but no parallax errors, Gaia positions or BP-RP colours.
We fetch them
  * for the official Tycho-2 / Hipparcos cross-matches, in source_id range chunks small enough
    for synchronous TAP queries,
  * for all other Gaia ids that AT-HYG assigns (lists of ids per query),
  * for all stars of the Gaia Catalogue of Nearby Stars (joined on the server with the copy of
    GCNS in the archive), so that every Gaia parallax gets the same zero-point correction,
and the Hipparcos new reduction (van Leeuwen 2007) as the fallback for bright stars whose Gaia
solution is poor.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import pandas as pd

from ..download import CACHE_DIR, exact_int64, tap_sync

log = logging.getLogger(__name__)

GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap"
MAXREC = 1_000_000
CHUNK_ROWS = 25_000
MAX_SOURCE_ID = 6_917_528_997_577_384_320  # 2^35 * 12 * 4^12 (largest HEALPix level-12 index + 1)
COLUMNS = (
    "g.source_id, g.ra, g.dec, g.parallax, g.parallax_error, g.pmra, g.pmdec, g.ruwe, "
    "g.phot_g_mean_mag, g.bp_rp, g.nu_eff_used_in_astrometry, g.pseudocolour, g.ecl_lat, "
    "g.astrometric_params_solved"
)

TABLES = {
    "tycho2": "gaiadr3.tycho2tdsc_merge_best_neighbour",
    "hipparcos2": "gaiadr3.hipparcos2_best_neighbour",
    "gcns": "external.gaiaedr3_gcns_main_1",
}
# All Gaia DR3 stars in the shell beyond the GCNS (100 pc) out to about 200 pc (652 ly) whose
# parallax is measured to better than about 11 % (the final cut, after the zero point and the
# RUWE inflation of the error, is made in merge.add_gaia_field).
FIELD_MIN_PLX = 4.9
FIELD_MAX_PLX = 10.2
FIELD_WHERE = (
    f"g.parallax > {FIELD_MIN_PLX} AND g.parallax < {FIELD_MAX_PLX} AND g.parallax_over_error > 9 "
    "AND g.visibility_periods_used >= 10"
)
COUNTS = {
    "field200": "SELECT COUNT(*) AS n FROM gaiadr3.gaia_source AS g "
    f"WHERE g.source_id >= {{lo}} AND g.source_id < {{hi}} AND {FIELD_WHERE}",
}
QUERIES = {
    "field200": (
        "SELECT {cols} FROM gaiadr3.gaia_source AS g "
        f"WHERE g.source_id >= {{lo}} AND g.source_id < {{hi}} AND {FIELD_WHERE}"
    ),
    "gcns": (
        "SELECT {cols} FROM external.gaiaedr3_gcns_main_1 AS x "
        "JOIN gaiadr3.gaia_source AS g ON g.source_id = x.source_id "
        "WHERE x.source_id >= {lo} AND x.source_id < {hi}"
    ),
    "tycho2": (
        "SELECT x.original_ext_source_id AS tyc, {cols} FROM gaiadr3.tycho2tdsc_merge_best_neighbour AS x "
        "JOIN gaiadr3.gaia_source AS g ON g.source_id = x.source_id "
        "WHERE x.source_id >= {lo} AND x.source_id < {hi}"
    ),
    "hipparcos2": (
        "SELECT x.original_ext_source_id AS hip, {cols} FROM gaiadr3.hipparcos2_best_neighbour AS x "
        "JOIN gaiadr3.gaia_source AS g ON g.source_id = x.source_id "
        "WHERE x.source_id >= {lo} AND x.source_id < {hi}"
    ),
}


IDS_PER_QUERY = 2000
NUMERIC = (
    "ra", "dec", "parallax", "parallax_error", "pmra", "pmdec", "ruwe", "phot_g_mean_mag", "bp_rp",
    "nu_eff_used_in_astrometry", "pseudocolour", "ecl_lat", "astrometric_params_solved",
)
HIP_COLUMNS = "hip, ra, dec, plx, e_plx, pm_ra, pm_de, hp_mag, b_v"


def _count(name: str, lo: int, hi: int) -> int:
    if name in COUNTS:
        q = COUNTS[name].format(lo=lo, hi=hi)
    else:
        q = f"SELECT COUNT(*) AS n FROM {TABLES[name]} AS x WHERE x.source_id >= {lo} AND x.source_id < {hi}"
    return int(tap_sync(GAIA_TAP, q, timeout=300)["n"].iloc[0])


def _fetch_range(name: str, lo: int, hi: int) -> pd.DataFrame:
    """Fetch one source_id range, splitting it until each piece is small enough to arrive complete.

    The anonymous Gaia TAP service silently truncates large synchronous results, so every
    piece is checked against a COUNT(*) of the same range.
    """
    n = _count(name, lo, hi)
    if n == 0:
        return pd.DataFrame()
    if n > CHUNK_ROWS and hi - lo > 1:
        mid = lo + (hi - lo) // 2
        return pd.concat([_fetch_range(name, lo, mid), _fetch_range(name, mid, hi)], ignore_index=True)
    q = QUERIES[name].format(cols=COLUMNS, lo=lo, hi=hi)
    df = tap_sync(GAIA_TAP, q, timeout=900, maxrec=MAXREC)
    if len(df) != n:
        raise RuntimeError(f"Gaia {name} range [{lo}, {hi}): got {len(df)} rows, expected {n}")
    return df


def fetch_xmatch(name: str, chunks: int, cache: Path | None = None, refresh: bool = False) -> pd.DataFrame:
    cache = cache or CACHE_DIR / "gaia"
    out = cache / f"gaia_dr3_{name}.parquet"
    if out.exists() and not refresh:
        return pd.read_parquet(out)
    part_dir = cache / f"{name}_parts"
    part_dir.mkdir(parents=True, exist_ok=True)
    edges = [int(v) for v in np.linspace(0, MAX_SOURCE_ID, chunks + 1)]
    frames = []
    for i in range(chunks):
        part = part_dir / f"part{i:03d}.csv"
        if part.exists() and not refresh:
            df = pd.read_csv(part, dtype=str, keep_default_na=False)
        else:
            df = _fetch_range(name, edges[i], edges[i + 1])
            df.to_csv(part, index=False)
        log.info("gaia %s chunk %d/%d: %d rows", name, i + 1, chunks, len(df))
        if len(df):
            frames.append(df)
    df = _numeric(pd.concat(frames, ignore_index=True))
    if "hip" in df:
        df["hip"] = pd.to_numeric(df["hip"]).astype("Int64")
    df.to_parquet(out, index=False)
    return df


def _numeric(df: pd.DataFrame) -> pd.DataFrame:
    df["source_id"] = exact_int64(df["source_id"])
    for c in NUMERIC:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def fetch_ids(ids, cache: Path | None = None, refresh: bool = False) -> pd.DataFrame:
    """gaia_source rows for a list of source_ids (ids that do not exist in DR3 are simply absent).

    Results are cached together with the list of ids already asked for, so a changed id list only
    costs the queries for the new ids.
    """
    cache = cache or CACHE_DIR / "gaia"
    out = cache / "gaia_dr3_by_id.parquet"
    asked_file = cache / "gaia_dr3_by_id_asked.npy"
    ids = np.unique(np.asarray(ids, dtype=np.int64))
    have = pd.read_parquet(out) if out.exists() and not refresh else None
    asked = np.load(asked_file) if asked_file.exists() and have is not None else np.array([], dtype=np.int64)
    todo = np.setdiff1d(ids, asked)
    if len(todo):
        frames = [] if have is None else [have]
        for k in range(0, len(todo), IDS_PER_QUERY):
            chunk = todo[k : k + IDS_PER_QUERY]
            q = f"SELECT {COLUMNS} FROM gaiadr3.gaia_source AS g WHERE g.source_id IN ({','.join(str(int(v)) for v in chunk)})"
            df = tap_sync(GAIA_TAP, q, timeout=900, maxrec=MAXREC)
            if len(df) > len(chunk):
                raise RuntimeError(f"Gaia id query returned {len(df)} rows for {len(chunk)} ids")
            if len(df):
                frames.append(_numeric(df))
            log.info("gaia ids %d/%d: %d rows", min(k + IDS_PER_QUERY, len(todo)), len(todo), len(df))
        have = pd.concat(frames, ignore_index=True).drop_duplicates("source_id").reset_index(drop=True)
        cache.mkdir(parents=True, exist_ok=True)
        have.to_parquet(out, index=False)
        np.save(asked_file, np.union1d(asked, todo))
    return have if have is not None else pd.DataFrame(columns=["source_id", *NUMERIC])


def load_hipparcos(refresh: bool = False) -> pd.DataFrame:
    """Hipparcos new reduction (van Leeuwen 2007): hip, ra, dec (deg, epoch 1991.25), plx, e_plx (mas), ..."""
    out = CACHE_DIR / "gaia" / "hipparcos2007.parquet"
    if out.exists() and not refresh:
        return pd.read_parquet(out)
    frames = []
    for lo in range(0, 125_000, 25_000):
        hi = lo + 25_000
        cnt = int(tap_sync(GAIA_TAP, f"SELECT COUNT(*) AS n FROM public.hipparcos_newreduction WHERE hip >= {lo} AND hip < {hi}")["n"].iloc[0])
        df = tap_sync(GAIA_TAP, f"SELECT {HIP_COLUMNS} FROM public.hipparcos_newreduction WHERE hip >= {lo} AND hip < {hi}", timeout=900, maxrec=MAXREC)
        if len(df) != cnt:
            raise RuntimeError(f"Hipparcos range [{lo}, {hi}): got {len(df)} rows, expected {cnt}")
        frames.append(df)
    df = pd.concat(frames, ignore_index=True)
    for c in df.columns:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["hip"] = df["hip"].astype("int64")
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out, index=False)
    log.info("Hipparcos new reduction: %d stars", len(df))
    return df


def load_field(refresh: bool = False) -> pd.DataFrame:
    """Gaia DR3 stars between about 100 and 200 pc with precise parallaxes (see FIELD_WHERE), with
    the parallax zero point in 'parallax_zp'."""
    df = fetch_xmatch("field200", chunks=128, refresh=refresh)
    df["parallax_zp"] = parallax_zero_point(df)
    log.info("Gaia DR3 field stars 100-200 pc: %d", len(df))
    return df


def load(refresh: bool = False, extra_ids=None) -> pd.DataFrame:
    """Gaia DR3 rows (unique source_ids) for the Tycho-2 and Hipparcos cross-matches, the GCNS stars
    and any further ids (AT-HYG's own Gaia ids), with the parallax zero point in 'parallax_zp'."""
    tyc = fetch_xmatch("tycho2", chunks=48, refresh=refresh)
    hip = fetch_xmatch("hipparcos2", chunks=4, refresh=refresh)
    gcns = fetch_xmatch("gcns", chunks=16, refresh=refresh)
    cols = ["source_id", *NUMERIC]
    parts = [tyc[cols], hip[cols], gcns[cols]]
    if extra_ids is not None:
        known = pd.concat([p["source_id"] for p in parts]).to_numpy(dtype=np.int64)
        missing = np.setdiff1d(np.asarray(extra_ids, dtype=np.int64), known)
        if len(missing):
            parts.append(fetch_ids(missing, refresh=refresh)[cols])
    both = pd.concat(parts, ignore_index=True).drop_duplicates("source_id").reset_index(drop=True)
    both["parallax_zp"] = parallax_zero_point(both)
    log.info("Gaia DR3: %d sources (%d Tycho-2, %d Hipparcos, %d GCNS cross-matches)", len(both), len(tyc), len(hip), len(gcns))
    return both


def parallax_zero_point(df: pd.DataFrame) -> np.ndarray:
    """Gaia DR3 parallax zero point (Lindegren et al. 2021) per source; subtract it from the parallax.

    Falls back to the global QSO median of -0.017 mas outside the calibrated range.
    """
    zp = np.full(len(df), -0.017)
    try:
        from zero_point import zpt  # gaiadr3-zeropoint package
    except ImportError:  # pragma: no cover - optional dependency
        log.warning("gaiadr3-zeropoint not installed; using the global -0.017 mas zero point")
        return zp
    zpt.load_tables()
    g = df["phot_g_mean_mag"].to_numpy(float)
    nu = df["nu_eff_used_in_astrometry"].to_numpy(float)
    pc = df["pseudocolour"].to_numpy(float)
    el = df["ecl_lat"].to_numpy(float)
    sol = df["astrometric_params_solved"].to_numpy(float)
    ok = np.isfinite(g) & np.isfinite(el) & np.isin(sol, (31, 95)) & (g > 6) & (g < 21)
    ok &= np.where(sol == 31, (nu > 1.1) & (nu < 1.9), (pc > 1.24) & (pc < 1.72))
    if ok.any():
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            vals = zpt.get_zpt(g[ok], np.nan_to_num(nu[ok]), np.nan_to_num(pc[ok]), el[ok], sol[ok].astype(int), _warnings=False)
        vals = np.asarray(vals, dtype=float)
        good = np.isfinite(vals)
        idx = np.nonzero(ok)[0]
        zp[idx[good]] = vals[good]
    return zp


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    d = load()
    print(len(d), "gaia rows")
