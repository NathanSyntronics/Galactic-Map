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

from ..download import CACHE_DIR, exact_int64, tap_sync

log = logging.getLogger(__name__)

TAP = "https://simbad.cds.unistra.fr/simbad/sim-tap"
DIR = CACHE_DIR / "simbad"
BASIC_FILE = DIR / "simbad_basic_plx10.csv"
IDENT_FILE = DIR / "simbad_ident_plx10.csv"
MIN_PLX = 10.0
OID_STEP = 200_000_000  # oid ranges per query; queries are split further when they hit MAXREC
MAXREC = 2_000_000

SOURCE_INFO = {
    "key": "simbad",
    "title": "SIMBAD astronomical database",
    "citation": "Wenger M. et al. 2000, A&AS 143, 9. This research has made use of the SIMBAD database, "
    "operated at CDS, Strasbourg, France.",
    "url": "https://simbad.cds.unistra.fr/",
    "license": "ODbL 1.0 (CDS data)",
}

BASIC_QUERY = (
    "SELECT oid, main_id, otype, ra, dec, pmra, pmdec, plx_value, plx_err, sp_type "
    "FROM basic WHERE plx_value >= {plx} AND oid >= {lo} AND oid < {hi}"
)
IDENT_QUERY = (
    "SELECT i.oidref, i.id FROM ident AS i JOIN basic AS b ON b.oid = i.oidref "
    "WHERE b.plx_value >= {plx} AND b.oid >= {lo} AND b.oid < {hi}"
)

# Identifier prefixes that never yield a useful name (cross-match catalogues etc.)
NOISE = re.compile(
    r"^(TIC|Gaia DR[12]|Gaia EDR3|UCAC\d|UCAC|AG[+-]|PPM|SAO|GSC|USNO|URAT|TYC|HIC|IRAS|AKARI|ASCC|KIC|EPIC|"
    r"ALLWISE|AllWISE|WISEA|GALEX|SDSS|PS1|SKY#|N30|FK5|GCRV|uvby98|YZ|CSI|PLX|IDS|CCDM|WDS|Renson|JP11|"
    r"UBV|ROT|SPOCS|TD1|Ci|BPS|GEN#|LEP|NSV|RAVE|LAMOST|Pan-STARRS|PSO J\d|2MASX|XMMU|1RXS|RX J|1ES|EUVE|"
    r"\[|\*\*|CNS|GCRV|BIBCODE|Zkh|MCC|StKM|TOI|KOI|K2-|Kepler-)"
)


def _fetch_ranges(query: str, dest: Path, refresh: bool) -> pd.DataFrame:
    if dest.exists() and not refresh:
        return pd.read_csv(dest, dtype=str, keep_default_na=False)
    frames = []
    hi_oid = int(tap_sync(TAP, "SELECT MAX(oid) AS m FROM basic")["m"].iloc[0]) + 1

    def run(lo: int, hi: int) -> None:
        df = tap_sync(TAP, query.format(plx=MIN_PLX, lo=lo, hi=hi), maxrec=MAXREC, timeout=900)
        if len(df) >= MAXREC and hi - lo > 1:
            mid = (lo + hi) // 2
            run(lo, mid)
            run(mid, hi)
            return
        frames.append(df)
        log.info("SIMBAD oid [%d, %d): %d rows", lo, hi, len(df))

    for lo in range(0, hi_oid, OID_STEP):
        run(lo, min(lo + OID_STEP, hi_oid))
    df = pd.concat(frames, ignore_index=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(dest, index=False)
    return df


def load(refresh: bool = False) -> tuple[pd.DataFrame, pd.DataFrame]:
    basic = _fetch_ranges(BASIC_QUERY, BASIC_FILE, refresh)
    ident = _fetch_ranges(IDENT_QUERY, IDENT_FILE, refresh)
    basic["oid"] = pd.to_numeric(basic["oid"]).astype("int64")
    ident["oidref"] = pd.to_numeric(ident["oidref"]).astype("int64")
    ident["id"] = ident["id"].str.replace(r"\s+", " ", regex=True).str.strip()
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
    sub = b.loc[row_oid[ok]]
    info.loc[ok, "simbad_main_id"] = sub["main_id"].str.replace(r"\s+", " ", regex=True).to_numpy()
    info.loc[ok, "simbad_otype"] = sub["otype"].to_numpy()
    info.loc[ok, "simbad_sp_type"] = sub["sp_type"].replace("", None).to_numpy()
    return idents, info
