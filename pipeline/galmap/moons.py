"""The moons of the Solar System's planets (docs/PLANETS.md, "Moons"), from JPL's planetary
satellite mean elements and physical parameters:

    https://ssd.jpl.nasa.gov/sats/elem/     a, e, ω, M, i, node, period at an epoch, per moon,
                                            relative to the ecliptic, the planet's equator or the
                                            moon's local Laplace plane (its pole given)
    https://ssd.jpl.nasa.gov/sats/phys_par/ mean radii (the larger moons)

No exomoon is confirmed (Kepler-1625 b I and Kepler-1708 b I are disputed candidates), so these
are all the moons there are to draw. Pluto's are left out (Pluto is not on the map).
"""

from __future__ import annotations

import html
import logging
import math
import re
from datetime import datetime

import numpy as np

from .coords import A_G
from .download import CACHE_DIR, fetch

log = logging.getLogger(__name__)

ELEM_URL = "https://ssd.jpl.nasa.gov/sats/elem/"
PHYS_URL = "https://ssd.jpl.nasa.gov/sats/phys_par/"
DIR = CACHE_DIR / "moons"

SOURCE_INFO = {
    "key": "jpl-satellites",
    "title": "JPL Solar System Dynamics: planetary satellite mean elements and physical parameters",
    "url": "https://ssd.jpl.nasa.gov/sats/elem/",
}

J2000 = 2451545.0
OBLIQUITY = math.radians(23.4392911)
EARTH_RADIUS_KM = 6371.0
AU_KM = 149_597_870.7
#: radius (km) of a moon without one in the table: the small irregular moons are a few km across
DEFAULT_RADIUS_KM = 3.0

#: north poles of the planets (ICRF, J2000; IAU, Archinal et al. 2018): the reference plane of the
#: moons whose elements are given relative to the planet's equator
PLANET_POLES = {
    "Earth": (0.0, 90.0),
    "Mars": (317.681, 52.887),
    "Jupiter": (268.057, 64.495),
    "Saturn": (40.589, 83.537),
    "Uranus": (257.311, -15.175),
    "Neptune": (299.36, 43.46),
}

#: German names where they differ
GERMAN = {"Moon": "Mond", "Ganymede": "Ganymed", "Callisto": "Kallisto"}


def _cells(row: str) -> list[str]:
    cells = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, re.S)
    return [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", c))).strip() for c in cells]


def _rows(page: str) -> list[list[str]]:
    table = re.search(r"<table.*?</table>", page, re.S)
    if not table:
        raise ValueError("no table in the JPL page")
    return [_cells(r) for r in re.findall(r"<tr.*?</tr>", table.group(0), re.S)]


def _num(s: str) -> float:
    m = re.match(r"[-+]?\d+(?:\.\d*)?(?:[eE][-+]?\d+)?", s.strip())
    return float(m.group(0)) if m else float("nan")


def parse_elements(page: str) -> list[dict]:
    """The rows of the mean elements table."""
    rows = _rows(page)
    head = rows[0]
    # (header names without spaces: "Epoch (TDB)" -> "Epoch(TDB)")
    col = {name.replace(" ", ""): k for k, name in enumerate(head)}
    out = []
    for r in rows[1:]:
        if len(r) < len(head):
            continue
        out.append(
            {
                "planet": r[col["Planet"]],
                "name": r[col["Satellite"]],
                "frame": r[col["Frame"]].lower(),
                "epoch": r[col["Epoch(TDB)"]],
                "a_km": _num(r[col["a(km)"]]),
                "e": _num(r[col["e"]]),
                "w": _num(r[col["ω(deg)"]]),
                "m": _num(r[col["M(deg)"]]),
                "i": _num(r[col["i(deg)"]]),
                "node": _num(r[col["node(deg)"]]),
                "period": _num(r[col["P(days)"]]),
                "ra": _num(r[col["R.A.(deg)"]]),
                "dec": _num(r[col["Dec.(deg)"]]),
            }
        )
    return out


def parse_radii(page: str) -> dict[str, float]:
    """Mean radius (km) by moon name, from the physical parameters table."""
    radii = {}
    for r in _rows(page)[2:]:
        if len(r) >= 5:
            v = _num(r[4])
            if np.isfinite(v) and v > 0:
                radii[r[1]] = v
    return radii


def epoch_jd(text: str) -> float:
    """Julian date of an epoch like "2000-01-01.5" (a day with a fraction)."""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})(\.\d+)?", text)
    if not m:
        return J2000
    day = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return day.toordinal() + 1721424.5 + float(m.group(4) or 0)


