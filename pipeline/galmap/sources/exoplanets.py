"""NASA Exoplanet Archive: number of confirmed planets per host star.

The Planetary Systems Composite table (pscomppars) has one row per confirmed planet with its host's
Gaia DR3, HIP and HD identifiers. Hosts are matched to our stars by Gaia DR3 id, then HIP, then HD,
then by position (and distance) for the rest.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from ..coords import propagate, unit_vectors
from ..download import exact_int64

log = logging.getLogger(__name__)

TAP = "https://exoplanetarchive.ipac.caltech.edu/TAP"

SOURCE_INFO = {
    "key": "exoplanets",
    "title": "NASA Exoplanet Archive, Planetary Systems Composite Parameters",
    "citation": "This research has made use of the NASA Exoplanet Archive, which is operated by the California "
    "Institute of Technology, under contract with the National Aeronautics and Space Administration under the "
    "Exoplanet Exploration Program. DOI 10.26133/NEA13.",
    "url": "https://exoplanetarchive.ipac.caltech.edu/",
}


def _number(s: pd.Series, prefix: str) -> pd.Series:
    return pd.to_numeric(s.fillna("").astype(str).str.extract(rf"^{prefix}\s*(\d+)")[0], errors="coerce").astype("Int64")


def load(refresh: bool = False) -> pd.DataFrame:
    """One row per host star: hostname, gaia, hip, hd, ra, dec, dist_pc, planets (from the table
    galmap.planets downloads: one download for the counts, the hosts and the orbits)."""
    from ..planets import load as load_planets

    return hosts_of(load_planets(refresh))


def hosts_of(raw: pd.DataFrame) -> pd.DataFrame:
    """One row per host star of the archive's planet table (see load)."""
    hosts = raw.groupby("hostname").agg(
        planets=("pl_name", "nunique"),
        hip_name=("hip_name", "first"),
        hd_name=("hd_name", "first"),
        gaia_dr3_id=("gaia_dr3_id", "first"),
        ra=("ra", "first"),
        dec=("dec", "first"),
        sy_dist=("sy_dist", "first"),
    ).reset_index()
    gaia = hosts["gaia_dr3_id"].fillna("").astype(str).str.extract(r"^Gaia DR3\s+(\d+)")[0]
    out = pd.DataFrame(
        {
            "hostname": hosts["hostname"],
            "planets": hosts["planets"].astype(int),
            "gaia": exact_int64(gaia),
            "hip": _number(hosts["hip_name"], "HIP"),
            "hd": _number(hosts["hd_name"], "HD"),
            "ra": pd.to_numeric(hosts["ra"], errors="coerce"),
            "dec": pd.to_numeric(hosts["dec"], errors="coerce"),
            "dist_pc": pd.to_numeric(hosts["sy_dist"], errors="coerce"),
        }
    )
    log.info("exoplanets: %d confirmed planets around %d host stars", len(raw), len(out))
    return out


def attach(stars: pd.DataFrame, hosts: pd.DataFrame, matched_out: list | None = None, names_out: list | None = None) -> np.ndarray:
    """Number of confirmed planets per star row (0 for none). `matched_out`: receives the mask of
    the hosts that were matched (the rest may belong to bulk stars, see by_gaia); `names_out`: the
    archive's host name per star row (None for none)."""
    n = len(stars)
    planets = np.zeros(n, dtype=np.int64)
    taken = np.zeros(n, bool)
    matched = np.zeros(len(hosts), bool)
    host_of = np.full(n, -1, dtype=np.int64)
    counts = {"name": 0, "gaia": 0, "hip": 0, "hd": 0, "position": 0}
    # hosts added from the archive (or found next to a star of the map) carry its host name
    if "archive_host" in stars:
        row_of_host = {h: k for k, h in enumerate(hosts["hostname"])}
        for i, h in enumerate(stars["archive_host"].to_numpy(dtype=object)):
            k = row_of_host.get(h) if isinstance(h, str) else None
            if k is None or matched[k] or taken[i]:
                continue
            planets[i], taken[i], matched[k], host_of[i] = int(hosts["planets"].iat[k]), True, True, k
            counts["name"] += 1
    for key in ("gaia", "hip", "hd"):
        if key not in stars:
            continue
        col = stars[key].astype("Int64")
        pos = pd.Series(np.arange(n), index=col).loc[lambda x: x.index.notna()]
        pos = pos[~pos.index.duplicated(keep=False)]
        for h, (v, k) in enumerate(zip(hosts[key], hosts["planets"])):
            if matched[h] or pd.isna(v) or v not in pos.index:
                continue
            i = int(pos[v])
            if taken[i]:
                continue
            planets[i], taken[i], matched[h], host_of[i] = k, True, True, h
            counts[key] += 1
    # the rest by position (J2000, within 3") and distance (within 20 %)
    rest = np.nonzero(~matched & hosts["ra"].notna().to_numpy())[0]
    if len(rest):
        ra, dec = propagate(
            stars["ra"].to_numpy(float), stars["dec"].to_numpy(float),
            np.nan_to_num(stars["pmra"].to_numpy(float)), np.nan_to_num(stars["pmdec"].to_numpy(float)),
            2000.0 - stars["epoch"].to_numpy(float),
        )
        ok = np.isfinite(ra) & np.isfinite(dec)
        idx = np.nonzero(ok)[0]
        tree = cKDTree(unit_vectors(ra[idx], dec[idx]))
        hu = unit_vectors(hosts["ra"].to_numpy(float)[rest], hosts["dec"].to_numpy(float)[rest])
        dist, k = tree.query(hu, distance_upper_bound=3.0 / 206264.806)
        dpc = stars["dist_pc"].to_numpy(float) if "dist_pc" in stars else 1000.0 / stars["plx"].to_numpy(float)
        for j, h in enumerate(rest):
            if not np.isfinite(dist[j]):
                continue
            i = int(idx[k[j]])
            hd_ = hosts["dist_pc"].iloc[h]
            if taken[i] or (np.isfinite(hd_) and abs(dpc[i] - hd_) > 0.2 * hd_):
                continue
            planets[i], taken[i], matched[h], host_of[i] = int(hosts["planets"].iloc[h]), True, True, h
            counts["position"] += 1
    log.info(
        "exoplanets: %d of %d hosts matched (%s); %d planets on the map",
        int(matched.sum()), len(hosts), ", ".join(f"{v} by {k}" for k, v in counts.items()), int(planets.sum()),
    )
    if matched_out is not None:
        matched_out.append(matched)
    if names_out is not None:
        names = hosts["hostname"].to_numpy(dtype=object)
        names_out.append(np.where(host_of >= 0, names[np.maximum(host_of, 0)], None))
    return planets


def by_gaia(hosts: pd.DataFrame, matched: np.ndarray | None = None) -> pd.Series:
    """Planets per Gaia DR3 id of the hosts not matched to a core star (bulk stars, galmap.bulk)."""
    h = hosts if matched is None else hosts[~matched]
    g = h["gaia"].astype("Int64")
    s = pd.Series(h["planets"].to_numpy(), index=g).loc[lambda x: x.index.notna()]
    s = s[~s.index.duplicated(keep=False)]
    s.index = s.index.astype("int64")
    return s
