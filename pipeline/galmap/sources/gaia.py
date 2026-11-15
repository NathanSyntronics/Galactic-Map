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

Gaia DR4 (due on 2 December 2026, docs/GAIA_DR4.md) can replace DR3 for the stars beyond 200 pc
with parallaxes better than 1 % (GALMAP_GAIA_RELEASE=dr4 or `build --gaia-release dr4`): its
rows are normalised to the columns of DR3 (normalise_dr4) and keep their DR3 number wherever the
archive's dr3_neighbourhood table names a probable match, so that a star keeps its designation.
"""

from __future__ import annotations

import logging
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

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
    "gcns_table": "external.gaiaedr3_gcns_main_1",
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
# All Gaia DR3 stars beyond the field (200 pc) whose parallax is measured to better than about 1 %
# (the final cut, after the zero point and the RUWE inflation of the error, is made by the bulk
# selection bulk.PRECISE): some 4.6 million, mostly within 1 to 2 kpc.
PRECISE_MAX_PLX = 5.1
PRECISE_WHERE = f"g.parallax < {PRECISE_MAX_PLX} AND g.parallax_over_error > 90 AND g.visibility_periods_used >= 10"
COUNTS = {
    "field200": "SELECT COUNT(*) AS n FROM gaiadr3.gaia_source AS g "
    f"WHERE g.source_id >= {{lo}} AND g.source_id < {{hi}} AND {FIELD_WHERE}",
    "precise": "SELECT COUNT(*) AS n FROM gaiadr3.gaia_source AS g "
    f"WHERE g.source_id >= {{lo}} AND g.source_id < {{hi}} AND {PRECISE_WHERE}",
}
QUERIES = {
    "field200": (
        "SELECT {cols} FROM gaiadr3.gaia_source AS g "
        f"WHERE g.source_id >= {{lo}} AND g.source_id < {{hi}} AND {FIELD_WHERE}"
    ),
    "precise": (
        "SELECT {cols} FROM gaiadr3.gaia_source AS g "
        f"WHERE g.source_id >= {{lo}} AND g.source_id < {{hi}} AND {PRECISE_WHERE}"
    ),
    "gcns": (
        "SELECT {cols} FROM external.gaiaedr3_gcns_main_1 AS x "
        "JOIN gaiadr3.gaia_source AS g ON g.source_id = x.source_id "
        "WHERE x.source_id >= {lo} AND x.source_id < {hi}"
    ),
    # the GCNS table itself (sources.gcns, when the CDS does not answer), in the CDS file's column names
    "gcns_table": (
        "SELECT x.source_id, x.ra, x.dec, x.parallax AS plx, x.parallax_error AS plx_err, x.pmra, x.pmdec, "
        "x.phot_g_mean_mag AS gmag, x.phot_bp_mean_mag AS bpmag, x.phot_rp_mean_mag AS rpmag, x.ruwe, "
        "x.gcns_prob, x.wd_prob, x.dist_50 AS dist50, x.dist_16 AS dist16, x.dist_84 AS dist84, "
        "x.name_2mass, x.j_m_2mass AS jmag FROM external.gaiaedr3_gcns_main_1 AS x "
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




@dataclass(frozen=True)
class Release:
    """A Gaia data release as the pipeline reads it."""

    key: str  # "dr3": the cache files' prefix (gaia_dr3_precise.parquet)
    schema: str  # the archive's schema ("gaiadr3")
    label: str  # the designation prefix ("Gaia DR3")
    epoch: float  # the reference epoch of the positions (Julian years, TCB)
    #: the parallax zero point: "lindegren" (Lindegren et al. 2021, computed here) or the name of a column
    zero_point: str
    #: the table of probable matches with DR3 (None: DR3 itself)
    dr3_neighbourhood: str | None = None


DR3 = Release("dr3", "gaiadr3", "Gaia DR3", 2016.0, "lindegren")
#: Gaia DR4 as its draft data model (2026-06-26) describes it: positions at J2017.5, the parallax
#: bias to subtract in each row, no astrometric_params_solved, its own source_ids
DR4 = Release("dr4", "gaiadr4", "Gaia DR4", 2017.5, "tentative_parallax_bias", "gaiadr4.dr3_neighbourhood")
RELEASES = {r.key: r for r in (DR3, DR4)}
#: the release of the stars beyond 200 pc unless a build says otherwise
RELEASE_ENV = "GALMAP_GAIA_RELEASE"


def release(key: str | None = None) -> Release:
    """The release named by `key`, else by the environment variable GALMAP_GAIA_RELEASE, else DR3."""
    key = (key or os.environ.get(RELEASE_ENV) or DR3.key).strip().lower()
    if key not in RELEASES:
        raise ValueError(f"unknown Gaia release {key!r} (one of {', '.join(RELEASES)})")
    return RELEASES[key]


#: the columns of a DR4 row of the precise query: those of DR3 without astrometric_params_solved,
#: the epoch, the parallax bias, the astrometry flags, and each probable DR3 counterpart
DR4_COLUMNS = (
    "g.source_id, g.ra, g.dec, g.parallax, g.parallax_error, g.pmra, g.pmdec, g.ruwe, "
    "g.phot_g_mean_mag, g.bp_rp, g.nu_eff_used_in_astrometry, g.pseudocolour, g.ecl_lat, "
    "g.ref_epoch, g.tentative_parallax_bias, g.unreliable_astrometry, g.astrometry_origin, "
    "n.dr3_source_id, n.angular_distance, n.magnitude_difference, n.probable_match"
)
DR4_COUNTS = {
    "precise": f"SELECT COUNT(*) AS n FROM {DR4.schema}.gaia_source AS g "
    f"WHERE g.source_id >= {{lo}} AND g.source_id < {{hi}} AND {PRECISE_WHERE}",
}
#: (a source with several DR3 neighbours comes once per neighbour: such queries are checked by
#: the number of distinct source_ids, see _fetch_range)
DR4_QUERIES = {
    "precise": (
        f"SELECT {{cols}} FROM {DR4.schema}.gaia_source AS g "
        f"LEFT OUTER JOIN {DR4.dr3_neighbourhood} AS n ON n.source_id = g.source_id "
        f"WHERE g.source_id >= {{lo}} AND g.source_id < {{hi}} AND {PRECISE_WHERE}"
    ),
}
#: what the readiness check (`python -m galmap.sources.gaia check dr4`) looks for in the archive
DR4_REQUIRED = {
    f"{DR4.schema}.gaia_source": [c.split(".", 1)[1] for c in DR4_COLUMNS.split(", ") if c.startswith("g.")]
    + ["visibility_periods_used", "parallax_over_error"],
    DR4.dr3_neighbourhood: [c.split(".", 1)[1] for c in DR4_COLUMNS.split(", ") if c.startswith("n.")] + ["source_id"],
}


IDS_PER_QUERY = 2000
NUMERIC = (
    "ra", "dec", "parallax", "parallax_error", "pmra", "pmdec", "ruwe", "phot_g_mean_mag", "bp_rp",
    "nu_eff_used_in_astrometry", "pseudocolour", "ecl_lat", "astrometric_params_solved",
)
DR4_NUMERIC = ("ref_epoch", "tentative_parallax_bias", "angular_distance", "magnitude_difference")
HIP_COLUMNS = "hip, ra, dec, plx, e_plx, pm_ra, pm_de, hp_mag, b_v"


def _count(name: str, lo: int, hi: int, rel: Release = DR3) -> int:
    if rel is not DR3:
        q = DR4_COUNTS[name].format(lo=lo, hi=hi)
    elif name in COUNTS:
        q = COUNTS[name].format(lo=lo, hi=hi)
    else:
        q = f"SELECT COUNT(*) AS n FROM {TABLES[name]} AS x WHERE x.source_id >= {lo} AND x.source_id < {hi}"
    return int(tap_sync(GAIA_TAP, q, timeout=300)["n"].iloc[0])


def _fetch_range(name: str, lo: int, hi: int, rel: Release = DR3) -> pd.DataFrame:
    """Fetch one source_id range, splitting it until each piece is small enough to arrive complete.

    The anonymous Gaia TAP service silently truncates large synchronous results, so every
    piece is checked against a COUNT(*) of the same range (for DR4, whose rows come once per DR3
    neighbour, by the number of distinct sources; the pieces are kept smaller for the extra rows).
    """
    n = _count(name, lo, hi, rel)
    if n == 0:
        return pd.DataFrame()
    limit = CHUNK_ROWS if rel is DR3 else CHUNK_ROWS // 2
    if n > limit and hi - lo > 1:
        mid = lo + (hi - lo) // 2
        return pd.concat([_fetch_range(name, lo, mid, rel), _fetch_range(name, mid, hi, rel)], ignore_index=True)
    if rel is DR3:
        q = QUERIES[name].format(cols=COLUMNS, lo=lo, hi=hi)
    else:
        q = DR4_QUERIES[name].format(cols=DR4_COLUMNS, lo=lo, hi=hi)
    df = tap_sync(GAIA_TAP, q, timeout=900, maxrec=MAXREC)
    got = len(df) if rel is DR3 else (df["source_id"].nunique() if len(df) else 0)
    if got != n or len(df) >= MAXREC:
        raise RuntimeError(f"Gaia {rel.label} {name} range [{lo}, {hi}): got {got} sources, expected {n}")
    return df


def fetch_xmatch(
    name: str,
    chunks: int,
    cache: Path | None = None,
    refresh: bool = False,
    rel: Release = DR3,
    post: Callable[[pd.DataFrame], pd.DataFrame] | None = None,
) -> pd.DataFrame:
    """A query over the whole source_id range in `chunks` pieces, cached as gaia_<release>_<name>.parquet
    (after `post`, e.g. normalise_dr4); the pieces are kept until the table is complete."""
    cache = cache or CACHE_DIR / "gaia"
    out = cache / f"gaia_{rel.key}_{name}.parquet"
    if out.exists() and not refresh:
        return pd.read_parquet(out)
    part_dir = cache / (f"{name}_parts" if rel is DR3 else f"{rel.key}_{name}_parts")
    part_dir.mkdir(parents=True, exist_ok=True)
    edges = [int(v) for v in np.linspace(0, MAX_SOURCE_ID, chunks + 1)]
    frames = []
    for i in range(chunks):
        part = part_dir / f"part{i:03d}.csv"
        if part.exists() and not refresh:
            df = pd.read_csv(part, dtype=str, keep_default_na=False)
        else:
            df = _fetch_range(name, edges[i], edges[i + 1], rel)
            df.to_csv(part, index=False)
        log.info("gaia %s %s chunk %d/%d: %d rows", rel.key, name, i + 1, chunks, len(df))
        if len(df):
            frames.append(df)
    df = _numeric(pd.concat(frames, ignore_index=True))
    if "hip" in df:
        df["hip"] = pd.to_numeric(df["hip"]).astype("Int64")
    if post is not None:
        df = post(df)
    df.to_parquet(out, index=False)
    shutil.rmtree(part_dir, ignore_errors=True)  # the parquet file now holds everything
    return df


def _numeric(df: pd.DataFrame) -> pd.DataFrame:
    df["source_id"] = exact_int64(df["source_id"])
    if "dr3_source_id" in df:
        ok = df["dr3_source_id"].astype(str).str.fullmatch(r"\d+")
        df["dr3_source_id"] = exact_int64(df["dr3_source_id"].where(ok, "-1"))
    for c in NUMERIC + DR4_NUMERIC:
        if c in df:
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


#: source_id chunks of the precise query (each split further until it arrives complete)
PRECISE_CHUNKS = 512


def load_precise(refresh: bool = False, rel: Release | None = None) -> Path:
    """Gaia stars beyond 200 pc with a parallax better than about 1 % (see PRECISE_WHERE) of the
    release `rel` (default: release()), downloaded once into the archive cache; returns the Parquet
    file (bulk.precise_source reads it chunk by chunk, so that the 5 million rows are never held as
    one table). DR4 rows are normalised to DR3's columns first (normalise_dr4)."""
    rel = rel or release()
    fetch_xmatch("precise", chunks=PRECISE_CHUNKS, refresh=refresh, rel=rel, post=None if rel is DR3 else normalise_dr4)
    return CACHE_DIR / "gaia" / f"gaia_{rel.key}_precise.parquet"