def unit(ra_deg: float, dec_deg: float) -> np.ndarray:
    ra, dec = math.radians(ra_deg), math.radians(dec_deg)
    return np.array([math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec)])


def reference_pole(m: dict) -> np.ndarray | None:
    """The pole (ICRF) of the plane a moon's elements refer to."""
    if m["frame"] == "ecliptic":
        return np.array([0.0, -math.sin(OBLIQUITY), math.cos(OBLIQUITY)])
    if m["frame"] == "laplace" and np.isfinite(m["ra"]) and np.isfinite(m["dec"]):
        return unit(m["ra"], m["dec"])
    pole = PLANET_POLES.get(m["planet"])
    return unit(*pole) if pole else None


def orbit_vectors(pole: np.ndarray, incl: float, node: float, w: float) -> tuple[np.ndarray, np.ndarray]:
    """P (towards the periapsis) and Q, galactic, of an orbit given relative to a plane with pole
    `pole` (ICRF): the node is counted from that plane's ascending node on the ICRF equator."""
    n0 = np.cross([0.0, 0.0, 1.0], pole)
    n0 = n0 / np.linalg.norm(n0) if np.linalg.norm(n0) > 1e-12 else np.array([1.0, 0.0, 0.0])
    e2 = np.cross(pole, n0)
    i, N, om = math.radians(incl), math.radians(node), math.radians(w)
    ci, si, cn, sn, cw, sw = math.cos(i), math.sin(i), math.cos(N), math.sin(N), math.cos(om), math.sin(om)
    P = (cn * cw - sn * sw * ci) * n0 + (sn * cw + cn * sw * ci) * e2 + (sw * si) * pole
    Q = (-cn * sw - sn * cw * ci) * n0 + (-sn * sw + cn * cw * ci) * e2 + (cw * si) * pole
    return A_G @ P, A_G @ Q


def moon_rows(elements: list[dict], radii: dict[str, float], planets: set[str]) -> list[dict]:
    """Rows for planets.json: one per moon of a planet on the map (parent: the planet's name)."""
    rows = []
    for m in elements:
        if m["planet"] not in planets or not (m["a_km"] > 0 and m["period"] > 0):
            continue
        pole = reference_pole(m)
        if pole is None:
            continue
        P, Q = orbit_vectors(pole, m["i"], m["node"], m["w"])
        # the mean anomaly at J2000, as the planets have it
        m0 = math.radians(m["m"]) - 2 * math.pi * (epoch_jd(m["epoch"]) - J2000) / m["period"]
        radius = radii.get(m["name"])
        rows.append(
            {
                "parent": m["planet"],
                "name": m["name"],
                "de": GERMAN.get(m["name"]),
                "a": m["a_km"] / AU_KM,
                "e": m["e"] if np.isfinite(m["e"]) else 0.0,
                "period": m["period"],
                "m0": m0 % (2 * math.pi),
                "P": P,
                "Q": Q,
                "incl": m["i"],
                "radius": (radius if radius else DEFAULT_RADIUS_KM) / EARTH_RADIUS_KM,
                "radius_known": bool(radius),
            }
        )
    log.info("moons: %d of %d in the JPL table (planets on the map)", len(rows), len(elements))
    return rows


def load(refresh: bool = False) -> tuple[list[dict], dict[str, float]]:
    elem = fetch(ELEM_URL, DIR / "elem.html", refresh=refresh).read_text("utf-8", errors="replace")
    phys = fetch(PHYS_URL, DIR / "phys_par.html", refresh=refresh).read_text("utf-8", errors="replace")
    return parse_elements(elem), parse_radii(phys)
