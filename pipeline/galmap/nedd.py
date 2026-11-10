"""NED-D, the NASA/IPAC Extragalactic Database's master list of redshift-independent distances
(docs/GALAXIES.md, "NED-D"):

    https://ned.ipac.caltech.edu/Library/Distances/   (Steer et al. 2017, AJ 153, 37)

Version 17.1 (2020): 272,573 distances of 147,363 galaxies from the literature, each with the
method, the distance modulus, its error and the paper. The file names every galaxy by NED's
preferred name but gives no position: positions and PGC numbers come from HyperLEDA, whose SQL
interface resolves any designation (`objname('UGC 03657')`); designations that HyperLEDA does not
know and that carry their position (2MASX J…, SDSS J…) are placed by it.

Each galaxy gets one distance: that of its most precise method (the smallest typical error of the
method; among the measurements of that method the median modulus, with their median error).
"""

from __future__ import annotations

import csv
import logging
import re
import time
from pathlib import Path

import numpy as np
import pandas as pd

from .download import CACHE_DIR, fetch, request

log = logging.getLogger(__name__)

NEDD_URL = "https://ned.ipac.caltech.edu/Archive/Distances/NED30.5.1-D-17.1.2-20200415.csv"
#: HyperLEDA's SQL interface (the Lyon site's mirror at the Observatoire de Haute-Provence)
LEDA_URL = "http://atlas.obs-hp.fr/hyperleda/fG.cgi"
CACHE = CACHE_DIR / "galaxies"

SOURCE_INFO = {
    "key": "nedd",
    "title": "NED-D: NED Redshift-Independent Distances, v17.1 (Steer et al. 2017, AJ 153, 37)",
    "url": "https://ned.ipac.caltech.edu/Library/Distances/",
}

#: NED-D's methods (column "Method") as the map's method codes (galaxies.METHODS)
METHOD = {
    "TRGB": "TRGB", "Cepheids": "Cep", "Type II Cepheids": "Cep", "Maser": "maser", "Masers": "maser",
    "SBF": "SBF", "IR-SBF": "SBF", "SNIa": "SNIa", "SNIa SDSS": "SNIa", "SNII optical": "SNII", "SNII radio": "SNII",
    "FP": "FP", "Faber-Jackson": "FP", "D-Sigma": "FP", "Tully-Fisher": "TF", "Tully est": "TF", "IRAS": "TF",
    "RR Lyrae": "RR", "Horizontal Branch": "HB", "CMD": "CMD", "Brightest Stars": "BS", "PNLF": "PNLF",
    "Eclipsing Binary": "geom", "Grav. Stability Gas. Disk": "other",
}
#: typical errors (mag) of NED-D's methods where a measurement gives none; the order of preference
METHOD_ERR = {
    "maser": 0.1, "geom": 0.1, "Cep": 0.1, "TRGB": 0.1, "RR": 0.12, "SBF": 0.15, "SNIa": 0.15, "HB": 0.15,
    "CMD": 0.2, "PNLF": 0.2, "SNII": 0.3, "FP": 0.45, "TF": 0.45, "BS": 0.5, "other": 0.5,
}

#: names that are not galaxies with a position of their own: stars of the Magellanic Clouds
SKIP_RE = re.compile(r"^OGLE-")
#: a designation with J2000 coordinates: hhmmss.s±ddmmss (2MASX J00000755+1554070, SDSS J025202.64+000131.7)
J_RE = re.compile(r"J(\d{2})(\d{2})(\d{2})(\.\d+|\d+)?([+-])(\d{2})(\d{2})(\d{2})(\.\d+|\d+)?")


