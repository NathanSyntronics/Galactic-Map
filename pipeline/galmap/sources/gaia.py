"""Gaia DR3 astrometry and photometry for the Tycho-2 and Hipparcos stars of AT-HYG.

AT-HYG has Gaia DR3 distances but no parallax errors, Gaia positions or BP-RP colours.
We fetch them from the Gaia archive through the official cross-match tables, in source_id
range chunks small enough for synchronous TAP queries (~50k rows each, a few seconds).
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

QUERIES = {
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


def _count(name: str, lo: int, hi: int) -> int:
    table = {"tycho2": "gaiadr3.tycho2tdsc_merge_best_neighbour", "hipparcos2": "gaiadr3.hipparcos2_best_neighbour"}[name]
    q = f"SELECT COUNT(*) AS n FROM {table} AS x WHERE x.source_id >= {lo} AND x.source_id < {hi}"
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
    df = pd.concat(frames, ignore_index=True)
    df["source_id"] = exact_int64(df["source_id"])
    for c in (
        "ra", "dec", "parallax", "parallax_error", "pmra", "pmdec", "ruwe", "phot_g_mean_mag", "bp_rp",
        "nu_eff_used_in_astrometry", "pseudocolour", "ecl_lat", "astrometric_params_solved",
    ):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    if "hip" in df:
        df["hip"] = pd.to_numeric(df["hip"]).astype("Int64")
    df.to_parquet(out, index=False)
    return df


def load(refresh: bool = False) -> pd.DataFrame:
    """Gaia DR3 rows (deduplicated by source_id) for all Tycho-2 and Hipparcos cross-matches."""
    tyc = fetch_xmatch("tycho2", chunks=48, refresh=refresh)
    hip = fetch_xmatch("hipparcos2", chunks=4, refresh=refresh)
    cols = [
        "source_id", "ra", "dec", "parallax", "parallax_error", "pmra", "pmdec", "ruwe", "phot_g_mean_mag", "bp_rp",
        "nu_eff_used_in_astrometry", "pseudocolour", "ecl_lat", "astrometric_params_solved",
    ]
    both = pd.concat([tyc[cols], hip[cols]], ignore_index=True).drop_duplicates("source_id").reset_index(drop=True)
    both["parallax_zp"] = parallax_zero_point(both)
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
