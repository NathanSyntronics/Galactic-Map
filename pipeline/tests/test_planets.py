"""Planet orbits (galmap.planets): orientation, phase, the Solar System, radii, host matching."""

import math

import numpy as np
import pandas as pd

from galmap import planets as PL
from galmap.coords import A_G, LY_PER_PC, unit_vectors


def galactic_to_ecliptic_longitude(v: np.ndarray) -> float:
    eq = A_G.T @ v
    eps = PL.OBLIQUITY
    to_ecl = np.array([[1, 0, 0], [0, math.cos(eps), math.sin(eps)], [0, -math.sin(eps), math.cos(eps)]])
    x, y, _ = to_ecl @ eq
    return math.degrees(math.atan2(y, x)) % 360


def test_kepler():
    for e in (0.0, 0.2, 0.9):
        for m in (0.1, 1.0, 3.0, 6.0):
            E = PL.kepler_e(m, e)
            assert abs(E - e * math.sin(E) - m) < 1e-10
    # and back from the true anomaly
    f = 1.2
    m = PL.mean_from_true(f, 0.3)
    E = PL.kepler_e(m, 0.3)
    assert abs(2 * math.atan(math.sqrt(1.3 / 0.7) * math.tan(E / 2)) - f) < 1e-9


def test_orbit_vectors_are_orthonormal():
    for P, Q in (PL.sky_orbit_vectors(120.0, -30.0, 63.0, 40.0, 110.0), PL.ecliptic_orbit_vectors(7.0, 48.3, 77.5)):
        assert abs(np.linalg.norm(P) - 1) < 1e-12 and abs(np.linalg.norm(Q) - 1) < 1e-12
        assert abs(P @ Q) < 1e-12


def test_earth_at_j2000():
    rows = PL.solar_rows(0)
    earth = next(r for r in rows if r["name"] == "Earth")
    pos = PL.position(earth["P"], earth["Q"], earth["a"], earth["e"], earth["m0"])
    # 1 January 2000, 12h: the Sun at ecliptic longitude 280.5 deg as seen from the Earth, so the
    # Earth at 100.5 deg as seen from the Sun, 0.983 AU away (near perihelion)
    assert abs(galactic_to_ecliptic_longitude(pos) - 100.5) < 1.0
    assert abs(np.linalg.norm(pos) - 0.9833) < 0.002
    # the planets keep to the ecliptic (Mercury 7 deg off at most)
    north_ecl = A_G @ np.array([0, -math.sin(PL.OBLIQUITY), math.cos(PL.OBLIQUITY)])
    for r in rows:
        n = np.cross(r["P"], r["Q"])
        assert math.degrees(math.acos(min(1, n @ north_ecl))) < 7.1


def test_transiting_planet_is_in_front_of_its_star_at_transit():
    ra, dec, dist_pc = 346.6, -5.04, 12.4  # TRAPPIST-1
    planets = pd.DataFrame(
        {
            "pl_name": ["T b"], "hostname": ["T"], "ra": [ra], "dec": [dec], "pl_orbper": [1.510826], "pl_orbsmax": [0.01154],
            "pl_orbeccen": [0.2], "pl_orbincl": [89.7], "pl_orblper": [336.86], "pl_orbtper": [np.nan],
            "pl_tranmid": [2457322.514193], "pl_rade": [1.116], "pl_bmasse": [1.374], "pl_eqt": [397.6],
            "st_mass": [0.0898], "disc_year": [2016], "cb_flag": [0], "discoverymethod": ["Transit"],
        }
    )
    row = PL.exoplanet_rows(planets, {"T": 0}, pd.DataFrame())[0]
    # back to the transit: mean anomaly there
    n = 2 * math.pi / row["period"]
    m_tr = row["m0"] - n * (PL.J2000 - 2457322.514193)
    pos = PL.position(row["P"], row["Q"], row["a"], row["e"], m_tr)
    towards_sun = -(unit_vectors(np.array([ra]), np.array([dec]))[0] @ A_G.T)
    cos = pos @ towards_sun / np.linalg.norm(pos)
    assert cos > 0.999  # between the star and us
    assert not row["flags"] & (PL.F_PHASE_ASSUMED | PL.F_INCL_ASSUMED | PL.F_ECC_ASSUMED)


def test_missing_values_are_filled_and_flagged():
    planets = pd.DataFrame(
        {
            "pl_name": ["X b", "X c"], "hostname": ["X", "X"], "ra": [10.0, 10.0], "dec": [20.0, 20.0],
            "pl_orbper": [365.25, np.nan], "pl_orbsmax": [np.nan, 4.0], "pl_orbeccen": [np.nan, 0.1],
            "pl_orbincl": [np.nan, 30.0], "pl_orblper": [np.nan, np.nan], "pl_orbtper": [np.nan, np.nan],
            "pl_tranmid": [np.nan, np.nan], "pl_rade": [np.nan, np.nan], "pl_bmasse": [317.8, np.nan], "pl_eqt": [np.nan, np.nan],
            "st_mass": [1.0, 1.0], "disc_year": [2000, 2001], "cb_flag": [0, 0], "discoverymethod": ["Radial Velocity", "Imaging"],
        }
    )
    b, c = PL.exoplanet_rows(planets, {"X": 0}, pd.DataFrame())
    assert abs(b["a"] - 1.0) < 1e-6 and abs(c["period"] - 365.25 * 8) < 1e-6  # Kepler's third law
    assert b["flags"] & PL.F_ECC_ASSUMED and b["flags"] & PL.F_INCL_ASSUMED and b["flags"] & PL.F_PHASE_ASSUMED
    assert b["incl"] == 30.0  # the system's plane
    assert b["flags"] & PL.F_RADIUS_EST and 11 < b["radius"] < 14  # a Jupiter mass: about a Jupiter radius
    assert np.isnan(c["radius"])


def test_radius_from_mass():
    assert abs(PL.radius_from_mass(1.0) - 1.0) < 1e-9
    assert 2.0 < PL.radius_from_mass(5.0) < 2.6
    assert 11 < PL.radius_from_mass(317.8) < 14
    assert np.isnan(PL.radius_from_mass(float("nan")))


def test_match_hosts():
    stars = pd.DataFrame(
        {
            "key": ["HIP 70890", "Gaia DR3 1", "HD 1"],
            "name_en": ["Proxima Centauri", None, None],
            "x": [2.944, 0.0, 100.0], "y": [-3.057, 50.0, 0.0], "z": [-0.142, 0.0, 0.0],
        }
    )
    # Gaia DR3 1 lies towards galactic (0, 1, 0): equatorial direction of that
    gy = A_G.T @ np.array([0.0, 1.0, 0.0])
    ra, dec = math.degrees(math.atan2(gy[1], gy[0])) % 360, math.degrees(math.asin(gy[2]))
    planets = pd.DataFrame(
        {
            "pl_name": ["Proxima Cen b", "Far b", "Other b"], "hostname": ["Proxima Cen", "Far", "Other"],
            "gaia_dr3_id": ["", "", ""], "hip_name": ["HIP 70890", "", ""], "hd_name": ["", "", ""],
            "ra": ["217.4", f"{ra}", "0.0"], "dec": ["-62.7", f"{dec}", "0.0"],
            "sy_dist": ["1.3", f"{50 / LY_PER_PC * 1.1}", "5.0"],
        }
    )
    out = PL.match_hosts(planets, stars)
    assert out == {"Proxima Cen": 0, "Far": 1}
