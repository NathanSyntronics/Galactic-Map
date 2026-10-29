"""Close binaries (galmap.binaries): ORB6 parsing, the orbit's ephemeris, separating a pair."""

import math

import numpy as np
import pandas as pd

from galmap import binaries as B
from galmap.coords import LY_PER_PC

# two lines of ORB6 (Alpha Centauri AB, Procyon AB)
ORB6 = """143936.50-605002.3 14396-6050 RHD   1AB      .     128620  71683  -0.01   1.33     79.762   y   0.019     17.4930 a  0.0096   79.2430   0.0089 205.073     0.025   1955.564   y   0.015    0.51947  0.00015  231.519    0.027            2 n Ake2021  wds14396-6050g.png
073918.12+051330.0 07393+0514 SHB   1AB       6251  61421  37279   0.46  10.8      40.840   y   0.022      4.3075 a  0.0016   31.408    0.050  100.683     0.095   1968.076   y   0.023    0.39785  0.00025   89.23     0.11   2000 2014 3 n BdH2015  wds07393+0514c.png
"""


def test_parse():
    o = B.parse(ORB6)
    assert list(o["pair"]) == ["AB", "AB"]
    ac = o.iloc[0]
    assert ac["hip"] == 71683 and ac["hd"] == 128620 and ac["grade"] == 2
    assert abs(ac["P"] - 79.762) < 1e-9 and abs(ac["a"] - 17.493) < 1e-9 and abs(ac["T"] - 1955.564) < 1e-9


def test_split_pair():
    assert B.split_pair("AB") == ("A", "B")
    assert B.split_pair("Aa,Ab") == ("Aa", "Ab")
    assert B.split_pair("BC") == ("B", "C")
    assert B.split_pair("A") is None


def test_alpha_centauri_ephemeris():
    ac = B.parse(ORB6).iloc[0]
    # published separations: about 4.0" at position angle 300 deg in 2016, 8.4" at 8 deg in mid 2024
    for epoch, rho, theta in ((2016.0, 4.0, 302.5), (2024.5, 8.43, 7.9)):
        n, e, _ = B.relative_position(ac, epoch)
        assert abs(math.hypot(n, e) - rho) < 0.1
        assert abs((math.degrees(math.atan2(e, n)) - theta + 180) % 360 - 180) < 1.5
    # the true separation within the orbit's range: a (1 - e) .. a (1 + e)
    r = np.linalg.norm(B.relative_position(ac, 2016.0))
    assert 17.493 * 0.48 <= r <= 17.493 * 1.52


# an orbit without HD and HIP numbers
ORB6_NO_IDS = """000048.09+165917.5 00008+1659 BAG  18        .     .      .        8.79  12.6      66.62    y    .         0.531  a   .      167.7       .     142.2        .      1990.25    y    .       0.372     .       358.9       .          2018 5   Tok2019c wds00008+1659a.png
"""


def test_separate_moves_the_secondary():
    o = pd.concat([B.parse(ORB6), B.parse(ORB6_NO_IDS)], ignore_index=True)
    assert len(o) == 3 and pd.isna(o.loc[2, "hip"])
    dist = 1.3384
    xyz = [3.1, -3.0, -0.05]
    s = pd.DataFrame(
        {
            "x": [xyz[0], xyz[0], 2.9], "y": [xyz[1], xyz[1], -3.05], "z": [xyz[2], xyz[2], -0.14],
            "ra": [219.8589, 219.8589, 217.39], "dec": [-60.8316, -60.8316, -62.68], "dist_pc": [dist, dist, 1.3],
            "census_name": ["alpha Cen A", "alpha Cen B", "Proxima Centauri"],
            "name_en": ["Alpha Centauri A", "Alpha Centauri B", "Proxima Centauri"],
            "hip": pd.array([71683, 71681, 70890], dtype="Int64"), "hd": pd.array([128620, 128621, pd.NA], dtype="Int64"),
            "is_sun": [False, False, False],
        }
    )
    assert B.separate(s, o) == 1
    a = s.loc[0, ["x", "y", "z"]].to_numpy(float)
    b = s.loc[1, ["x", "y", "z"]].to_numpy(float)
    assert np.allclose(a, xyz)  # the primary stays
    sep_au = np.linalg.norm(b - a) * B.AU_PER_LY
    r_arcsec = np.linalg.norm(B.relative_position(o.iloc[0], B.EPOCH))
    assert abs(sep_au - r_arcsec * dist) < 1e-6
    assert 10 < sep_au < 40
    assert s.loc[2, "x"] == 2.9  # not part of the pair
