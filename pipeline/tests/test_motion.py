"""Space velocities of the stars (galmap.coords.space_velocity, derive.kinematics, systems.common_velocities)."""

import numpy as np
import pandas as pd

from galmap import derive, systems
from galmap.coords import LY_PER_YR_PER_KMS, space_velocity
from galmap.flags import Flag


def test_barnards_star():
    # Gaia DR3: ra 269.4486, dec 4.7397, 1.8282 pc, pm (-801.55, 10362.39) mas/yr, rv -110.47 km/s
    v = space_velocity(269.4486, 4.7397, 1.8282, -801.55, 10362.39, -110.47)
    # (U, V, W) about (-142, +5, +18) km/s, 142.5 km/s in all
    assert np.allclose(v, [-141.3, 4.9, 18.4], atol=0.5)
    assert abs(np.linalg.norm(v) - 142.5) < 0.5


def test_unknown_radial_velocity_leaves_the_tangential_part():
    v = space_velocity(0.0, 0.0, 10.0, 0.0, 100.0, np.nan)
    assert np.isclose(np.linalg.norm(v), 4.74047 * 0.1 * 10.0, rtol=1e-4)
    assert np.isnan(space_velocity(0.0, 0.0, 10.0, np.nan, np.nan, 5.0)).all()


def test_positions_move_to_the_epoch():
    s = pd.DataFrame({"ra": [0.0], "dec": [0.0], "pmra": [0.0], "pmdec": [1000.0], "rv": [np.nan], "epoch": [1991.25]})
    xyz, vel = derive.kinematics(s, np.array([10.0]))
    still, _ = derive.kinematics(s.assign(epoch=2016.0), np.array([10.0]))
    moved = np.linalg.norm(xyz - still)
    assert np.isclose(moved, np.linalg.norm(vel) * LY_PER_YR_PER_KMS * (2016.0 - 1991.25), rtol=1e-9)


def test_system_members_move_together():
    s = pd.DataFrame(
        {
            "system_id": [3, 3, -1],
            "flags": [Flag.SYSTEM_PRIMARY, 0, 0],
            "vx": [10.0, 11.0, 5.0],
            "vy": [1.0, np.nan, 5.0],
            "vz": [0.0, 2.0, 5.0],
        }
    )
    assert systems.common_velocities(s) == 1
    assert s[["vx", "vy", "vz"]].to_numpy().tolist() == [[10.0, 1.0, 0.0], [10.0, 1.0, 0.0], [5.0, 5.0, 5.0]]


def test_system_takes_the_most_reliable_radial_velocity():
    # Alpha Centauri: A's radial velocity in the catalogue is an old one, Proxima's from Gaia DR3
    s = pd.DataFrame(
        {
            "system_id": [1, 1, 1],
            "flags": [Flag.SYSTEM_PRIMARY, 0, 0],
            "rv": [-15.3, np.nan, -21.9],
            "rv_gaia": [False, False, True],
            "vx": [-20.0, -21.0, -24.0],
            "vy": [1.0, 1.0, 1.0],
            "vz": [13.0, 13.0, 13.5],
        }
    )
    systems.common_velocities(s)
    assert (s["vx"] == -24.0).all() and (s["vz"] == 13.5).all()