def load(refresh: bool = False) -> pd.DataFrame:
    """The measurements: name, dm, e_dm, method (map code), ned_method, ref."""
    path = fetch(NEDD_URL, CACHE / "nedd.csv", refresh=refresh)
    rows = []
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        for r in csv.reader(f):
            if not r or r[0] == "FRN" or len(r) < 9:
                continue
            rows.append((r[3], r[4], r[5], r[7], r[8]))
    t = pd.DataFrame(rows, columns=["name", "dm", "e_dm", "ned_method", "ref"])
    t["dm"] = pd.to_numeric(t["dm"], errors="coerce")
    t["e_dm"] = pd.to_numeric(t["e_dm"], errors="coerce")
    t = t[np.isfinite(t["dm"]) & ~t["name"].str.match(SKIP_RE)].copy()
    t["method"] = t["ned_method"].map(METHOD).fillna("other")
    log.info("NED-D: %d distances of %d galaxies", len(t), t["name"].nunique())
    return t


def best_distances(t: pd.DataFrame) -> pd.DataFrame:
    """One distance per galaxy (name, dm, e_dm, method, n, ref, early): its most precise method's median."""
    t = t.copy()
    typical = t["method"].map(METHOD_ERR).fillna(0.5)
    # a measurement's error: its own, or the method's typical one (implausibly small ones: at least half of it)
    t["err"] = np.where(np.isfinite(t["e_dm"]) & (t["e_dm"] > 0), np.maximum(t["e_dm"], 0.5 * typical), typical)
    t["rank"] = typical
    g = t.groupby(["name", "method"], sort=False)
    per = g.agg(dm=("dm", "median"), e_dm=("err", "median"), rank=("rank", "first"), n=("dm", "size"), ref=("ref", "first")).reset_index()
    per = per.sort_values(["name", "rank", "e_dm"]).drop_duplicates("name")
    # an early-type galaxy: measured by the fundamental plane or SBF, never by Tully-Fisher
    kinds = t.groupby("name")["method"].agg(lambda m: (bool(m.isin(["FP", "SBF"]).any()), bool((m == "TF").any())))
    per["early"] = per["name"].map(lambda n: kinds[n][0] and not kinds[n][1])
    return per.drop(columns="rank").reset_index(drop=True)


def j_position(name: str) -> tuple[float, float] | None:
    """RA, Dec (degrees) from a designation with J2000 coordinates, else None."""
    m = J_RE.search(name)
    if not m:
        return None

    def frac(s: str | None) -> float:
        if not s:
            return 0.0
        return float(s) if s.startswith(".") else float("0." + s)

    h, mi, s = int(m.group(1)), int(m.group(2)), int(m.group(3)) + frac(m.group(4))
    d, dm_, ds = int(m.group(6)), int(m.group(7)), int(m.group(8)) + frac(m.group(9))
    if h > 23 or mi > 59 or s >= 60 or d > 90 or dm_ > 59 or ds >= 60:
        return None
    ra = 15 * (h + mi / 60 + s / 3600)
    dec = (d + dm_ / 60 + ds / 3600) * (-1 if m.group(5) == "-" else 1)
    return ra, dec


def leda_key(name: str) -> str:
    """A designation in HyperLEDA's spelling, for comparing names (upper case, no spaces, no
    leading zeros in numbers, ESO's "G" dropped): "ESO 563- G 028" -> "ESO563-28"."""
    s = name.upper().replace(" ", "")
    s = re.sub(r"^ESO(\d+)-[A-Z]*(\d+)", r"ESO\1-\2", s)
    s = re.sub(r"^MESSIER", "M", s)
    return re.sub(r"(?<![0-9.])0+(?=\d)", "", s)


#: HyperLEDA's fields besides the names: morphological type, log of the D25 diameter (0.1'), log of
#: the axis ratio, position angle, total B magnitude
LEDA_FIELDS = ["t", "logd25", "logr25", "pa", "bt"]


def _float(v: str) -> float:
    try:
        return float(v)
    except ValueError:
        return float("nan")