# ------------------------------------------------------------------ Gaia DR4


def _truthy(v: pd.Series) -> np.ndarray:
    """A boolean column as the archive's CSV writes it ('true', 'True', 't', '1'; empty: False)."""
    if v.dtype == bool:
        return v.to_numpy()
    return v.astype(str).str.strip().str.lower().isin(["true", "t", "1", "1.0"]).to_numpy()


def dr3_counterparts(df: pd.DataFrame) -> pd.DataFrame:
    """One row per DR4 source (the first of its rows, with its DR3 counterpart): the rows of the
    precise query come once per DR3 neighbour (dr3_source_id, angular_distance, probable_match;
    none: dr3_source_id -1). The counterpart is the nearest probable match; a DR3 source that is
    the counterpart of several DR4 sources (a DR3 source resolved into two) belongs to the nearest
    of them only, the others keep no DR3 number (dr3_source_id -1)."""
    t = df.copy()
    dr3 = t["dr3_source_id"].to_numpy(dtype=np.int64) if "dr3_source_id" in t else np.full(len(t), -1, np.int64)
    probable = _truthy(t["probable_match"]) if "probable_match" in t else np.zeros(len(t), bool)
    dist = pd.to_numeric(t["angular_distance"], errors="coerce").to_numpy(float) if "angular_distance" in t else np.full(len(t), np.nan)
    ok = probable & (dr3 >= 0)
    t["_dr3"] = np.where(ok, dr3, -1)
    t["_d"] = np.where(ok, np.nan_to_num(dist, nan=np.inf), np.inf)
    # each DR4 source's nearest probable match (or, without one, any of its rows)
    t = t.sort_values(["source_id", "_d"], kind="stable").drop_duplicates("source_id")
    # each DR3 source to the nearest DR4 source that claims it
    claimed = t[t["_dr3"] >= 0].sort_values(["_dr3", "_d"], kind="stable")
    losers = claimed.index[claimed.duplicated("_dr3")]
    t.loc[losers, "_dr3"] = -1
    t["dr3_source_id"] = t["_dr3"].astype(np.int64)
    return t.drop(columns=["_dr3", "_d"]).sort_index().reset_index(drop=True)


