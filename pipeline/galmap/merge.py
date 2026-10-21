"""Cross-matching and merging of the catalogues into one table with one row per star.

Precedence (best first):
  1. 20 pc census (Kirkpatrick+2024) for everything within 20 pc
  2. Gaia DR3 astrometry (via GCNS within 100 pc, via the Tycho-2/Hipparcos cross-match beyond)
  3. AT-HYG / HYG (Hipparcos, Gliese) for stars without usable Gaia data (e.g. Sirius, Vega)
"""

from __future__ import annotations

import logging
import re

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from .coords import propagate, unit_vectors
from .flags import Flag
from .photometry import g_minus_v

log = logging.getLogger(__name__)

ARCSEC = np.pi / (180 * 3600)
COMMON_EPOCH = 2016.0
# The 20 pc census is complete to this distance (pc): stars certainly closer must be census objects.
CENSUS_LIMIT_PC = 20.0


def _empty_like(n: int) -> dict:
    return {}


# ---------------------------------------------------------------------------------------------
# AT-HYG + Gaia astrometry

# identifiers and names that travel with a star when two rows turn out to be the same star
ID_COLUMNS = ("hip", "hd", "hr", "hyg", "flam", "tyc", "gj", "bayer", "con", "proper", "hyg_var", "hyg_base", "hyg_comp", "hyg_proper")


def link_gaia(athyg: pd.DataFrame, gaia: pd.DataFrame) -> pd.DataFrame:
    """Attach Gaia DR3 astrometry to AT-HYG rows, rejecting implausible cross-identifications.

    Adds g_* columns and 'gaia_status': ok, rejected (photometry contradicts the link), loser (another
    AT-HYG row has the same Gaia id and matches it better), missing (id not in Gaia DR3) or none.
    """
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
    rejected = has & ((gv < -4.0) | (gv > 1.0))
    # Several AT-HYG rows can share one Gaia id; the link stays with the best photometric match.
    dup = has & df["gaia"].duplicated(keep=False)
    loser = pd.Series(False, index=df.index)
    if dup.any():
        tmp = pd.DataFrame({"gaia": df.loc[dup, "gaia"], "err": (gv[dup] + 0.3).abs().fillna(9.0), "tyc": df.loc[dup, "tyc"].isna()})
        best = tmp.sort_values(["err", "tyc"]).drop_duplicates("gaia").index
        loser = dup & ~df.index.isin(best)
    status = np.full(len(df), "none", dtype=object)
    status[df["gaia"].notna().to_numpy()] = "missing"
    status[has.to_numpy()] = "ok"
    status[(has & loser).to_numpy()] = "loser"
    status[(has & rejected).to_numpy()] = "rejected"
    df["gaia_status"] = status
    bad = ~(df["gaia_status"] == "ok")
    for c in gcols:
        df.loc[bad, "g_" + c] = np.nan
    log.info(
        "AT-HYG: %d rows linked to Gaia DR3, %d links rejected by photometry, %d share their Gaia id with a better match, %d ids not in DR3",
        int((status == "ok").sum()), int((status == "rejected").sum()), int((status == "loser").sum()), int((status == "missing").sum()),
    )
    return df


def gaia_parallax(parallax, error, zp, ruwe) -> tuple[np.ndarray, np.ndarray]:
    """Zero-point corrected Gaia parallax and its error, inflated for poor astrometric fits (RUWE > 1)."""
    plx = np.array(parallax, dtype=float) - np.nan_to_num(np.array(zp, dtype=float), nan=-0.017)
    err = np.array(error, dtype=float) * np.maximum(1.0, np.nan_to_num(np.array(ruwe, dtype=float), nan=1.0))
    return plx, err


