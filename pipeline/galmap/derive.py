"""Derived quantities: 3-D position, distance uncertainty, temperature, luminosity, flags."""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .coords import LY_PER_PC, icrs_to_galactic_xyz
from .flags import Flag, is_giant_spect, spectral_code
from .photometry import Photometry, g_minus_v, spt_number

log = logging.getLogger(__name__)

MAX_DIST_PC = 15_000.0
MAX_REL_ERR = 1.0


def positions(s: pd.DataFrame) -> pd.DataFrame:
    """Galactic xyz (ly) and relative distance error; drops rows without a usable parallax."""
    plx = s["plx"].to_numpy(dtype=float)
    sun = s["is_sun"].to_numpy(dtype=bool)
    rel = s["plx_err"].to_numpy(dtype=float) / plx
    ok = sun | (np.isfinite(plx) & (plx > 1000.0 / MAX_DIST_PC) & ~(rel > MAX_REL_ERR))
    log.info("positions: dropping %d rows (no/negative parallax, beyond %.0f pc, or error > 100%%)", int((~ok).sum()), MAX_DIST_PC)
    s = s[ok].reset_index(drop=True)
    plx = s["plx"].to_numpy(dtype=float)
    sun = s["is_sun"].to_numpy(dtype=bool)
    dist_pc = np.where(sun, 0.0, 1000.0 / np.where(sun, 1.0, plx))
    xyz = icrs_to_galactic_xyz(s["ra"].to_numpy(float), s["dec"].to_numpy(float), dist_pc) * LY_PER_PC
    s["x"], s["y"], s["z"] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    s["dist_pc"] = dist_pc
    s["dist_err"] = np.where(sun, 0.0, s["plx_err"].to_numpy(dtype=float) / np.where(sun, 1.0, plx))
    return s


def physics(s: pd.DataFrame, phot: Photometry) -> pd.DataFrame:
    s = s.copy()
    n = len(s)
    spect = s["spect"].astype(object).where(s["spect"].notna(), None)
    spt = np.array([spt_number(v) for v in spect], dtype=float)
    spec_code = np.array([spectral_code(v) for v in spect], dtype=np.int64)
    bd_spt = np.isin(spec_code // 10, (7, 8, 9))
    wd_spt = spec_code // 10 == 10
    bd = s["brown_dwarf"].fillna(False).to_numpy(dtype=bool) | bd_spt
    wd = (
        s["white_dwarf"].fillna(False).to_numpy(dtype=bool)
        | wd_spt
        | (s["wd_prob"].to_numpy(dtype=float) > 0.5)
    )

    # effective temperature
    teff = s["teff_cat"].to_numpy(dtype=float).copy()
    t_bprp = phot.teff_from_bprp(s["bp_rp"].to_numpy(dtype=float))
    t_bv = phot.teff_from_bv(s["bv"].to_numpy(dtype=float))
    t_spt = phot.teff_from_spt(spt)
    # brown dwarfs: colour relations do not apply; use the spectral type
    teff = np.where(np.isnan(teff) & bd, t_spt, teff)
    for t in (t_bprp, t_bv, t_spt):
        teff = np.where(np.isnan(teff) & ~bd, t, teff)
    # white dwarfs: the dwarf colour sequence is wrong for them; keep a plausible range
    teff = np.where(wd & ~np.isnan(teff), np.clip(teff, 4000, 40000), teff)

    # absolute V magnitude
    plx = s["plx"].to_numpy(dtype=float)
    dm = 5 * np.log10(np.where(plx > 0, plx, np.nan)) - 10  # M = m + dm
    vmag = s["vmag"].to_numpy(dtype=float)
    v_from_g = s["gmag"].to_numpy(dtype=float) - g_minus_v(s["bp_rp"].to_numpy(dtype=float))
    v = np.where(np.isfinite(vmag), vmag, v_from_g)
    absmag = v + dm
    sun = s["is_sun"].to_numpy(dtype=bool)
    absmag[sun] = 4.83
    teff[sun] = 5772.0

    # bolometric luminosity
    logl = phot.logl_from_mv(absmag, teff)
    logl_spt = phot.logl_from_spt(spt)
    logl = np.where(bd & np.isfinite(logl_spt), logl_spt, logl)
    # objects without V photometry (most brown dwarfs, some faint M dwarfs): spectral type
    logl = np.where(np.isnan(logl) & np.isfinite(logl_spt), logl_spt, logl)
    logl[sun] = 0.0
    if np.isnan(teff[bd]).any():
        teff[bd & np.isnan(teff)] = 1000.0

    flags = s["src"].to_numpy(dtype=np.int64).copy()
    flags |= np.where(bd, Flag.BROWN_DWARF, 0)
    flags |= np.where(wd & ~bd, Flag.WHITE_DWARF, 0)
    flags |= np.where(sun, Flag.SUN, 0)
    giant = np.array([is_giant_spect(v) for v in spect], dtype=bool)
    flags |= np.where(giant, Flag.GIANT, 0)
    plx_src = s["plx_src"].astype(str).to_numpy()
    flags |= np.where(np.isin(plx_src, ("gj", "census_est")), Flag.DIST_NO_PARALLAX, 0)
    variable = s.get("hyg_var", pd.Series([None] * n)).notna().to_numpy() | s.get("var_name", pd.Series([None] * n)).notna().to_numpy()
    flags |= np.where(variable, Flag.VARIABLE, 0)

    s["teff"] = teff
    s["absmag"] = absmag
    s["logl"] = logl
    s["spec_code"] = spec_code
    s["flags"] = flags
    return s
