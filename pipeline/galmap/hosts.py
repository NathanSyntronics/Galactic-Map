"""The hosts of known planets that no other catalogue on the map has (Kepler, K2 and TESS stars,
the hosts of microlensing planets, ...): added as stars from the NASA Exoplanet Archive, so that all
confirmed planets have a star (docs/PLANETS.md).

Each such host becomes a star at the archive's position and distance, with its magnitudes,
temperature and spectral type, flagged SRC_EXOPLANET and named by its archive name ("Kepler-90").
A host with a star of the map within 3" (plus 20 years of its proper motion; another distance or
epoch for the same star, most likely) is not added: that star is its host (column archive_host).
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from .coords import propagate, unit_vectors
from .derive import MAX_DIST_PC
from .flags import Desig, Flag, Rank
from .sources import exoplanets

log = logging.getLogger(__name__)

# a star of the map this close to a host (arcsec, plus 20 years of the host's proper motion) is
# taken to be the host
SAME_STAR_ARCSEC = 3.0
SAME_STAR_PM_YEARS = 20.0


def _num(s: pd.Series) -> np.ndarray:
    return pd.to_numeric(s, errors="coerce").to_numpy(dtype=float)


def host_rows(raw: pd.DataFrame, hosts: pd.DataFrame, missing: np.ndarray) -> pd.DataFrame:
    """Star rows (the merged table's columns) of the hosts in `hosts` marked by `missing`."""
    first = raw.groupby("hostname").first()
    h = first.loc[hosts["hostname"][missing]].reset_index()
    dist = _num(h["sy_dist"])
    err = np.fmax(np.abs(_num(h["sy_disterr1"])), np.abs(_num(h["sy_disterr2"])))
    plx = 1000.0 / dist
    spect = h["st_spectype"].astype(object).where(h["st_spectype"].astype(str).str.strip() != "", None)
    return pd.DataFrame(
        {
            "src": Flag.SRC_EXOPLANET,
            "ra": _num(h["ra"]),
            "dec": _num(h["dec"]),
            "epoch": 2016.0,  # (Gaia positions, mostly; distant stars hardly move anyway)
            "plx": plx,
            "plx_err": plx * err / dist,
            # the distances of microlensing hosts come from models of the event, not a parallax
            "plx_src": np.where(h["discoverymethod"].astype(str) == "Microlensing", "exoplanet_est", "exoplanet"),
            "pmra": _num(h["sy_pmra"]),
            "pmdec": _num(h["sy_pmdec"]),
            "ruwe": np.nan,
            "vmag": _num(h["sy_vmag"]),
            "gmag": _num(h["sy_gaiamag"]),
            "bp_rp": np.nan,
            "bv": np.nan,
            "jmag": np.nan,
            "spect": spect,
            "teff_cat": _num(h["st_teff"]),
            # (nullable integers: a Gaia id as a float loses its last digits)
            "gaia": hosts["gaia"][missing].astype("Int64").reset_index(drop=True),
            "hip": hosts["hip"][missing].astype("Int64").reset_index(drop=True),
            "hd": hosts["hd"][missing].astype("Int64").reset_index(drop=True),
            "wd_prob": np.nan,
            "name_2mass": None,
            "is_sun": False,
            "host_name": h["hostname"].to_numpy(),
            "archive_host": h["hostname"].to_numpy(),
        }
    )


def add_hosts(s: pd.DataFrame, raw: pd.DataFrame) -> pd.DataFrame:
    """Adds the hosts of the archive's planets that are not among the stars `s` (matched as the
    planet counts are: Gaia DR3, HIP, HD, position and distance)."""
    hosts = exoplanets.hosts_of(raw)
    matched: list = []
    counts = exoplanets.attach(s, hosts, matched)
    ok = np.isfinite(hosts["ra"]) & np.isfinite(hosts["dec"]) & np.isfinite(hosts["dist_pc"]) & (hosts["dist_pc"] > 0)
    ok &= hosts["dist_pc"] <= MAX_DIST_PC
    missing = (~matched[0] & ok).to_numpy().copy()
    # not when a star of the map lies within 3" plus 20 years of the host's proper motion (the same
    # star at another distance or epoch, most likely): that star is the host
    ra, dec = propagate(
        s["ra"].to_numpy(float), s["dec"].to_numpy(float),
        np.nan_to_num(s["pmra"].to_numpy(float)), np.nan_to_num(s["pmdec"].to_numpy(float)),
        2016.0 - np.nan_to_num(s["epoch"].to_numpy(float), nan=2016.0),
    )
    have = np.nonzero(np.isfinite(ra) & np.isfinite(dec))[0]
    tree = cKDTree(unit_vectors(ra[have], dec[have]))
    first = raw.groupby("hostname").first()
    pm = np.hypot(_num(first.loc[hosts["hostname"], "sy_pmra"]), _num(first.loc[hosts["hostname"], "sy_pmdec"]))
    radius = (SAME_STAR_ARCSEC + SAME_STAR_PM_YEARS * np.nan_to_num(pm) / 1000.0) / 206264.806
    archive_host = s["archive_host"].to_numpy(dtype=object).copy() if "archive_host" in s else np.full(len(s), None, dtype=object)
    near = 0
    for k in np.nonzero(missing)[0]:
        hu = unit_vectors(np.array([hosts["ra"].iat[k]]), np.array([hosts["dec"].iat[k]]))[0]
        d, j = tree.query(hu, distance_upper_bound=radius[k])
        # (a star that hosts other planets already is another star: a companion with planets of its own)
        if np.isfinite(d) and counts[have[j]] == 0 and archive_host[have[j]] is None:
            missing[k] = False
            near += 1
            archive_host[have[j]] = hosts["hostname"].iat[k]
    s = s.copy(deep=False)
    s["archive_host"] = archive_host
    rows = host_rows(raw, hosts, missing)
    log.info(
        "planet hosts: %d of %d not on the map; %d added from the archive, %d found next to a star of the map (that star is the host), %d without a distance",
        int((~matched[0]).sum()), len(hosts), len(rows), near, int((~matched[0] & ~ok).sum()),
    )
    out = pd.concat([s, rows], ignore_index=True)
    # the nullable integer and boolean columns keep their type (a Gaia id as a float loses digits)
    for c in s.columns:
        if str(s[c].dtype) in ("Int64", "boolean") and out[c].dtype != s[c].dtype:
            out[c] = out[c].astype(s[c].dtype)
    return out


def name_hosts(s: pd.DataFrame) -> int:
    """The added hosts are named by their archive name where the naming found no better one
    ("OGLE-2005-BLG-390L" ranks as a catalogue number), and designated by it where they have no
    catalogue designation."""
    if "host_name" not in s:
        return 0
    host = s["host_name"].to_numpy(dtype=object)
    rows = np.nonzero(pd.notna(host))[0]
    rank = s["name_rank"].to_numpy().copy()
    en = s["name_en"].to_numpy(dtype=object).copy()
    de = s["name_de"].to_numpy(dtype=object).copy()
    dcat = s["desig_cat"].to_numpy().copy()
    dstr = s["desig_str"].to_numpy(dtype=object).copy()
    named = 0
    for i in rows:
        if rank[i] > Rank.NAMED_MAX:
            rank[i], en[i], de[i] = Rank.SURVEY, host[i], None
            named += 1
        if dcat[i] == Desig.STRING and not (isinstance(dstr[i], str) and dstr[i]):
            dstr[i] = host[i]
    s["name_rank"], s["name_en"], s["name_de"], s["desig_str"] = rank, en, de, dstr
    log.info("planet hosts: %d added hosts named by their archive name", named)
    return named