def athyg_rows(athyg_g: pd.DataFrame, hyg: pd.DataFrame, hipparcos: pd.DataFrame | None = None) -> pd.DataFrame:
    """Normalised star rows from AT-HYG with the best available parallax.

    Gaia DR3 (zero-point corrected) is used unless the Hipparcos new reduction is more precise once
    the Gaia error is inflated by the RUWE (bright, saturated stars). AT-HYG's own distance is used
    only when it is not derived from Gaia (Hipparcos, Gliese): a Gaia-derived AT-HYG distance whose
    Gaia link was rejected belongs to another (usually faint background) source.
    """
    a = athyg_g
    n = len(a)
    status = a["gaia_status"].to_numpy()
    ok = status == "ok"
    plx_g, err_g = gaia_parallax(a["g_parallax"], a["g_parallax_error"], a["g_parallax_zp"], a["g_ruwe"])
    gaia_usable = ok & np.isfinite(plx_g) & (plx_g > 0) & np.isfinite(err_g)

    plx_h = np.full(n, np.nan)
    err_h = np.full(n, np.nan)
    hip_astro = np.full((n, 4), np.nan)  # ra, dec, pmra, pmdec at epoch 1991.25
    in_hip = np.zeros(n, bool)
    if hipparcos is not None and len(hipparcos):
        hp = hipparcos.set_index("hip")
        hip = a["hip"].astype("Int64")
        in_hip = hip.isin(hp.index).to_numpy()
        sub = hp.loc[hip[in_hip].astype("int64")]
        plx_h[in_hip] = sub["plx"].to_numpy(float)
        err_h[in_hip] = sub["e_plx"].to_numpy(float)
        hip_astro[in_hip] = sub[["ra", "dec", "pm_ra", "pm_de"]].to_numpy(float)
    hip_usable = np.isfinite(plx_h) & (plx_h > 0) & np.isfinite(err_h) & (err_h > 0)

    use_g = gaia_usable & ~(hip_usable & (err_h < err_g))
    use_h = hip_usable & ~use_g
    dist_src = a["dist_src"].fillna("N").astype(str).str.upper().to_numpy()
    plx_a = 1000.0 / a["dist"].to_numpy(dtype=float)
    # AT-HYG's own distance only where it does not come from Gaia (Hipparcos 'H', Gliese 'GJ', 'OTHER')
    use_a = ~use_g & ~use_h & ~np.char.startswith(dist_src.astype(str), "G_")

    out = pd.DataFrame(index=a.index)
    out["src"] = Flag.SRC_ATHYG
    pos_g = ok & np.isfinite(a["g_ra"].to_numpy(float))
    # without a Gaia position, a Hipparcos star takes position and proper motion from Hipparcos
    # (AT-HYG may carry those of the wrongly linked Gaia source)
    pos_h = ~pos_g & in_hip & np.isfinite(hip_astro[:, 0])
    out["ra"] = np.select([pos_g, pos_h], [a["g_ra"], hip_astro[:, 0]], a["ra_deg"])
    out["dec"] = np.select([pos_g, pos_h], [a["g_dec"], hip_astro[:, 1]], a["dec"])
    out["epoch"] = np.select([pos_g, pos_h], [COMMON_EPOCH, 1991.25], a["epoch"])
    out["plx"] = np.select([use_g, use_h, use_a], [plx_g, plx_h, plx_a], np.nan)
    out["plx_err"] = np.select([use_g, use_h], [err_g, err_h], np.nan)
    out["plx_src"] = np.select([use_g, use_h, use_a], ["gaia", "hip", np.char.lower(dist_src.astype(str))], "none")
    out["pmra"] = np.where(ok, a["g_pmra"], a["pmra"])
    out["pmdec"] = np.where(ok, a["g_pmdec"], a["pmdec"])
    out.loc[pos_h, "pmra"] = hip_astro[pos_h, 2]
    out.loc[pos_h, "pmdec"] = hip_astro[pos_h, 3]
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
    # the Gaia id is the star's identity for all later matching unless the link was rejected
    out["gaia"] = a["gaia"].where(np.isin(status, ("ok", "missing")), pd.NA).astype("Int64")
    out["gaia_loser_of"] = a["gaia"].where(status == "loser", pd.NA).astype("Int64")
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
    log.info(
        "AT-HYG parallaxes: %d Gaia, %d Hipparcos (%d of them preferred over a high-RUWE Gaia solution), %d other, %d unusable",
        int(use_g.sum()), int(use_h.sum()), int((use_h & gaia_usable).sum()), int(use_a.sum()), int((~use_g & ~use_h & ~use_a).sum()),
    )
    return _absorb_shared_gaia_losers(out)


