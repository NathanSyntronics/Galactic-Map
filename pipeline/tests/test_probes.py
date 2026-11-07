"""Probe trajectories: Horizons tables and their thinning."""

import numpy as np

from galmap.probes import parse, simplify

TABLE = """header
$$SOE
2461041.500000000, A.D. 2026-Jan-01 00:00:00.0000, -3.18E+01, -1.34E+02,  9.74E+01, -1.19E-03, -7.86E-03,  5.68E-03,
2461051.500000000, A.D. 2026-Jan-11 00:00:00.0000, -3.19E+01, -1.35E+02,  9.75E+01, -1.19E-03, -7.86E-03,  5.68E-03,
$$EOE
footer"""


def test_parse_reads_dates_positions_and_velocities():
    jd, pos, vel = parse(TABLE)
    assert jd.tolist() == [2461041.5, 2461051.5]
    assert pos[0].tolist() == [-31.8, -134.0, 97.4]
    assert vel[1].tolist() == [-1.19e-3, -7.86e-3, 5.68e-3]


def test_simplify_keeps_the_ends_of_straight_uniform_motion_and_the_corners():
    jd = np.arange(100.0)
    straight = np.stack([jd * 0.01, jd * 0.02, np.zeros(100)], axis=1)
    assert simplify(jd, straight) == [0, 99]
    # a turn at day 50: the corner is kept, and interpolation stays within the tolerance
    bent = straight.copy()
    bent[50:, 0] = 0.5 - (jd[50:] - 50) * 0.01
    keep = simplify(jd, bent)
    assert 50 in keep or 49 in keep or 51 in keep
    for i in range(100):
        a = max(k for k in keep if k <= i)
        b = min(k for k in keep if k >= i)
        f = 0 if a == b else (jd[i] - jd[a]) / (jd[b] - jd[a])
        assert np.linalg.norm(bent[a] + f * (bent[b] - bent[a]) - bent[i]) <= 1e-3 + 1e-12