def _leda_batch(names: list[str]) -> list[tuple[int, str, float, float, str, list[float]]]:
    sql = "objname in (%s)" % ",".join("objname('%s')" % n.replace("'", "") for n in names)
    data = {"n": "meandata", "c": "o", "of": "1,leda,simbad", "nra": "l", "nakd": "1",
            "d": "pgc,objname,al2000,de2000," + ",".join(LEDA_FIELDS) + ",hl_names(pgc)", "sql": sql, "ob": "", "a": "csv"}
    r = request("POST", LEDA_URL, data=data, timeout=300)
    out = []
    for line in r.text.splitlines():
        if not line or line.startswith("#") or line.startswith("pgc"):
            continue
        f = line.split("\t")
        k = len(LEDA_FIELDS)
        if len(f) < 5 + k:
            continue
        try:
            out.append((int(f[0]), f[1], float(f[2]) * 15.0, float(f[3]), f[4 + k], [_float(v.strip()) for v in f[4 : 4 + k]]))
        except ValueError:
            continue
    return out


def resolve(names: list[str], refresh: bool = False, batch: int = 300) -> pd.DataFrame:
    """PGC number, position (degrees) and HyperLEDA's type, size, shape and B magnitude of each name
    that HyperLEDA knows: name, pgc, ra, dec, t, logd25, logr25, pa, bt. Cached in nedd_leda.csv
    (names asked for and not found are kept too, with pgc 0)."""
    path = CACHE / "nedd_leda.csv"
    cols = ["name", "pgc", "ra", "dec", *LEDA_FIELDS]
    known = pd.read_csv(path, dtype={"name": str}) if path.exists() and not refresh else pd.DataFrame(columns=cols)
    if any(c not in known for c in cols):
        # a cache from before the fields were asked for: asked again
        known = pd.DataFrame(columns=cols)
    asked = set(known["name"])
    todo = [n for n in dict.fromkeys(names) if n not in asked]
    if todo:
        log.info("HyperLEDA: resolving %d names (%d cached)", len(todo), len(asked))
    found: list[dict] = []
    t0 = time.time()
    for k in range(0, len(todo), batch):
        part = todo[k : k + batch]
        keys = {leda_key(n): n for n in part}
        got: dict[str, dict] = {}
        for pgc, objname, ra, dec, aliases, extra in _leda_batch(part):
            for alias in [objname, *aliases.split(",")]:
                n = keys.get(leda_key(alias))
                if n is not None and n not in got:
                    got[n] = {"name": n, "pgc": pgc, "ra": ra, "dec": dec, **dict(zip(LEDA_FIELDS, extra))}
        found += [got.get(n, {"name": n, "pgc": 0, "ra": np.nan, "dec": np.nan}) for n in part]
        if (k // batch) % 20 == 19 or k + batch >= len(todo):
            # saved as it goes: an interrupted run continues where it stopped
            known = pd.concat([known, pd.DataFrame(found)], ignore_index=True)
            found = []
            known.to_csv(path, index=False)
            log.info("HyperLEDA: %d of %d names, %.0f s", min(k + batch, len(todo)), len(todo), time.time() - t0)
    return known[known["name"].isin(set(names))].reset_index(drop=True)


def galaxies(refresh: bool = False) -> pd.DataFrame:
    """NED-D's galaxies with a position: name, pgc (0: none), ra, dec, dm, e_dm, method, n, ref, early
    and HyperLEDA's t, logd25, logr25, pa, bt (NaN where unknown)."""
    best = best_distances(load(refresh))
    pos = resolve(best["name"].tolist(), refresh=False).drop_duplicates("name")
    g = best.merge(pos, on="name", how="left")
    g["pgc"] = g["pgc"].fillna(0).astype(np.int64)
    # not in HyperLEDA: the position its designation carries
    miss = ~np.isfinite(g["ra"].to_numpy(dtype=float))
    for i in np.flatnonzero(miss):
        p = j_position(g.at[i, "name"])
        if p:
            g.at[i, "ra"], g.at[i, "dec"] = p
    g = g[np.isfinite(g["ra"].to_numpy(dtype=float))].reset_index(drop=True)
    log.info("NED-D: %d galaxies with a position (%d with a PGC number)", len(g), int((g["pgc"] > 0).sum()))
    return g


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    g = galaxies()
    print(g.describe())


if __name__ == "__main__":
    main()
