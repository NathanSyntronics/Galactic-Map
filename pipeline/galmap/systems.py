"""Grouping of stars into gravitationally bound multiple systems.

Links come from
  * the 20 pc census hierarchy (authoritative within 20 pc),
  * the Gliese system grouping of HYG (`base`), checked for consistent distances,
  * a wide-binary heuristic for Gaia stars beyond the census volume: small projected
    separation, consistent parallaxes and a tangential velocity difference below the
    escape velocity of a ~2 solar-mass pair (cf. El-Badry, Rix & Heintz 2021),
and are merged with union-find.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from .coords import propagate, unit_vectors
from .flags import Flag

log = logging.getLogger(__name__)

AU_PER_PC = 206_264.806
MAX_SEP_AU = 50_000.0  # ~0.24 pc / 0.8 ly
MAX_SYSTEM_SIZE = 8
MAX_CATALOG_SEP_LY = 2.0


class UnionFind:
    def __init__(self, n: int):
        self.p = np.arange(n)

    def find(self, a: int) -> int:
        p = self.p
        root = a
        while p[root] != root:
            root = p[root]
        while p[a] != root:
            p[a], a = root, p[a]
        return root

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[max(ra, rb)] = min(ra, rb)


def _group_links(keys: pd.Series) -> list[tuple[int, int]]:
    links = []
    k = keys.dropna()
    for _, idx in k.groupby(k).groups.items():
        idx = list(idx)
        for j in idx[1:]:
            links.append((idx[0], j))
    return links


def wide_binary_links(s: pd.DataFrame, min_dist_pc: float = 19.0) -> list[tuple[int, int]]:
    """Candidate wide binaries among stars with Gaia-quality astrometry beyond the census volume."""
    plx = s["plx"].to_numpy(float)
    err = s["plx_err"].to_numpy(float)
    pmra = s["pmra"].to_numpy(float)
    pmdec = s["pmdec"].to_numpy(float)
    ok = np.isfinite(err) & np.isfinite(pmra) & (plx / err > 10) & (plx < 1000 / min_dist_pc) & (plx > 1.0)
    idx = np.nonzero(ok)[0]
    ra, dec = propagate(s["ra"].to_numpy(float)[idx], s["dec"].to_numpy(float)[idx], pmra[idx], pmdec[idx], 2016.0 - s["epoch"].to_numpy(float)[idx])
    u = unit_vectors(ra, dec)
    tree = cKDTree(u)
    # search radius: MAX_SEP_AU projected at the star's distance (chord length ~ angle)
    theta = MAX_SEP_AU / AU_PER_PC * plx[idx] / 1000.0
    pairs = tree.query_ball_point(u, r=theta)
    links = []
    crowded = 0
    for a, cand in enumerate(pairs):
        cand = [b for b in cand if b > a]
        if not cand:
            continue
        if len(pairs[a]) > 4:  # crowded field (open cluster): skip, chance alignments dominate
            crowded += 1
            continue
        ia = idx[a]
        for b in cand:
            ib = idx[b]
            if len(pairs[b]) > 4:
                continue
            # parallax consistency (3 sigma + 2 %)
            dp = abs(plx[ia] - plx[ib])
            if dp > 3 * np.hypot(err[ia], err[ib]) + 0.02 * plx[ia]:
                continue
            sep_rad = np.arccos(np.clip(np.dot(u[a], u[b]), -1, 1))
            sep_au = sep_rad / (np.pi / 180 / 3600) * 1000.0 / plx[ia]
            if sep_au <= 0 or sep_au > MAX_SEP_AU:
                continue
            dmu = np.hypot(pmra[ia] - pmra[ib], pmdec[ia] - pmdec[ib])  # mas/yr
            dv = 4.74047 * dmu / plx[ia]  # km/s
            v_esc = 42.1 * np.sqrt(2.0 / sep_au)  # 2 Msun total
            if dv > 1.5 * v_esc + 0.5:
                continue
            links.append((ia, ib))
    log.info("wide-binary heuristic: %d links (%d crowded stars skipped)", len(links), crowded)
    return links


def assign_systems(s: pd.DataFrame) -> pd.DataFrame:
    s = s.copy()
    n = len(s)
    uf = UnionFind(n)
    xyz = s[["x", "y", "z"]].to_numpy(float)

    census_links = _group_links(s["system_row"].astype("Int64"))
    for a, b in census_links:
        uf.union(a, b)
    hyg_links = _group_links(s["hyg_base"]) if "hyg_base" in s else []
    rejected = 0
    for a, b in hyg_links:
        if np.linalg.norm(xyz[a] - xyz[b]) <= MAX_CATALOG_SEP_LY:
            uf.union(a, b)
        else:
            rejected += 1
    wb = wide_binary_links(s)
    # wide-binary links are only accepted if they do not grow systems beyond a sane size
    for a, b in wb:
        uf.union(a, b)
    roots = np.array([uf.find(i) for i in range(n)])
    size = pd.Series(roots).map(pd.Series(roots).value_counts()).to_numpy()
    log.info(
        "systems: %d census links, %d HYG links (%d rejected: inconsistent distances), %d wide-binary links",
        len(census_links), len(hyg_links) - rejected, rejected, len(wb),
    )
    # break up implausibly large groups that came only from the heuristic
    big = size > MAX_SYSTEM_SIZE
    if big.any():
        uf = UnionFind(n)
        for a, b in census_links:
            uf.union(a, b)
        for a, b in hyg_links:
            if np.linalg.norm(xyz[a] - xyz[b]) <= MAX_CATALOG_SEP_LY:
                uf.union(a, b)
        bad_roots = set(roots[big].tolist())
        for a, b in wb:
            if roots[a] not in bad_roots:
                uf.union(a, b)
        roots = np.array([uf.find(i) for i in range(n)])
        size = pd.Series(roots).map(pd.Series(roots).value_counts()).to_numpy()

    multi = size > 1
    ids = np.full(n, -1, dtype=np.int64)
    uniq = {r: k for k, r in enumerate(sorted(set(roots[multi].tolist())))}
    ids[multi] = [uniq[r] for r in roots[multi]]
    s["system_id"] = ids
    logl = s["logl"].to_numpy(float)
    lum = np.where(np.isfinite(logl), logl, -9.0)
    flags = s["flags"].to_numpy(np.int64).copy()
    flags |= np.where(multi, Flag.IN_SYSTEM, 0)
    # primary = most luminous member
    order = pd.DataFrame({"sid": ids, "lum": lum}).reset_index()
    prim = order[order.sid >= 0].sort_values(["sid", "lum"], ascending=[True, False]).drop_duplicates("sid")["index"].to_numpy()
    flags[prim] |= Flag.SYSTEM_PRIMARY
    s["flags"] = flags
    log.info("systems: %d multiple systems with %d stars", len(uniq), int(multi.sum()))
    return s


def system_table(s: pd.DataFrame) -> pd.DataFrame:
    """One row per system: id, name (from the primary), member count, luminosity-weighted centroid."""
    m = s[s["system_id"] >= 0]
    if m.empty:
        return pd.DataFrame(columns=["system_id", "name_en", "name_de", "members", "cx", "cy", "cz"])
    w = 10 ** np.clip(m["logl"].fillna(-3).to_numpy(float), -6, 7)
    g = pd.DataFrame({"sid": m["system_id"].to_numpy(), "w": w, "wx": w * m["x"].to_numpy(), "wy": w * m["y"].to_numpy(), "wz": w * m["z"].to_numpy()})
    agg = g.groupby("sid").agg(members=("w", "size"), w=("w", "sum"), wx=("wx", "sum"), wy=("wy", "sum"), wz=("wz", "sum"))
    prim = m[(m["flags"] & Flag.SYSTEM_PRIMARY) != 0].set_index("system_id")
    out = pd.DataFrame(
        {
            "system_id": agg.index,
            "members": agg["members"].to_numpy(),
            "cx": (agg["wx"] / agg["w"]).to_numpy(),
            "cy": (agg["wy"] / agg["w"]).to_numpy(),
            "cz": (agg["wz"] / agg["w"]).to_numpy(),
        }
    )
    out["name_en"] = out["system_id"].map(prim["system_name_en"]) if "system_name_en" in prim else None
    out["name_de"] = out["system_id"].map(prim["system_name_de"]) if "system_name_de" in prim else None
    return out