def _absorb(s: pd.DataFrame, keep: int, drop: int) -> None:
    """Copy identifiers and names of row `drop` into row `keep` where `keep` lacks them."""
    for c in ID_COLUMNS + ("spect", "vmag", "bv"):
        if c in s.columns:
            v = s.at[drop, c]
            cur = s.at[keep, c]
            if (not isinstance(v, (list, tuple)) and pd.notna(v)) and (cur is None or (not isinstance(cur, (list, tuple)) and pd.isna(cur))):
                s.at[keep, c] = v
    s.at[keep, "src"] = int(s.at[keep, "src"]) | int(s.at[drop, "src"])


def _absorb_shared_gaia_losers(s: pd.DataFrame) -> pd.DataFrame:
    """AT-HYG rows that lost a shared Gaia id: a Gliese/HYG-only row (no Tycho/Hipparcos entry) or a
    row at the same position and brightness is the same star as the winner and is merged into it;
    a distinct Tycho star keeps only its own (non-Gaia) distance, if any."""
    s = s.reset_index(drop=True)
    win = pd.Series(np.arange(len(s)), index=s["gaia"])
    win = win[win.index.notna() & ~win.index.duplicated()]
    losers = np.nonzero(s["gaia_loser_of"].notna().to_numpy())[0]
    drop = []
    for i in losers:
        g = s.at[i, "gaia_loser_of"]
        if g not in win.index:
            continue
        j = int(win[g])
        same_entry = s.at[i, "tyc"] is None and pd.isna(s.at[i, "hip"])
        sep = np.hypot((s.at[i, "ra"] - s.at[j, "ra"]) * np.cos(np.radians(s.at[j, "dec"])), s.at[i, "dec"] - s.at[j, "dec"]) * 3600
        dv = abs(s.at[i, "vmag"] - s.at[j, "vmag"])
        if same_entry or (sep < 3.0 and np.isfinite(dv) and dv < 0.5):
            _absorb(s, j, i)
            drop.append(i)
    log.info("AT-HYG: %d rows merged into the row that shares their Gaia id", len(drop))
    return s.drop(index=drop).drop(columns=["gaia_loser_of"]).reset_index(drop=True)


# ---------------------------------------------------------------------------------------------
# GCNS


