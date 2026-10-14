"""AT-HYG v4.0 (Augmented Tycho-2 + HYG; D. Nash / astronexus, CC BY-SA 4.0).

2.56 million stars: every Tycho-2 star with Gaia DR3 distances where available, merged with
HYG v4.4 (Hipparcos, Yale Bright Star, Gliese-Jahreiss). We use it as the bulk catalogue for
bright stars at all distances; GCNS and the 20 pc census take precedence nearby.
"""

from __future__ import annotations

import logging
import re

import numpy as np
import pandas as pd

from ..download import CACHE_DIR, exact_int64, fetch

log = logging.getLogger(__name__)

URL = "https://codeberg.org/astronexus/athyg/media/commit/eebe42b3552ae04e67d27ae085a8aad997b42bc0/data/athyg_40.csv.gz"
SHA256 = "69ad04dd33d7c7bb4f5e1b4682798075811547ea9fb8d0e802e5b319c46818a6"
FILE = CACHE_DIR / "athyg" / "athyg_40.csv.gz"

SOURCE_INFO = {
    "key": "athyg",
    "title": "AT-HYG v4.0 (Augmented Tycho-2 + HYG)",
    "citation": "D. Nash, The Astronomy Nexus. Built from Tycho-2 (ESA 1997, SP-1200; Høg et al. 2000), "
    "Gaia DR3 (Gaia Collaboration 2023), Hipparcos (van Leeuwen 2007), Yale BSC (Hoffleit 1991) and "
    "Gliese-Jahreiss (1991).",
    "url": "https://codeberg.org/astronexus/athyg",
    "license": "CC BY-SA 4.0",
}

# Epoch of ra/dec by pos_src (see research notes): Tycho-2 mean positions are J2000,
# Tycho pflag-X observed positions ~J1991.5, Gliese positions ~J1991.
POS_EPOCH = {"T": 2000.0, "T_X": 1991.5, "HIP_X": 2000.0, "GJ": 1991.2, "OTHER": 2000.0}


def gliese_designation(gl: str | None) -> str | None:
    """AT-HYG strips the prefix: '551' -> 'GJ 551', '244B' -> 'GJ 244 B' (SIMBAD form)."""
    if not isinstance(gl, str) or not gl.strip():
        return None
    m = re.fullmatch(r"(\d+(?:\.\d+)?)([A-D]?)", gl.strip())
    if not m:
        return None
    num, comp = m.groups()
    return f"GJ {num}" + (f" {comp}" if comp else "")


def load(refresh: bool = False) -> pd.DataFrame:
    path = fetch(URL, FILE, sha256=SHA256, refresh=refresh)
    log.info("reading %s", path)
    str_cols = ["tyc", "gaia", "gl", "bayer", "con", "proper", "pos_src", "dist_src", "mag_src", "spect", "pm_src"]
    num_cols = ["id", "hyg", "hip", "hd", "hr", "flam", "ra", "dec", "dist", "mag", "absmag", "ci", "pmra", "pmdec"]
    df = pd.read_csv(
        path,
        usecols=str_cols + num_cols,
        dtype={c: "string" for c in str_cols},
        keep_default_na=False,
        na_values={c: [""] for c in num_cols},
        encoding="utf-8",
    )
    for c in ("hyg", "hip", "hd", "hr", "flam", "id"):
        df[c] = pd.to_numeric(df[c], errors="coerce").astype("Int64")
    df["gaia"] = exact_int64(df["gaia"])
    for c in str_cols:
        df[c] = df[c].replace("", pd.NA)

    n0 = len(df)
    sun = df["proper"].eq("Sol").fillna(False)
    # HYG "unknown distance" placeholder and junk SIMBAD distances
    bad = (df["dist"] >= 99999) | ((df["dist_src"] == "OTHER") & (df["dist"] > 1000))
    df.loc[bad, "dist"] = np.nan
    df = df[sun | df["dist"].notna()].copy()
    log.info("AT-HYG: %d rows, %d with distance", n0, len(df))

    df["ra_deg"] = df["ra"] * 15.0
    df["epoch"] = df["pos_src"].map(POS_EPOCH).fillna(2000.0).astype(float)
    df["gj"] = df["gl"].map(gliese_designation)
    # Tycho VT / BT-VT -> Johnson V / B-V (ESA 1997, Vol. 1, Sect. 1.3, eq. 1.3.20); GJ rows are already V, B-V
    tycho_phot = df["mag_src"].eq("T").fillna(False)
    ci = df["ci"]
    df["vmag"] = np.where(tycho_phot, df["mag"] - 0.090 * ci.fillna(0.0), df["mag"])
    df["bv"] = np.where(tycho_phot, 0.850 * ci, ci)
    df["is_sun"] = sun.loc[df.index]
    df = df.drop(columns=["ra", "mag", "ci", "absmag"])
    return df.reset_index(drop=True)