def normalise_dr4(df: pd.DataFrame) -> pd.DataFrame:
    """Rows of the DR4 precise query in the columns the pipeline reads from DR3:

    * source_id: the DR3 number of the same star (dr3_counterparts), -1 where there is none; the
      DR4 number in dr4_source_id (a star without a DR3 number is designated by it, "Gaia DR4 ...");
    * astrometric_params_solved (not in DR4): 95 with a pseudocolour (six parameters), else 31; 0
      (left out by every selection) where unreliable_astrometry is true;
    * parallax_zp: DR4's tentative_parallax_bias (to subtract from the parallax), where missing the
      median of the others;
    * ref_epoch: the epoch of the row's position (J2017.5; derive.positions moves it to J2016.0)."""
    t = dr3_counterparts(df)
    out = pd.DataFrame({"source_id": t["dr3_source_id"].astype(np.int64), "dr4_source_id": t["source_id"].astype(np.int64)})
    for c in ("ra", "dec", "parallax", "parallax_error", "pmra", "pmdec", "ruwe", "phot_g_mean_mag", "bp_rp",
              "nu_eff_used_in_astrometry", "pseudocolour", "ecl_lat"):
        out[c] = pd.to_numeric(t[c], errors="coerce") if c in t else np.nan
    sol = np.where(np.isfinite(out["pseudocolour"].to_numpy(float)), 95, 31)
    if "unreliable_astrometry" in t:
        sol = np.where(_truthy(t["unreliable_astrometry"]), 0, sol)
    out["astrometric_params_solved"] = sol
    zp = pd.to_numeric(t[DR4.zero_point], errors="coerce") if DR4.zero_point in t else pd.Series(np.nan, index=t.index)
    fill = float(np.nanmedian(zp)) if np.isfinite(zp).any() else 0.0
    out["parallax_zp"] = zp.fillna(fill).to_numpy(float)
    epoch = pd.to_numeric(t["ref_epoch"], errors="coerce") if "ref_epoch" in t else pd.Series(np.nan, index=t.index)
    out["ref_epoch"] = epoch.fillna(DR4.epoch).to_numpy(float)
    n, kept = len(out), int((out["source_id"] >= 0).sum())
    log.info("Gaia DR4: %d sources, %d with their DR3 number, %d unreliable", n, kept, int((sol == 0).sum()))
    return out


