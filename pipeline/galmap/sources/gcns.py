"""Gaia Catalogue of Nearby Stars (GCNS; Gaia Collaboration, Smart et al. 2021, A&A 649, A6).

All Gaia EDR3 sources within 100 pc with reliable astrometry (CDS J/A+A/649/A6, table1c).
Gaia EDR3 source_id == Gaia DR3 source_id, and the astrometry is identical in DR3.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from ..download import CACHE_DIR, exact_int64, fetch

log = logging.getLogger(__name__)

BASE = "https://cdsarc.cds.unistra.fr/ftp/J/A+A/649/A6/"
FILE = CACHE_DIR / "gcns" / "table1c.dat.gz"

SOURCE_INFO = {
    "key": "gcns",
    "title": "Gaia Catalogue of Nearby Stars (GCNS)",
    "citation": "Gaia Collaboration, Smart R. L. et al. 2021, A&A 649, A6 (CDS J/A+A/649/A6). "
    "This work has made use of data from the European Space Agency (ESA) mission Gaia "
    "(https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC).",
    "url": "https://doi.org/10.1051/0004-6361/202039498",
    "license": "CC BY 4.0",
}

# (name, first byte, last byte) from the ReadMe, 1-based inclusive
COLSPECS = [
    ("source_id", 3, 21),
    ("ra", 23, 36),
    ("dec", 46, 59),
    ("plx", 69, 77),
    ("plx_err", 79, 85),
    ("pmra", 87, 95),
    ("pmdec", 105, 113),
    ("gmag", 123, 130),
    ("bpmag", 142, 149),
    ("rpmag", 161, 168),
    ("ruwe", 189, 193),
    ("gcns_prob", 240, 244),
    ("wd_prob", 246, 250),
    ("dist50", 278, 289),
    ("dist16", 265, 276),
    ("dist84", 291, 302),
    ("name_2mass", 611, 627),
    ("jmag", 629, 635),
]


def load(refresh: bool = False) -> pd.DataFrame:
    path = fetch(BASE + "table1c.dat.gz", FILE, refresh=refresh)
    names = [c[0] for c in COLSPECS]
    specs = [(a - 1, b) for _, a, b in COLSPECS]
    df = pd.read_fwf(path, colspecs=specs, names=names, dtype=str, compression="gzip", keep_default_na=False)
    df["source_id"] = exact_int64(df["source_id"])
    for c in names:
        if c not in ("source_id", "name_2mass"):
            df[c] = pd.to_numeric(df[c].replace("", np.nan), errors="coerce")
    df["name_2mass"] = df["name_2mass"].str.strip().replace("", pd.NA)
    df["bp_rp"] = df["bpmag"] - df["rpmag"]
    log.info("GCNS: %d rows", len(df))
    return df
