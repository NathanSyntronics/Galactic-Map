"""Cross-matching and merging of the catalogues into one table with one row per star.

Precedence (best first):
  1. 20 pc census (Kirkpatrick+2024) for everything within 20 pc
  2. Gaia DR3 astrometry (via GCNS within 100 pc, via the Tycho-2/Hipparcos cross-match beyond)
  3. AT-HYG / HYG (Hipparcos, Gliese) for stars without usable Gaia data (e.g. Sirius, Vega)
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from .coords import propagate, unit_vectors
from .flags import Flag

log = logging.getLogger(__name__)

ARCSEC = np.pi / (180 * 3600)
COMMON_EPOCH = 2016.0
# Stars closer than this (pc) must be confirmed by the 20 pc census unless their own parallax is precise.
CENSUS_LIMIT_PC = 19.0


def _empty_like(n: int) -> dict:
    return {}


# ---------------------------------------------------------------------------------------------
# AT-HYG + Gaia astrometry


def link_gaia(athyg: pd.DataFrame, gaia: pd.DataFrame) -> pd.DataFrame:
    """Attach Gaia DR3 astrometry to AT-HYG rows, rejecting implausible cross-identifications."""
    g = gaia.set_index("source_id")
    df = athyg.copy()
    has = df["gaia"].notna() & df["gaia"].isin(g.index)
    idx = df.loc[has, "gaia"].astype("int64").to_numpy()
    gcols = ["ra", "dec", "parallax", "parallax_error", "pmra", "pmdec", "ruwe", "phot_g_mean_mag", "bp_rp", "parallax_zp"]
    sub = g.loc[idx, gcols].to_numpy()
    for j, c in enumerate(gcols):
        col = np.full(len(df), np.nan)
        col[has.to_numpy()] = sub[:, j].astype(float)
        df["g_" + c] = col

    # Photometric sanity check: Gaia G - V lies between about -3.5 (late M) and +0.6 (blue stars).
    gv = df["g_phot_g_mean_mag"] - df["vmag"]
    bad = has & ((gv < -4.0) | (gv > 1.0))
    # Several AT-HYG rows can share one Gaia id; keep the link only for the best photometric match.
    dup = df["gaia"].duplicated(keep=False) & df["gaia"].notna()
    if dup.any():
        tmp = pd.DataFrame({"gaia": df.loc[dup, "gaia"], "err": (gv[dup] + 0.3).abs()})
        best = tmp.sort_values("err").drop_duplicates("gaia").index
        loser = dup & ~df.index.isin(best)
        bad |= loser
    log.info("AT-HYG: %d rows linked to Gaia DR3 astrometry, %d links rejected", int((has & ~bad).sum()), int((has & bad).sum()))
    for c in gcols:
        df.loc[bad, "g_" + c] = np.nan
    df["gaia_ok"] = has & ~bad
    return df


def athyg_rows(athyg_g: pd.DataFrame, hyg: pd.DataFrame) -> pd.DataFrame:
    """Normalised star rows from AT-HYG (with Gaia astrometry where available)."""
    a = athyg_g
    ok = a["gaia_ok"].to_numpy()
    plx_g = a["g_parallax"].to_numpy() - a["g_parallax_zp"].fillna(-0.017).to_numpy()
    use_g = ok & np.isfinite(plx_g) & (plx_g > 0)
    out = pd.DataFrame(index=a.index)
    out["src"] = Flag.SRC_ATHYG
    out["ra"] = np.where(use_g, a["g_ra"], a["ra_deg"])
    out["dec"] = np.where(use_g, a["g_dec"], a["dec"])
    out["epoch"] = np.where(use_g, COMMON_EPOCH, a["epoch"])
    plx_a = 1000.0 / a["dist"].to_numpy()
    out["plx"] = np.where(use_g, plx_g, plx_a)
    out["plx_err"] = np.where(use_g, a["g_parallax_error"], np.nan)
    out["plx_src"] = np.where(use_g, "gaia", a["dist_src"].fillna("N").astype(str).str.lower())
    out["pmra"] = np.where(ok, a["g_pmra"], a["pmra"])
    out["pmdec"] = np.where(ok, a["g_pmdec"], a["pmdec"])
    out["pmra"] = out["pmra"].fillna(a["pmra"])
    out["pmdec"] = out["pmdec"].fillna(a["pmdec"])
    out["ruwe"] = a["g_ruwe"]
    out["vmag"] = a["vmag"]
    out["gmag"] = a["g_phot_g_mean_mag"]
    out["bp_rp"] = a["g_bp_rp"]
    out["bv"] = a["bv"]
    out["jmag"] = np.nan
    out["spect"] = a["spect"].astype(object).where(a["spect"].notna(), None)
    out["teff_cat"] = np.nan
    out["gaia"] = a["gaia"].where(a["gaia_ok"], pd.NA).astype("Int64")
    for c in ("hip", "hd", "hr", "hyg", "flam"):
        out[c] = a[c].astype("Int64")
    out["tyc"] = a["tyc"].astype(object).where(a["tyc"].notna(), None)
    out["gj"] = a["gj"]
    out["bayer"] = a["bayer"].astype(object).where(a["bayer"].notna(), None)
    out["con"] = a["con"].astype(object).where(a["con"].notna(), None)
    out["proper"] = a["proper"].astype(object).where(a["proper"].notna(), None)
    out["is_sun"] = a["is_sun"].to_numpy()
    out = out.merge(hyg, on="hyg", how="left")
    out["wd_prob"] = np.nan
    out["name_2mass"] = None
    return out


# ---------------------------------------------------------------------------------------------
# GCNS


def merge_gcns(stars: pd.DataFrame, gcns: pd.DataFrame) -> pd.DataFrame:
    s = stars
    pos = pd.Series(np.arange(len(s)), index=s["gaia"].astype("Int64"))
    pos = pos[pos.index.notna() & ~pos.index.duplicated()]
    key = gcns["source_id"].astype("Int64")
    matched = key.isin(pos.index)
    gi = pos.loc[key[matched]].to_numpy()
    gm = gcns[matched]
    log.info("GCNS: %d rows, %d already in AT-HYG, %d new", len(gcns), len(gi), int((~matched).sum()))

    # update the matched AT-HYG rows with the GCNS astrometry (identical Gaia (E)DR3 solution)
    s = s.copy()
    col = s.columns.get_loc
    s.iloc[gi, col("plx")] = gm["plx"].to_numpy()
    s.iloc[gi, col("plx_err")] = gm["plx_err"].to_numpy()
    s.iloc[gi, col("plx_src")] = "gaia"
    s.iloc[gi, col("ra")] = gm["ra"].to_numpy()
    s.iloc[gi, col("dec")] = gm["dec"].to_numpy()
    s.iloc[gi, col("epoch")] = COMMON_EPOCH
    s.iloc[gi, col("pmra")] = gm["pmra"].to_numpy()
    s.iloc[gi, col("pmdec")] = gm["pmdec"].to_numpy()
    s.iloc[gi, col("wd_prob")] = gm["wd_prob"].to_numpy()
    s.iloc[gi, col("name_2mass")] = gm["name_2mass"].astype(object).to_numpy()
    bp = s["bp_rp"].to_numpy().copy()
    bp[gi] = np.where(np.isnan(bp[gi]), gm["bp_rp"].to_numpy(), bp[gi])
    s["bp_rp"] = bp
    gmag = s["gmag"].to_numpy().copy()
    gmag[gi] = np.where(np.isnan(gmag[gi]), gm["gmag"].to_numpy(), gmag[gi])
    s["gmag"] = gmag
    src = s["src"].to_numpy().copy()
    src[gi] |= Flag.SRC_GCNS
    s["src"] = src

    new = gcns[~matched]
    add = pd.DataFrame(
        {
            "src": Flag.SRC_GCNS,
            "ra": new["ra"].to_numpy(),
            "dec": new["dec"].to_numpy(),
            "epoch": COMMON_EPOCH,
            "plx": new["plx"].to_numpy(),
            "plx_err": new["plx_err"].to_numpy(),
            "plx_src": "gaia",
            "pmra": new["pmra"].to_numpy(),
            "pmdec": new["pmdec"].to_numpy(),
            "ruwe": new["ruwe"].to_numpy(),
            "vmag": np.nan,
            "gmag": new["gmag"].to_numpy(),
            "bp_rp": new["bp_rp"].to_numpy(),
            "bv": np.nan,
            "jmag": new["jmag"].to_numpy(),
            "spect": None,
            "teff_cat": np.nan,
            "gaia": new["source_id"].astype("Int64").to_numpy(),
            "wd_prob": new["wd_prob"].to_numpy(),
            "name_2mass": new["name_2mass"].astype(object).to_numpy(),
            "is_sun": False,
        }
    )
    return pd.concat([s, add], ignore_index=True)


# ---------------------------------------------------------------------------------------------
# 20 pc census


def _positions_at(ra, dec, pmra, pmdec, epoch, target=COMMON_EPOCH):
    return propagate(ra, dec, pmra, pmdec, target - np.asarray(epoch, dtype=float))


def merge_census(stars: pd.DataFrame, census: pd.DataFrame) -> pd.DataFrame:
    """Match census rows to catalogue rows (Gaia id, HIP, then position) and merge them in."""
    s = stars.reset_index(drop=True).copy()
    c = census.reset_index(drop=True)
    n = len(c)
    match = np.full(n, -1)

    gaia_pos = pd.Series(np.arange(len(s)), index=s["gaia"].astype("Int64"))
    gaia_pos = gaia_pos[gaia_pos.index.notna() & ~gaia_pos.index.duplicated()]
    hip_pos = pd.Series(np.arange(len(s)), index=s["hip"].astype("Int64"))
    hip_pos = hip_pos[hip_pos.index.notna() & ~hip_pos.index.duplicated()]
    for i in range(n):
        g = c.at[i, "gaia"]
        h = c.at[i, "hip"]
        if pd.notna(g) and g in gaia_pos.index:
            match[i] = gaia_pos[g]
        elif pd.notna(h) and h in hip_pos.index:
            match[i] = hip_pos[h]

    # positional matching for leaves without an id match
    leaf = c["is_leaf"].to_numpy()
    need = leaf & (match < 0) & c["ra"].notna().to_numpy()
    if need.any():
        sra, sdec = _positions_at(s["ra"], s["dec"], s["pmra"], s["pmdec"], s["epoch"])
        near = s["plx"].to_numpy() > 30  # only stars within ~33 pc can be census objects
        idx_near = np.nonzero(near)[0]
        tree = cKDTree(unit_vectors(sra[idx_near], sdec[idx_near]))
        ci = np.nonzero(need)[0]
        cra, cdec = _positions_at(c.loc[ci, "ra"], c.loc[ci, "dec"], c.loc[ci, "pmra"], c.loc[ci, "pmdec"], c.loc[ci, "epoch"].fillna(COMMON_EPOCH))
        cand = tree.query_ball_point(unit_vectors(cra, cdec), r=8 * ARCSEC)
        taken = set(match[match >= 0].tolist())
        for k, i in enumerate(ci):
            best, best_d = -1, np.inf
            for j in cand[k]:
                sj = idx_near[j]
                if sj in taken:
                    continue
                p_s, p_c = s.at[sj, "plx"], c.at[i, "plx"]
                if np.isfinite(p_c) and abs(p_s - p_c) > 0.15 * p_c + 3:
                    continue
                d = np.hypot((sra[sj] - cra[k]) * np.cos(np.radians(cdec[k])), sdec[sj] - cdec[k])
                if d < best_d:
                    best, best_d = sj, d
            if best >= 0:
                match[i] = best
                taken.add(best)
    log.info(
        "census: %d of %d leaves matched by id/position, %d non-leaf rows matched",
        int((match[leaf] >= 0).sum()), int(leaf.sum()), int((match[~leaf] >= 0).sum()),
    )

    # A catalogue row may be claimed by several census rows (e.g. an unresolved pair in Gaia and
    # one of its components): the leaf that matched by id keeps it, the rest are added as new rows.
    owner: dict[int, int] = {}
    for i in np.nonzero(leaf & (match >= 0))[0]:
        j = match[i]
        if j not in owner:
            owner[j] = i
        else:
            # prefer the leaf with the same Gaia id / HIP
            prev = owner[j]
            if pd.isna(c.at[prev, "gaia"]) and pd.notna(c.at[i, "gaia"]):
                owner[j] = i
    replaced = set(int(match[i]) for i in np.nonzero(~leaf & (match >= 0))[0]) - set(owner)

    # fill missing census positions from the matched catalogue row (own match or an ancestor's)
    ra = c["ra"].to_numpy(dtype=float).copy()
    dec = c["dec"].to_numpy(dtype=float).copy()
    epoch = c["epoch"].to_numpy(dtype=float).copy()
    plx = c["plx"].to_numpy(dtype=float).copy()
    plx_err = c["plx_err"].to_numpy(dtype=float).copy()
    parent = c["parent_row"].to_numpy()
    row_of = {int(r): k for k, r in enumerate(c["census_row"])}
    for i in range(n):
        if np.isfinite(ra[i]) and np.isfinite(plx[i]):
            continue
        k = i
        while k >= 0 and match[k] < 0:
            p = parent[k]
            k = row_of.get(int(p), -1) if p >= 0 else -1
        if k >= 0:
            j = match[k]
            if not np.isfinite(ra[i]):
                ra[i], dec[i], epoch[i] = s.at[j, "ra"], s.at[j, "dec"], s.at[j, "epoch"]
            if not np.isfinite(plx[i]):
                plx[i], plx_err[i] = s.at[j, "plx"], s.at[j, "plx_err"]

    leaves = c[leaf].copy()
    li = np.nonzero(leaf)[0]
    leaves["ra"], leaves["dec"], leaves["epoch"] = ra[li], dec[li], epoch[li]
    leaves["plx"], leaves["plx_err"] = plx[li], plx_err[li]
    leaves["match"] = [j if owner.get(j) == i else -1 for i, j in zip(li, match[li])]
    bad = leaves["ra"].isna() | leaves["plx"].isna()
    if bad.any():
        log.warning("census: %d leaves without position or parallax dropped: %s", int(bad.sum()), ", ".join(leaves.loc[bad, "census_name"].head(10)))
    leaves = leaves[~bad]

    # census columns carried into the star table
    for col in ("census_row", "system_row", "census_name", "common_name", "bayer_flamsteed", "catalog_names", "var_name", "census_gj", "hd_name", "hr_name", "n_planets", "system_size"):
        if col not in s:
            s[col] = None
    s["census_row"] = pd.array([pd.NA] * len(s), dtype="Int64")
    s["system_row"] = pd.array([pd.NA] * len(s), dtype="Int64")
    s["brown_dwarf"] = False
    s["white_dwarf"] = False

    def apply(j: int, r) -> None:
        s.at[j, "src"] = int(s.at[j, "src"]) | Flag.SRC_CENSUS20
        s.at[j, "ra"], s.at[j, "dec"], s.at[j, "epoch"] = r.ra, r.dec, r.epoch
        s.at[j, "plx"], s.at[j, "plx_err"], s.at[j, "plx_src"] = r.plx, r.plx_err, "census"
        if np.isfinite(r.pmra):
            s.at[j, "pmra"], s.at[j, "pmdec"] = r.pmra, r.pmdec
        if isinstance(r.spect, str):
            s.at[j, "spect"] = r.spect
        if np.isfinite(r.teff):
            s.at[j, "teff_cat"] = r.teff
        if np.isfinite(r.gmag) and not np.isfinite(s.at[j, "gmag"]):
            s.at[j, "gmag"] = r.gmag
        if np.isfinite(r.bp_rp) and not np.isfinite(s.at[j, "bp_rp"]):
            s.at[j, "bp_rp"] = r.bp_rp
        if np.isfinite(r.jmag):
            s.at[j, "jmag"] = r.jmag
        if pd.notna(r.gaia) and pd.isna(s.at[j, "gaia"]):
            s.at[j, "gaia"] = r.gaia
        if pd.notna(r.hip) and pd.isna(s.at[j, "hip"]):
            s.at[j, "hip"] = r.hip
        s.at[j, "census_row"] = r.census_row
        s.at[j, "system_row"] = r.system_row
        s.at[j, "census_name"] = r.census_name
        s.at[j, "common_name"] = r.common_name if isinstance(r.common_name, str) else None
        s.at[j, "bayer_flamsteed"] = r.bayer_flamsteed if isinstance(r.bayer_flamsteed, str) else None
        s.at[j, "catalog_names"] = r.catalog_names
        s.at[j, "var_name"] = r.var_name if isinstance(r.var_name, str) else None
        s.at[j, "census_gj"] = r.gj if isinstance(r.gj, str) else None
        s.at[j, "hd_name"] = r.hd_name if isinstance(r.hd_name, str) else None
        s.at[j, "hr_name"] = r.hr_name if isinstance(r.hr_name, str) else None
        s.at[j, "n_planets"] = r.n_planets
        s.at[j, "system_size"] = r.system_size
        s.at[j, "brown_dwarf"] = bool(r.brown_dwarf)
        s.at[j, "white_dwarf"] = bool(r.white_dwarf)

    new_rows = []
    for r in leaves.itertuples(index=False):
        if r.match >= 0:
            apply(int(r.match), r)
        else:
            new_rows.append(r)
    log.info("census: %d leaves merged into existing rows, %d added as new objects", len(leaves) - len(new_rows), len(new_rows))
    if new_rows:
        nr = pd.DataFrame(new_rows)
        add = pd.DataFrame(
            {
                "src": Flag.SRC_CENSUS20,
                "ra": nr["ra"],
                "dec": nr["dec"],
                "epoch": nr["epoch"].fillna(COMMON_EPOCH),
                "plx": nr["plx"],
                "plx_err": nr["plx_err"],
                "plx_src": "census",
                "pmra": nr["pmra"],
                "pmdec": nr["pmdec"],
                "ruwe": np.nan,
                "vmag": np.nan,
                "gmag": nr["gmag"],
                "bp_rp": nr["bp_rp"],
                "bv": np.nan,
                "jmag": nr["jmag"],
                "spect": nr["spect"].astype(object).where(nr["spect"].notna(), None),
                "teff_cat": nr["teff"],
                "gaia": nr["gaia"].astype("Int64"),
                "hip": nr["hip"].astype("Int64"),
                "census_row": nr["census_row"].astype("Int64"),
                "system_row": nr["system_row"].astype("Int64"),
                "census_name": nr["census_name"],
                "common_name": nr["common_name"].astype(object).where(nr["common_name"].notna(), None),
                "bayer_flamsteed": nr["bayer_flamsteed"].astype(object).where(nr["bayer_flamsteed"].notna(), None),
                "catalog_names": nr["catalog_names"],
                "var_name": nr["var_name"].astype(object).where(nr["var_name"].notna(), None),
                "census_gj": nr["gj"].astype(object).where(nr["gj"].notna(), None),
                "hd_name": nr["hd_name"].astype(object).where(nr["hd_name"].notna(), None),
                "hr_name": nr["hr_name"].astype(object).where(nr["hr_name"].notna(), None),
                "n_planets": nr["n_planets"],
                "system_size": nr["system_size"],
                "brown_dwarf": nr["brown_dwarf"].astype(bool),
                "white_dwarf": nr["white_dwarf"].astype(bool),
                "is_sun": False,
            }
        )
        s = pd.concat([s, add], ignore_index=True)

    if replaced:
        log.info("census: %d catalogue rows replaced by resolved census components", len(replaced))
        s = s.drop(index=sorted(replaced)).reset_index(drop=True)

    # Within the census volume, everything must be confirmed by the census. Unconfirmed rows
    # with imprecise distances are mostly old Hipparcos/Gliese errors ("phantom neighbours").
    # Rows with precise Gaia parallaxes that are still unconfirmed are duplicates of census objects
    # whose catalogue position is off (old Gliese coordinates can be wrong by arcminutes).
    plx = s["plx"].to_numpy(dtype=float)
    rel = s["plx_err"].to_numpy(dtype=float) / plx
    drop = s["census_row"].isna().to_numpy() & (plx > 1000.0 / CENSUS_LIMIT_PC) & ~s["is_sun"].to_numpy(dtype=bool)
    precise = drop & (rel < 0.05)
    log.info(
        "within %.0f pc: %d rows not confirmed by the census dropped (%d of them with precise parallaxes: %s)",
        CENSUS_LIMIT_PC, int(drop.sum()), int(precise.sum()),
        ", ".join(str(v) for v in s.loc[precise, "gj"].fillna(s.loc[precise, "gaia"].astype(str)).head(10)),
    )
    s = s[~drop].reset_index(drop=True)
    return s