def merge_gcns(stars: pd.DataFrame, gcns: pd.DataFrame, gaia: pd.DataFrame | None = None) -> pd.DataFrame:
    """Add the Gaia Catalogue of Nearby Stars. Astrometry comes from Gaia DR3 (same solution as EDR3)
    with the same zero-point correction as all other Gaia parallaxes; rows already present (same
    Gaia id) keep their parallax choice and only gain the GCNS attributes."""
    s = stars.copy()
    pos = pd.Series(np.arange(len(s)), index=s["gaia"].astype("Int64"))
    pos = pos[pos.index.notna() & ~pos.index.duplicated()]
    key = gcns["source_id"].astype("Int64")
    matched = key.isin(pos.index)
    gi = pos.loc[key[matched]].to_numpy()
    gm = gcns[matched]
    log.info("GCNS: %d rows, %d already present, %d new", len(gcns), len(gi), int((~matched).sum()))

    col = s.columns.get_loc
    s.iloc[gi, col("wd_prob")] = gm["wd_prob"].to_numpy()
    s.iloc[gi, col("name_2mass")] = gm["name_2mass"].astype(object).to_numpy()
    for c in ("bp_rp", "gmag"):
        v = s[c].to_numpy().copy()
        v[gi] = np.where(np.isnan(v[gi]), gm[c].to_numpy(), v[gi])
        s[c] = v
    jm = s["jmag"].to_numpy().copy()
    jm[gi] = np.where(np.isnan(jm[gi]), gm["jmag"].to_numpy(), jm[gi])
    s["jmag"] = jm
    src = s["src"].to_numpy().copy()
    src[gi] |= Flag.SRC_GCNS
    s["src"] = src

    new = gcns[~matched].reset_index(drop=True)
    ra, dec = new["ra"].to_numpy(float).copy(), new["dec"].to_numpy(float).copy()
    pmra, pmdec = new["pmra"].to_numpy(float).copy(), new["pmdec"].to_numpy(float).copy()
    plx, err = gaia_parallax(new["plx"], new["plx_err"], np.full(len(new), -0.017), new["ruwe"])
    if gaia is not None and len(gaia):
        g = gaia.set_index("source_id")
        k = new["source_id"].astype("int64")
        have = k.isin(g.index).to_numpy()
        gg = g.loc[k[have]]
        p2, e2 = gaia_parallax(gg["parallax"], gg["parallax_error"], gg["parallax_zp"], gg["ruwe"])
        plx[have], err[have] = p2, e2
        ra[have], dec[have] = gg["ra"].to_numpy(float), gg["dec"].to_numpy(float)
        pmra[have], pmdec[have] = gg["pmra"].to_numpy(float), gg["pmdec"].to_numpy(float)
        log.info("GCNS: %d of %d new rows with Gaia DR3 astrometry and zero point", int(have.sum()), len(new))
    add = pd.DataFrame(
        {
            "src": Flag.SRC_GCNS,
            "ra": ra,
            "dec": dec,
            "epoch": COMMON_EPOCH,
            "plx": plx,
            "plx_err": err,
            "plx_src": "gaia",
            "pmra": pmra,
            "pmdec": pmdec,
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


def dedupe_against_gaia(s: pd.DataFrame) -> pd.DataFrame:
    """Safety net: a row without Gaia astrometry (old Tycho/Hipparcos/Gliese entry whose Gaia link is
    missing or was wrong) that coincides with a Gaia row in position, parallax and brightness is the
    same star; its identifiers and names move to the Gaia row and the row is dropped."""
    s = s.reset_index(drop=True)
    # rows with a Gaia id are distinct Gaia sources (even where a Hipparcos parallax was preferred)
    is_g = s["gaia"].notna().to_numpy()
    plx = s["plx"].to_numpy(float)
    cand = np.nonzero(~is_g & np.isfinite(plx) & (plx > 1.0) & ~s["is_sun"].to_numpy(bool))[0]
    gi = np.nonzero(is_g & (plx > 0.5))[0]
    if not len(cand) or not len(gi):
        return s
    gra, gdec = _positions_at(s["ra"].to_numpy(float)[gi], s["dec"].to_numpy(float)[gi], s["pmra"].to_numpy(float)[gi], s["pmdec"].to_numpy(float)[gi], s["epoch"].to_numpy(float)[gi])
    tree = cKDTree(unit_vectors(gra, gdec))
    cra, cdec = _positions_at(s["ra"].to_numpy(float)[cand], s["dec"].to_numpy(float)[cand], np.nan_to_num(s["pmra"].to_numpy(float)[cand]), np.nan_to_num(s["pmdec"].to_numpy(float)[cand]), s["epoch"].to_numpy(float)[cand])
    gliese_only = (s["tyc"].isna() & s["hip"].isna()).to_numpy()[cand]
    radius = np.where(gliese_only, 60.0, 3.0) * ARCSEC
    found = tree.query_ball_point(unit_vectors(cra, cdec), r=radius)
    err = s["plx_err"].to_numpy(float)
    vmag, gmag, bprp = s["vmag"].to_numpy(float), s["gmag"].to_numpy(float), s["bp_rp"].to_numpy(float)
    gv_expect = g_minus_v(bprp)
    pairs = []
    cu = unit_vectors(cra, cdec)
    gu = unit_vectors(gra, gdec)
    for k, i in enumerate(cand):
        for j in found[k]:
            jj = gi[j]
            d = float(np.linalg.norm(cu[k] - gu[j]))
            e_i = err[i] if np.isfinite(err[i]) else 0.3 * plx[i]  # Gliese distances without errors
            if e_i > 0.5 * plx[i]:
                if d > 1.5 * ARCSEC:  # a useless parallax: only an exact position (and brightness) counts
                    continue
            elif abs(plx[i] - plx[jj]) > 3 * np.hypot(e_i, err[jj]) + 0.05 * plx[jj]:
                continue
            gv = gmag[jj] - vmag[i]
            if np.isfinite(gv) and np.isfinite(gv_expect[jj]):
                if abs(gv - gv_expect[jj]) > 0.75:
                    continue
            elif np.isfinite(gv):
                if not (-4.0 < gv < 1.0):
                    continue
            elif gliese_only[k]:
                continue  # wide search radius needs a brightness check
            pairs.append((d, int(i), int(jj)))
    # one-to-one, closest pairs first (a Tycho entry next to a resolved Gaia pair joins only one)
    drop, used = [], set()
    for _, i, jj in sorted(pairs):
        if i in used or jj in used:
            continue
        used.update((i, jj))
        _absorb(s, jj, i)
        drop.append(i)
    log.info("dedupe: %d catalogue rows merged into the Gaia row of the same star", len(drop))
    return s.drop(index=drop).reset_index(drop=True)


# ---------------------------------------------------------------------------------------------
# 20 pc census


def _positions_at(ra, dec, pmra, pmdec, epoch, target=COMMON_EPOCH):
    return propagate(ra, dec, pmra, pmdec, target - np.asarray(epoch, dtype=float))


def _component(name) -> str | None:
    if not isinstance(name, str):
        return None
    m = re.search(r"\d\s*([A-H][a-c]?)\s*$", name) or re.search(r"\s([A-H][a-c]?)\s*$", name)
    return m.group(1) if m else None


def _compatible(a: str | None, b: str | None) -> bool:
    """Component letters 'A' and 'Ab' are compatible (one contains the other), 'B' and 'Ab' are not."""
    return a is None or b is None or a.startswith(b) or b.startswith(a)


def merge_census(stars: pd.DataFrame, census: pd.DataFrame) -> pd.DataFrame:
    """Match census rows to catalogue rows (Gaia id, HIP, then position) and merge them in."""
    s = stars.reset_index(drop=True).copy()
    c = census.reset_index(drop=True)
    if "plx_estimated" not in c:
        c = c.assign(plx_estimated=False)
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

    # Positional matching for leaves without an id match, as one global one-to-one assignment
    # (closest pairs first). Unresolved components that share their coordinates with a sibling do
    # not compete for the same catalogue row; a row whose Gaia id or HIP number the census gives to
    # another object, or whose GJ component letter contradicts the leaf's, is never taken.
    leaf = c["is_leaf"].to_numpy()
    census_gaia = set(int(v) for v in c["gaia"].dropna())
    census_hip = set(int(v) for v in c["hip"].dropna())
    need = leaf & (match < 0) & c["ra"].notna().to_numpy()
    seen_pos: set[tuple] = set()
    for i in np.nonzero(need)[0]:
        key = (c.at[i, "system_row"], round(float(c.at[i, "ra"]), 5), round(float(c.at[i, "dec"]), 5))
        if key in seen_pos:
            need[i] = False
        seen_pos.add(key)
    if need.any():
        sra, sdec = _positions_at(s["ra"], s["dec"], np.nan_to_num(s["pmra"].to_numpy(float)), np.nan_to_num(s["pmdec"].to_numpy(float)), s["epoch"])
        # only stars within ~33 pc can be census objects; rows without a usable parallax (e.g. a
        # wrong Gaia link) may still carry the identifiers of a census object
        plx_s = s["plx"].to_numpy(float)
        near = (plx_s > 30) | ~np.isfinite(plx_s)
        idx_near = np.nonzero(near)[0]
        tree = cKDTree(unit_vectors(sra[idx_near], sdec[idx_near]))
        ci = np.nonzero(need)[0]
        cra, cdec = _positions_at(c.loc[ci, "ra"], c.loc[ci, "dec"], np.nan_to_num(c.loc[ci, "pmra"].to_numpy(float)), np.nan_to_num(c.loc[ci, "pmdec"].to_numpy(float)), c.loc[ci, "epoch"].fillna(COMMON_EPOCH))
        cu = unit_vectors(cra, cdec)
        cand = tree.query_ball_point(cu, r=60 * ARCSEC)
        su = unit_vectors(sra[idx_near], sdec[idx_near])
        gliese_only = (s["tyc"].isna() & s["hip"].isna()).to_numpy()
        pairs = []
        for k, i in enumerate(ci):
            comp_i = _component(c.at[i, "census_name"])
            for j in cand[k]:
                sj = idx_near[j]
                d = float(np.linalg.norm(cu[k] - su[j])) / ARCSEC
                if d > (60.0 if gliese_only[sj] else 8.0):
                    continue
                p_s, p_c = s.at[sj, "plx"], c.at[i, "plx"]
                if np.isfinite(p_c) and abs(p_s - p_c) > 0.15 * p_c + 3:
                    continue
                g = s.at[sj, "gaia"]
                if pd.notna(g) and int(g) in census_gaia:
                    continue
                h = s.at[sj, "hip"]
                if pd.notna(h) and int(h) in census_hip:
                    continue
                if not _compatible(comp_i, _component(s.at[sj, "gj"])):
                    continue
                pairs.append((d, int(i), int(sj)))
        taken = set(match[match >= 0].tolist())
        done: set[int] = set()
        for d, i, sj in sorted(pairs):
            if i in done or sj in taken:
                continue
            match[i] = sj
            taken.add(sj)
            done.add(i)
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

    # Catalogue identifiers that belong to another census object than the row's owner move there:
    # a row claimed through its Gaia id may carry the HIP/HD/GJ numbers of a companion, and a row
    # replaced by resolved components hands its identifiers to the primary component.
    children: dict[int, list[int]] = {}
    row_of = {int(r): k for k, r in enumerate(c["census_row"])}
    parent = c["parent_row"].to_numpy()
    for i in range(n):
        if parent[i] >= 0 and int(parent[i]) in row_of:
            children.setdefault(row_of[int(parent[i])], []).append(i)

    def first_leaf(i: int) -> int:
        while i in children:
            i = children[i][0]
        return i

    hip_leaf = {int(h): i for i, h in zip(range(n), c["hip"]) if pd.notna(h) and leaf[i]}
    pending: dict[int, dict] = {}

    def take_ids(j: int) -> dict:
        out = {}
        for col in ID_COLUMNS:
            if col in s.columns:
                v = s.at[j, col]
                if v is not None and not (isinstance(v, float) and np.isnan(v)) and v is not pd.NA:
                    out[col] = v
        return out

    moved = 0
    for j, i in owner.items():
        h = s.at[j, "hip"]
        if pd.notna(h) and int(h) in hip_leaf and hip_leaf[int(h)] != i:
            k = hip_leaf[int(h)]
            pending.setdefault(k, {}).update(take_ids(j))
            for col in ID_COLUMNS:
                if col in s.columns:
                    s.at[j, col] = pd.NA if str(s[col].dtype) in ("Int64", "Float64") else None
            moved += 1
    for i in np.nonzero(~leaf & (match >= 0))[0]:
        j = int(match[i])
        if j in replaced:
            h = s.at[j, "hip"]
            k = hip_leaf.get(int(h), first_leaf(int(i))) if pd.notna(h) else first_leaf(int(i))
            ids = take_ids(j)
            for col, v in ids.items():
                pending.setdefault(k, {}).setdefault(col, v)
    log.info("census: identifiers of %d rows moved to the census object they belong to", moved)

    # fill missing census positions from the matched catalogue row (own match or an ancestor's)
    ra = c["ra"].to_numpy(dtype=float).copy()
    dec = c["dec"].to_numpy(dtype=float).copy()
    epoch = c["epoch"].to_numpy(dtype=float).copy()
    plx = c["plx"].to_numpy(dtype=float).copy()
    plx_err = c["plx_err"].to_numpy(dtype=float).copy()
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
    leaves["ci"] = li
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

    def fill_pending(j: int, i: int) -> None:
        for col, v in pending.get(i, {}).items():
            cur = s.at[j, col]
            if cur is None or cur is pd.NA or (isinstance(cur, float) and np.isnan(cur)):
                s.at[j, col] = v

    def apply(j: int, r) -> None:
        s.at[j, "src"] = int(s.at[j, "src"]) | Flag.SRC_CENSUS20
        s.at[j, "ra"], s.at[j, "dec"], s.at[j, "epoch"] = r.ra, r.dec, r.epoch
        s.at[j, "plx"], s.at[j, "plx_err"] = r.plx, r.plx_err
        s.at[j, "plx_src"] = "census_est" if r.plx_estimated else "census"
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
        fill_pending(j, int(r.ci))

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
                "plx_src": np.where(nr["plx_estimated"].astype(bool), "census_est", "census"),
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
        base = len(s)
        s = pd.concat([s, add], ignore_index=True)
        for k, r in enumerate(new_rows):
            fill_pending(base + k, int(r.ci))

    if replaced:
        log.info("census: %d catalogue rows replaced by resolved census components", len(replaced))
        s = s.drop(index=sorted(replaced)).reset_index(drop=True)

    # The census is complete to 20 pc: rows that are certainly inside 20 pc but not confirmed by
    # it are old Hipparcos/Gliese errors ("phantom neighbours") or duplicates of census objects
    # whose catalogue position is off (old Gliese coordinates can be wrong by arcminutes).
    plx = s["plx"].to_numpy(dtype=float)
    err = s["plx_err"].to_numpy(dtype=float)
    inside = np.where(np.isfinite(err), plx - 2 * err > 1000.0 / CENSUS_LIMIT_PC, plx > 1000.0 / (CENSUS_LIMIT_PC + 0.5))
    # Bright stars placed by Hipparcos (poor Gaia fit) whose Gaia DR3 source exists are real; the
    # census, which uses the Gaia parallax, may simply put them beyond 20 pc (nu2 CMa: 48.85 vs 50.63 mas).
    real_bright = (s["plx_src"].to_numpy() == "hip") & s["gaia"].notna().to_numpy()
    drop = s["census_row"].isna().to_numpy() & inside & ~real_bright & ~s["is_sun"].to_numpy(dtype=bool)
    precise = drop & (err / plx < 0.05)
    log.info(
        "within %.0f pc: %d rows not confirmed by the census dropped (%d of them with precise parallaxes: %s)",
        CENSUS_LIMIT_PC, int(drop.sum()), int(precise.sum()),
        ", ".join(str(v) for v in s.loc[precise, "gj"].fillna(s.loc[precise, "gaia"].astype(str)).head(10)),
    )
    s = s[~drop].reset_index(drop=True)
    return s
