"""Multiple systems: catalogue pairs checked by distance and proper motion, members checked against
their system's best-measured star."""

import numpy as np
import pandas as pd

from galmap import systems
from galmap.sources import simbad


def stars(rows: list[dict]) -> pd.DataFrame:
    """Star rows with the columns assign_systems reads; positions from ra, dec and the parallax."""
    t = pd.DataFrame(rows)
    ra, dec = np.radians(t["ra"].to_numpy(float)), np.radians(t["dec"].to_numpy(float))
    ly = 1000.0 / t["plx"].to_numpy(float) * 3.26156
    t["x"], t["y"], t["z"] = ly * np.cos(dec) * np.cos(ra), ly * np.cos(dec) * np.sin(ra), ly * np.sin(dec)
    t["dist_pc"] = 1000.0 / t["plx"]
    t["epoch"] = 2016.0
    t["flags"] = 0
    for c, v in (("system_row", pd.NA), ("wds", None), ("logl", np.nan)):
        if c not in t:
            t[c] = v
    t["system_row"] = t["system_row"].astype("Int64")
    return t


def test_an_optical_companion_is_not_a_member():
    # Aldebaran, its companion B (moves with it) and "Aldebaran C" (BD+16 630): 2.2' away in the
    # sky, 2.7 times as far, another proper motion; its parallax so poor that the distances agree
    s = stars([
        dict(ra=68.98016, dec=16.50930, plx=48.94, plx_err=0.77, pmra=63.45, pmdec=-188.94, logl=2.6, wds="J04359+1631"),
        dict(ra=68.98853, dec=16.50593, plx=47.25, plx_err=0.10, pmra=58.92, pmdec=-198.84, logl=-1.3, wds="J04359+1631"),
        dict(ra=69.00032, dec=16.54079, plx=18.36, plx_err=11.0, pmra=96.04, pmdec=-27.08, logl=-0.8, wds="J04359+1631"),
    ])
    out = systems.assign_systems(s)
    sid = out["system_id"].to_numpy()
    assert sid[0] >= 0 and sid[0] == sid[1]
    assert sid[2] == -1


def test_a_wide_pair_of_massive_stars_beyond_100_pc():
    # Beta1 and Beta2 Scorpii, 13.6" apart: proper motions 9 km/s apart (bright stars, unresolved
    # companions), within the tolerance
    s = stars([
        dict(ra=241.35930, dec=-19.80545, plx=8.07, plx_err=0.78, pmra=-5.20, pmdec=-24.04, logl=4.4, wds="J16054-1948"),
        dict(ra=241.36070, dec=-19.80190, plx=8.24, plx_err=0.50, pmra=-18.47, pmdec=-15.59, logl=3.3, wds="J16054-1948"),
    ])
    sid = systems.assign_systems(s)["system_id"].to_numpy()
    assert sid[0] >= 0 and sid[0] == sid[1]


def test_members_are_checked_against_the_best_measured_star():
    # a chain: 1 agrees with 0 and 2 with 1, but 2 not with 0 (the best measured)
    rows = [
        dict(ra=10.0, dec=0.0, plx=10.00, plx_err=0.01, pmra=10.0, pmdec=0.0),
        dict(ra=10.001, dec=0.0, plx=9.40, plx_err=0.30, pmra=10.0, pmdec=0.0),
        dict(ra=10.002, dec=0.0, plx=8.60, plx_err=0.30, pmra=10.0, pmdec=0.0),
    ]
    s = stars(rows)
    labels, detached = systems.vet_members(s, np.zeros(3, dtype=np.int64), np.zeros(3, bool))
    assert detached == 1
    assert labels[0] == labels[1] and labels[2] != labels[0]
    # census members stay whatever their numbers, and the best measured of them is the reference
    s = stars(rows + [dict(ra=10.003, dec=0.0, plx=5.00, plx_err=0.30, pmra=10.0, pmdec=0.0)])
    census = np.array([True, False, False, True])
    labels, detached = systems.vet_members(s, np.zeros(4, dtype=np.int64), census)
    assert detached == 1
    assert labels[0] == labels[1] == labels[3] and labels[2] != labels[0]


def test_motion_check():
    s = stars([
        dict(ra=0.0, dec=0.0, plx=50.0, plx_err=0.1, pmra=100.0, pmdec=0.0, logl=0.0),
        dict(ra=0.0, dec=10 / 3600, plx=50.0, plx_err=0.1, pmra=100.0 + 40.0, pmdec=0.0, logl=0.0),  # 3.8 km/s at 200 AU
        dict(ra=0.0, dec=10 / 3600, plx=50.0, plx_err=0.1, pmra=100.0 + 120.0, pmdec=0.0, logl=0.0),  # 11.4 km/s
        dict(ra=0.0, dec=10 / 3600, plx=50.0, plx_err=0.1, pmra=np.nan, pmdec=np.nan, logl=0.0),  # no proper motion
    ])
    m = systems._Motion(s)
    assert m.ok(0, 1) and not m.ok(0, 2) and m.ok(0, 3)


def test_wds_numbers_by_hip_and_gaia():
    t = pd.DataFrame({
        "id": ["HIP 78820", "Gaia DR3 6247207266944651648", "HIP  95241", "HD 1", "Gaia DR3 99"],
        "wds": ["WDS J16054-1948AB", "WDS J16054-1948CE", "WDS J19226-4428A", "WDS J00000+0000", "CCDM J1"],
    })
    table = simbad.wds_table(t)
    assert table == {("hip", 78820): "J16054-1948", ("gaia", 6247207266944651648): "J16054-1948", ("hip", 95241): "J19226-4428"}
    s = pd.DataFrame({"gaia": pd.array([6247207266944651648, pd.NA, pd.NA], dtype="Int64"), "hip": pd.array([pd.NA, 78820, 5], dtype="Int64")})
    assert list(simbad.wds_of(s, table)) == ["J16054-1948", "J16054-1948", None]
