"""SIMBAD (CDS, Strasbourg): identifiers and common names of all objects within 100 pc.

We fetch the `basic` rows (main identifier, object type, spectral type, parallax) of every
object with a parallax >= 10 mas and all of their identifiers, and attach them to our stars
through the Gaia DR3 source_id or the HIP number. They provide common names ("NAME ..."),
Bayer/Flamsteed and variable-star designations, historical and survey catalogue names, object
types (brown dwarf, white dwarf) and spectral types for stars that lack them.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

import numpy as np
import pandas as pd

from scipy.spatial import cKDTree

from ..coords import propagate, unit_vectors
from ..download import CACHE_DIR, exact_int64, tap_sync

log = logging.getLogger(__name__)

TAP = "https://simbad.cds.unistra.fr/simbad/sim-tap"
DIR = CACHE_DIR / "simbad"
BASIC_FILE = DIR / "simbad_basic_plx10.csv"
IDENT_FILE = DIR / "simbad_ident_plx10.csv"
MIN_PLX = 10.0
MAXREC = 2_000_000

SOURCE_INFO = {
    "key": "simbad",
    "title": "SIMBAD astronomical database",
    "citation": "Wenger M. et al. 2000, A&AS 143, 9. This research has made use of the SIMBAD database, "
    "operated at CDS, Strasbourg, France.",
    "url": "https://simbad.cds.unistra.fr/",
    "license": "ODbL 1.0 (CDS data)",
}

# Objects with a parallax >= 10 mas, plus their components/children without a parallax of their own
# (Procyon B, Luhman 16 A/B, many system objects have plx NULL in SIMBAD).
W10 = (
    "(b.plx_value >= 10 OR (b.plx_value IS NULL AND b.oid IN "
    "(SELECT h.child FROM h_link AS h JOIN basic AS p ON p.oid = h.parent WHERE p.plx_value >= 10)))"
)
BASIC_QUERY = (
    "SELECT b.oid, b.main_id, b.otype, b.ra, b.dec, b.pmra, b.pmdec, b.plx_value, b.plx_err, b.sp_type "
    f"FROM basic AS b WHERE {W10}"
)
IDENT_QUERY = f"SELECT i.oidref, i.id FROM ident AS i JOIN basic AS b ON b.oid = i.oidref WHERE {W10}"
BASIC_COUNT = f"SELECT COUNT(*) AS n FROM basic AS b WHERE {W10}"
IDENT_COUNT = f"SELECT COUNT(*) AS n FROM ident AS i JOIN basic AS b ON b.oid = i.oidref WHERE {W10}"

# Identifier prefixes that never yield a useful name (cross-match catalogues etc.). Double-star
# designations ("** STF 2398") stay: some carry traditional names (Struve 2398, Kruger 60).
NOISE = re.compile(
    r"^(TIC|Gaia DR[12]|Gaia EDR3|UCAC\d|UCAC|AG[+-]|PPM|SAO|GSC|USNO|URAT|TYC|HIC|IRAS|AKARI|ASCC|KIC|EPIC|"
    r"ALLWISE|AllWISE|WISEA|GALEX|SDSS|PS1|SKY#|N30|FK5|GCRV|uvby98|YZ|CSI|PLX|IDS|CCDM|WDS|Renson|JP11|"
    r"UBV|ROT|SPOCS|TD1|Ci|BPS|GEN#|LEP|NSV|RAVE|LAMOST|Pan-STARRS|PSO J\d|2MASX|XMMU|1RXS|RX J|1ES|EUVE|"
    r"\[|CNS|BIBCODE|Zkh|MCC|StKM|TOI|KOI|K2-|Kepler-)"
)

# object types that are not stars (planets, clusters, associations, quasars, errors)
NON_STELLAR = {"Pl", "Pl?", "MGr", "As*", "OpC", "St*", "Cl*", "SFR", "GlC", "QSO", "err", "G", "MoC", "HII"}


def _fetch(query: str, count_query: str, dest: Path, refresh: bool) -> pd.DataFrame:
    """One synchronous query (MAXREC raised; SIMBAD silently truncates at 50,000 rows otherwise),
    checked against a COUNT(*) of the same selection."""
    if dest.exists() and not refresh:
        return pd.read_csv(dest, dtype=str, keep_default_na=False)
    expected = int(tap_sync(TAP, count_query)["n"].iloc[0])
    if expected >= MAXREC:
        raise RuntimeError(f"SIMBAD query would return {expected} rows (> MAXREC); page it")
    for attempt in range(3):
        df = tap_sync(TAP, query, maxrec=MAXREC, timeout=1800)
        # counts can drift by a few rows while SIMBAD is being updated
        if abs(len(df) - expected) <= max(50, expected // 1000):
            break
        log.warning("SIMBAD returned %d rows, expected %d; retrying", len(df), expected)
    else:
        raise RuntimeError(f"SIMBAD query incomplete: {len(df)} of {expected} rows")
    dest.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(dest, index=False)
    log.info("SIMBAD: fetched %d rows into %s", len(df), dest.name)
    return df


def load(refresh: bool = False) -> tuple[pd.DataFrame, pd.DataFrame]:
    basic = _fetch(BASIC_QUERY, BASIC_COUNT, BASIC_FILE, refresh)
    ident = _fetch(IDENT_QUERY, IDENT_COUNT, IDENT_FILE, refresh)
    basic["oid"] = pd.to_numeric(basic["oid"]).astype("int64")
    basic["main_id"] = basic["main_id"].str.replace(r"\s+", " ", regex=True).str.strip()
    basic = basic[~basic["otype"].isin(NON_STELLAR)].reset_index(drop=True)
    ident["oidref"] = pd.to_numeric(ident["oidref"]).astype("int64")
    ident["id"] = ident["id"].str.replace(r"\s+", " ", regex=True).str.strip()
    ident = ident[ident["oidref"].isin(basic["oid"])].reset_index(drop=True)
    log.info("SIMBAD: %d objects, %d identifiers", len(basic), len(ident))
    return basic, ident


def attach(stars: pd.DataFrame, basic: pd.DataFrame, ident: pd.DataFrame) -> tuple[dict[int, list[str]], pd.DataFrame]:
    """Map SIMBAD objects onto star rows via Gaia DR3 id or HIP number.

    Returns ({row index: [identifier, ...]}, per-row frame with main_id, otype, sp_type).
    """
    gaia = ident[ident["id"].str.startswith("Gaia DR3 ")]
    g_oid = pd.Series(gaia["oidref"].to_numpy(), index=exact_int64(gaia["id"].str.slice(9)))
    g_oid = g_oid[~g_oid.index.duplicated(keep=False)]
    hip = ident[ident["id"].str.match(r"^HIP \d+$")]
    h_oid = pd.Series(hip["oidref"].to_numpy(), index=pd.to_numeric(hip["id"].str.slice(4)).astype("int64"))
    h_oid = h_oid[~h_oid.index.duplicated(keep=False)]

    row_oid = np.full(len(stars), -1, dtype=np.int64)
    sg = stars["gaia"].astype("Int64")
    m = sg.isin(g_oid.index).to_numpy()
    row_oid[m] = g_oid.loc[sg[m]].to_numpy()
    sh = stars["hip"].astype("Int64")
    m2 = (row_oid < 0) & sh.isin(h_oid.index).to_numpy()
    row_oid[m2] = h_oid.loc[sh[m2]].to_numpy()
    # Remaining nearby stars (brown dwarfs and others without Gaia DR3 / HIP ids) by position:
    # SIMBAD coordinates are ICRS at epoch J2000; our rows carry their own epoch and proper motion.
    pos_matched = 0
    plx = stars["plx"].to_numpy(float)
    todo = np.nonzero((row_oid < 0) & (plx > MIN_PLX * 0.9))[0]
    taken = set(int(v) for v in row_oid[row_oid >= 0])
    cand = basic[~basic["oid"].isin(taken)].copy()
    cand["ra_f"] = pd.to_numeric(cand["ra"], errors="coerce")
    cand["dec_f"] = pd.to_numeric(cand["dec"], errors="coerce")
    cand = cand.dropna(subset=["ra_f", "dec_f"])
    if len(todo) and len(cand):
        tree = cKDTree(unit_vectors(cand["ra_f"].to_numpy(), cand["dec_f"].to_numpy()))
        ra, dec = propagate(
            stars["ra"].to_numpy(float)[todo], stars["dec"].to_numpy(float)[todo],
            stars["pmra"].to_numpy(float)[todo], stars["pmdec"].to_numpy(float)[todo],
            2000.0 - stars["epoch"].to_numpy(float)[todo],
        )
        # SIMBAD positions of fast-moving objects are often at their observation epoch rather than
        # propagated to J2000 (WISE 0855-0714 moves 8"/yr), so the radius grows with the proper motion;
        # matches beyond 3" additionally need a consistent SIMBAD parallax.
        pm_tot = np.nan_to_num(np.hypot(stars["pmra"].to_numpy(float)[todo], stars["pmdec"].to_numpy(float)[todo]))
        radius = (3.0 + np.clip(pm_tot / 1000.0 * 15.0, 0.0, 120.0)) / 206264.806
        dist, k = tree.query(unit_vectors(ra, dec), k=4, distance_upper_bound=float(radius.max()))
        cplx = pd.to_numeric(cand["plx_value"], errors="coerce").to_numpy()
        coid = cand["oid"].to_numpy()
        for j, i in enumerate(todo):
            for d_, k_ in zip(dist[j], k[j]):
                if not np.isfinite(d_) or d_ > radius[j]:
                    continue
                p_s = cplx[k_]
                if np.isfinite(p_s):
                    if abs(p_s - plx[i]) > 0.2 * plx[i]:
                        continue
                elif d_ > 3.0 / 206264.806:
                    continue
                o = int(coid[k_])
                if o in taken:
                    continue
                row_oid[i] = o
                taken.add(o)
                pos_matched += 1
                break
    log.info("SIMBAD: %d further stars matched by position", pos_matched)

    # one SIMBAD object per star row (if two rows claim the same object, the first wins)
    seen: set[int] = set()
    for i in np.nonzero(row_oid >= 0)[0]:
        if row_oid[i] in seen:
            row_oid[i] = -1
        else:
            seen.add(int(row_oid[i]))
    log.info("SIMBAD: %d stars matched (%d by Gaia DR3 id, %d by HIP)", int((row_oid >= 0).sum()), int(m.sum()), int(m2.sum()))

    useful = ident[~ident["id"].str.match(NOISE)]
    by_oid = useful.groupby("oidref")["id"].apply(list)
    idents: dict[int, list[str]] = {}
    for i in np.nonzero(row_oid >= 0)[0]:
        lst = by_oid.get(int(row_oid[i]))
        if lst:
            idents[int(i)] = lst
    b = basic.set_index("oid")
    info = pd.DataFrame(index=stars.index)
    ok = row_oid >= 0
    info["simbad_main_id"] = None
    info["simbad_otype"] = None
    info["simbad_sp_type"] = None
    info["wds"] = None
    wds = ident[ident["id"].str.match(r"^WDS J\d{5}[+-]\d{4}")]
    wds_of = pd.Series(wds["id"].str.extract(r"^WDS (J\d{5}[+-]\d{4})")[0].to_numpy(), index=wds["oidref"].to_numpy())
    wds_of = wds_of[~wds_of.index.duplicated()]
    info.loc[ok, "wds"] = wds_of.reindex(row_oid[ok]).to_numpy()
    sub = b.loc[row_oid[ok]]
    info.loc[ok, "simbad_main_id"] = sub["main_id"].str.replace(r"\s+", " ", regex=True).to_numpy()
    info.loc[ok, "simbad_otype"] = sub["otype"].to_numpy()
    info.loc[ok, "simbad_sp_type"] = sub["sp_type"].replace("", None).to_numpy()
    return idents, info
