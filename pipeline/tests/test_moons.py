"""The Solar System's moons from JPL's tables (galmap.moons)."""

import math

import numpy as np

from galmap import moons
from galmap.coords import A_G

ELEM = """<table><tr><th>ID</th><th>Planet</th><th>Satellite</th><th>Code</th><th>Ephemeris</th><th>Frame</th>
<th>Epoch<br>(TDB)</th><th>a<br>(km)</th><th>e</th><th>&omega;<br>(deg)</th><th>M<br>(deg)</th><th>i<br>(deg)</th>
<th>node<br>(deg)</th><th>P<br>(days)</th><th>P<br>apsis (yr)</th><th>P<br>node (yr)</th><th>R.A.<br>(deg)</th>
<th>Dec.<br>(deg)</th><th>Tilt<br>(deg)</th><th>Ref.</th></tr>
<tr><td>0</td><td>Earth</td><td>Moon</td><td>301</td><td>DE405</td><td>ecliptic</td><td>2000-01-01.5</td><td>384400.</td>
<td>0.0554</td><td>318.15</td><td>135.27</td><td>5.16</td><td>125.08</td><td>27.322</td><td>5.997</td><td>18.600</td>
<td></td><td></td><td></td><td>n/a</td></tr>
<tr><td>1</td><td>Jupiter</td><td>Io</td><td>501</td><td>JUP365</td><td>Laplace</td><td>2020-01-01.0</td><td>421800.</td>
<td>0.004</td><td>49.1</td><td>330.9</td><td>0.0</td><td>0.0</td><td>1.762732</td><td>1.333</td><td>0.000</td>
<td>268.1</td><td>64.5</td><td>0.0</td><td>1</td></tr>
<tr><td>2</td><td>Pluto</td><td>Charon</td><td>901</td><td>PLU060</td><td>equatorial</td><td>2000-01-01.5</td><td>19600.</td>
<td>0.000</td><td>0.0</td><td>304.1</td><td>0.0</td><td>0.0</td><td>6.387222</td><td>-</td><td>-</td>
<td></td><td></td><td></td><td>1</td></tr></table>"""

PHYS = """<table><tr><th>Planet</th><th>Satellite</th><th>Code</th><th>GM</th><th>Mean Radius</th><th>Density</th></tr>
<tr><th>value</th><th>sigma</th></tr>
<tr><td>Earth</td><td>Moon</td><td>301</td><td>4902.8 <span>0.001</span></td><td>1737.4 <span>0.1</span></td><td>3.344</td></tr>
</table>"""


def test_tables():
    els = moons.parse_elements(ELEM)
    assert [m["name"] for m in els] == ["Moon", "Io", "Charon"]
    assert els[0]["a_km"] == 384400.0 and els[1]["frame"] == "laplace" and els[1]["ra"] == 268.1
    assert moons.parse_radii(PHYS) == {"Moon": 1737.4}
    assert moons.epoch_jd("2000-01-01.5") == 2451545.0
    assert moons.epoch_jd("2020-01-01.0") == 2458849.5


def test_rows_for_the_planets_on_the_map():
    rows = moons.moon_rows(moons.parse_elements(ELEM), {"Moon": 1737.4}, {"Earth", "Jupiter"})
    assert [r["name"] for r in rows] == ["Moon", "Io"]
    moon, io = rows
    assert moon["de"] == "Mond" and moon["radius_known"] and abs(moon["radius"] - 1737.4 / 6371) < 1e-9
    assert not io["radius_known"]
    # Io's orbit lies in its Laplace plane (pole RA 268.1, Dec 64.5): P and Q perpendicular to it
    pole = A_G @ moons.unit(268.1, 64.5)
    assert abs(np.dot(io["P"], pole)) < 1e-9 and abs(np.dot(io["Q"], pole)) < 1e-9
    assert abs(np.dot(io["P"], io["Q"])) < 1e-12
    # the Moon's: 5.16 degrees to the ecliptic
    ecl = A_G @ np.array([0.0, -math.sin(moons.OBLIQUITY), math.cos(moons.OBLIQUITY)])
    normal = np.cross(moon["P"], moon["Q"])
    assert abs(math.degrees(math.acos(np.dot(normal, ecl))) - 5.16) < 1e-6
    # the mean anomaly carried back to J2000 from Io's 2020 epoch
    assert 0 <= io["m0"] < 2 * math.pi
