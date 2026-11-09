"""Coordinate transformations (vectorised with numpy)."""

from __future__ import annotations

import numpy as np

LY_PER_PC = 3.261563777

# ICRS -> Galactic rotation matrix, Hipparcos definition (ESA 1997, Vol. 1, Sect. 1.5.3, eq. 1.5.11).
A_G = np.array(
    [
        [-0.0548755604162154, -0.8734370902348850, -0.4838350155487132],
        [+0.4941094278755837, -0.4448296299600112, +0.7469822444972189],
        [-0.8676661490190047, -0.1980763734312015, +0.4559837761750669],
    ]
)


def unit_vectors(ra_deg, dec_deg) -> np.ndarray:
    ra = np.radians(np.asarray(ra_deg, dtype=float))
    dec = np.radians(np.asarray(dec_deg, dtype=float))
    cd = np.cos(dec)
    return np.stack([cd * np.cos(ra), cd * np.sin(ra), np.sin(dec)], axis=-1)


def icrs_to_galactic_xyz(ra_deg, dec_deg, dist) -> np.ndarray:
    """Heliocentric galactic Cartesian coordinates (same unit as dist), shape (N, 3)."""
    u = unit_vectors(ra_deg, dec_deg)
    return (u @ A_G.T) * np.asarray(dist, dtype=float)[..., None]


#: km/s -> pc/yr and km/s -> ly/yr
PC_PER_YR_PER_KMS = 1.0227121650537077e-6
LY_PER_YR_PER_KMS = PC_PER_YR_PER_KMS * LY_PER_PC
#: proper motion (mas/yr) times distance (pc) -> tangential velocity (km/s)
K_TAN = 4.740470463533348e-3


def space_velocity(ra_deg, dec_deg, dist_pc, pmra_masyr, pmdec_masyr, rv_kms) -> np.ndarray:
    """Heliocentric velocity in the galactic frame (km/s), shape (N, 3): the tangential part from
    the proper motion (pmra is mu_alpha*, already times cos dec) and the distance, the radial part
    from the radial velocity (0 where it is unknown). NaN where the proper motion is unknown."""
    ra = np.radians(np.asarray(ra_deg, dtype=float))
    dec = np.radians(np.asarray(dec_deg, dtype=float))
    d = np.asarray(dist_pc, dtype=float)
    pmra = np.asarray(pmra_masyr, dtype=float)
    pmdec = np.asarray(pmdec_masyr, dtype=float)
    rv = np.nan_to_num(np.asarray(rv_kms, dtype=float))
    sa, ca, sd, cd = np.sin(ra), np.cos(ra), np.sin(dec), np.cos(dec)
    r_hat = np.stack([cd * ca, cd * sa, sd], axis=-1)
    e_ra = np.stack([-sa, ca, np.zeros_like(ra)], axis=-1)
    e_dec = np.stack([-sd * ca, -sd * sa, cd], axis=-1)
    v_eq = rv[..., None] * r_hat + (K_TAN * d)[..., None] * (pmra[..., None] * e_ra + pmdec[..., None] * e_dec)
    return v_eq @ A_G.T


def galactic_lb(xyz: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Galactic longitude/latitude in degrees from Cartesian coordinates."""
    x, y, z = xyz[..., 0], xyz[..., 1], xyz[..., 2]
    l = np.degrees(np.arctan2(y, x)) % 360.0
    b = np.degrees(np.arctan2(z, np.hypot(x, y)))
    return l, b


def propagate(ra_deg, dec_deg, pmra_masyr, pmdec_masyr, dt_years):
    """Linear proper-motion propagation on the sky (adequate for decades and |dec| < 89°).

    pmra is mu_alpha* (i.e. already multiplied by cos(dec)), in mas/yr.
    Returns (ra, dec) in degrees. NaN proper motions leave the position unchanged.
    """
    ra = np.asarray(ra_deg, dtype=float)
    dec = np.asarray(dec_deg, dtype=float)
    pmra = np.nan_to_num(np.asarray(pmra_masyr, dtype=float))
    pmdec = np.nan_to_num(np.asarray(pmdec_masyr, dtype=float))
    dt = np.asarray(dt_years, dtype=float)
    cosd = np.maximum(np.cos(np.radians(dec)), 1e-6)
    ra2 = ra + pmra * dt / 3.6e6 / cosd
    dec2 = dec + pmdec * dt / 3.6e6
    return ra2 % 360.0, np.clip(dec2, -90.0, 90.0)


def angular_sep_deg(ra1, dec1, ra2, dec2) -> np.ndarray:
    """Great-circle separation in degrees (haversine)."""
    ra1, dec1, ra2, dec2 = (np.radians(np.asarray(v, dtype=float)) for v in (ra1, dec1, ra2, dec2))
    s = np.sin((dec2 - dec1) / 2) ** 2 + np.cos(dec1) * np.cos(dec2) * np.sin((ra2 - ra1) / 2) ** 2
    return np.degrees(2 * np.arcsin(np.sqrt(np.clip(s, 0, 1))))