def missing_columns(columns: pd.DataFrame, required: dict[str, list[str]] = DR4_REQUIRED) -> dict[str, list[str]]:
    """The required columns that a TAP_SCHEMA.columns listing (table_name, column_name) lacks, per table."""
    have: dict[str, set[str]] = {}
    for t, c in zip(columns["table_name"].astype(str).str.lower(), columns["column_name"].astype(str).str.lower()):
        have.setdefault(t, set()).add(c)
    out = {}
    for table, cols in required.items():
        miss = [c for c in cols if c.lower() not in have.get(table.lower(), set())]
        if miss:
            out[table] = miss
    return out


def check_release(rel: Release = DR4) -> dict[str, list[str]]:
    """Asks the archive whether the release's tables and columns are there; returns what is missing
    (empty: ready)."""
    required = DR4_REQUIRED if rel is DR4 else {f"{DR3.schema}.gaia_source": [c.split(".", 1)[1] for c in COLUMNS.split(", ")]}
    names = ", ".join(f"'{t}'" for t in required)
    cols = tap_sync(GAIA_TAP, f"SELECT table_name, column_name FROM TAP_SCHEMA.columns WHERE table_name IN ({names})", timeout=120, retries=2)
    return missing_columns(cols, required)


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


def main(argv: list[str] | None = None) -> int:
    """`python -m galmap.sources.gaia check dr4`: is the release in the archive (exit code 0)?"""
    import argparse

    ap = argparse.ArgumentParser(description="Gaia archive helpers")
    sub = ap.add_subparsers(dest="cmd", required=True)
    chk = sub.add_parser("check", help="whether a release's tables and columns are in the archive")
    chk.add_argument("release", nargs="?", default=DR4.key, choices=sorted(RELEASES))
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    rel = RELEASES[args.release]
    try:
        missing = check_release(rel)
    except Exception as err:  # the archive does not answer
        print(f"{rel.label}: the Gaia archive does not answer ({err})")
        return 2
    if not missing:
        print(f"{rel.label}: all tables and columns the pipeline reads are in the archive")
        return 0
    for table, cols in missing.items():
        print(f"{rel.label}: {table} lacks {', '.join(cols)}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
