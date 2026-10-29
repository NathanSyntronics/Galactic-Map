"""Planets: the confirmed exoplanets of the stars on the map and the planets of the Solar System,
with their orbits (docs/PLANETS.md).

    cd pipeline && python -m galmap.planets --data ../public/data [--refresh]

Runs after the star build (galmap.build): the hosts are found among the built stars (those with a
planet count), so the file names each host by its node path and index.

Orbits are written as two unit vectors in the heliocentric galactic frame of the stars: P towards
the periapsis and Q 90 degrees ahead in the orbital plane, so that a planet's position relative to
its star is a (cos E - e) P + a sqrt(1 - e^2) sin E Q, E being the eccentric anomaly of the mean
anomaly M = M0 + 2 pi (t - J2000) / period.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from .compare import read_stars
from .coords import A_G, LY_PER_PC, unit_vectors
from .download import CACHE_DIR, tap_sync
from .sources.exoplanets import SOURCE_INFO, TAP

log = logging.getLogger("galmap.planets")

FILE = CACHE_DIR / "exoplanets" / "planets.csv"
COLUMNS = (
    "pl_name, hostname, pl_letter, hip_name, hd_name, gaia_dr3_id, ra, dec, sy_dist, sy_snum, sy_pnum, cb_flag, "
    "pl_orbper, pl_orbsmax, pl_orbeccen, pl_orbincl, pl_orblper, pl_orbtper, pl_tranmid, "
    "pl_rade, pl_bmasse, pl_bmassprov, pl_eqt, st_mass, st_rad, st_teff, discoverymethod, disc_year"
)
QUERY = f"select {COLUMNS} from pscomppars"
MIN_ROWS = 5000

J2000 = 2451545.0
DAYS_PER_YEAR = 365.25
AU_PER_LY = 63241.077
OBLIQUITY = math.radians(23.43928)

# flags of a planet (bit field)
F_RADIUS_EST = 1  # radius from the mass (or a default)
F_INCL_ASSUMED = 2  # inclination not measured: the system's plane, else a fixed pseudo-random one
F_PHASE_ASSUMED = 4  # no time of periastron or transit: a fixed pseudo-random position on the orbit
F_ECC_ASSUMED = 8  # eccentricity not measured: circular
F_SOLAR = 16  # a planet of the Solar System (its orbit fully known)
F_CIRCUMBINARY = 32  # orbits both stars of a binary

METHODS = [
    "Transit", "Radial Velocity", "Imaging", "Microlensing", "Transit Timing Variations",
    "Eclipse Timing Variations", "Orbital Brightness Modulation", "Pulsar Timing",
    "Pulsation Timing Variations", "Astrometry", "Disk Kinematics", "Solar System",
]

# The planets of the Solar System: Keplerian elements at J2000 relative to the ecliptic and equinox
# of J2000 (E. M. Standish, "Keplerian Elements for Approximate Positions of the Major Planets",
# JPL, table 1): a (AU), e, I, L (mean longitude), long. perihelion, long. ascending node (deg);
# sidereal period (days), equatorial radius and mass (Earth = 1).
SOLAR_SYSTEM = [
    ("Mercury", "Merkur", 0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593, 87.969, 0.383, 0.0553),
    ("Venus", "Venus", 0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255, 224.701, 0.949, 0.815),
    ("Earth", "Erde", 1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0, 365.256, 1.0, 1.0),
    ("Mars", "Mars", 1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 686.980, 0.532, 0.107),
    ("Jupiter", "Jupiter", 5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, 4332.59, 11.21, 317.8),
    ("Saturn", "Saturn", 9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, 10759.22, 9.45, 95.2),
    ("Uranus", "Uranus", 19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503, 30688.5, 4.01, 14.5),
    ("Neptune", "Neptun", 30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574, 60182.0, 3.88, 17.1),
]


def _hash01(s: str) -> float:
    """A fixed pseudo-random number in [0, 1) for a text."""
    return int.from_bytes(hashlib.blake2b(s.encode(), digest_size=8).digest(), "little") / 2**64


def _num(s: pd.Series) -> np.ndarray:
    return pd.to_numeric(s, errors="coerce").to_numpy(dtype=float)


def load(refresh: bool = False) -> pd.DataFrame:
    """The confirmed planets (one row each) with their orbits, sizes and hosts."""
    if FILE.exists() and not refresh:
        raw = pd.read_csv(FILE, dtype=str, keep_default_na=False)
    else:
        raw = tap_sync(TAP, QUERY, timeout=600)
        if len(raw) < MIN_ROWS:
            raise RuntimeError(f"NASA Exoplanet Archive returned only {len(raw)} planets")
        FILE.parent.mkdir(parents=True, exist_ok=True)
        raw.to_csv(FILE, index=False)
    log.info("NASA Exoplanet Archive: %d confirmed planets around %d hosts", len(raw), raw["hostname"].nunique())
    return raw


# ------------------------------------------------------------------ orbits


def kepler_e(m: float, e: float) -> float:
    """Eccentric anomaly of a mean anomaly (Newton's method)."""
    E = m if e < 0.8 else math.pi
    for _ in range(50):
        d = (E - e * math.sin(E) - m) / (1 - e * math.cos(E))
        E -= d
        if abs(d) < 1e-12:
            break
    return E


def mean_from_true(f: float, e: float) -> float:
    E = 2 * math.atan2(math.sqrt(1 - e) * math.sin(f / 2), math.sqrt(1 + e) * math.cos(f / 2))
    return E - e * math.sin(E)


def sky_basis(ra: float, dec: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Equatorial unit vectors at a star: north, east (on the sky) and away from the observer."""
    a, d = math.radians(ra), math.radians(dec)
    away = np.array([math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)])
    north = np.array([-math.sin(d) * math.cos(a), -math.sin(d) * math.sin(a), math.cos(d)])
    east = np.array([-math.sin(a), math.cos(a), 0.0])
    return north, east, away


def sky_orbit_vectors(ra: float, dec: float, incl: float, node: float, omega_star: float) -> tuple[np.ndarray, np.ndarray]:
    """P and Q (galactic) of a planet's orbit given in the sky frame of its star: inclination,
    longitude of the ascending node (from north through east) and the star's argument of
    periastron (the planet's is 180 degrees on, the radial-velocity convention), all in degrees.
    In the sky frame (Heintz) a body at u = omega + f is at
        north: cos N cos u - sin N sin u cos i,  east: sin N cos u + cos N sin u cos i,
        away from the observer: sin u sin i."""
    n_, e_, z_ = sky_basis(ra, dec)
    i, N = math.radians(incl), math.radians(node)
    w = math.radians(omega_star) + math.pi

    def direction(u: float) -> np.ndarray:
        return (
            n_ * (math.cos(N) * math.cos(u) - math.sin(N) * math.sin(u) * math.cos(i))
            + e_ * (math.sin(N) * math.cos(u) + math.cos(N) * math.sin(u) * math.cos(i))
            + z_ * (math.sin(u) * math.sin(i))
        )

    return A_G @ direction(w), A_G @ direction(w + math.pi / 2)


def ecliptic_orbit_vectors(incl: float, node: float, peri_long: float) -> tuple[np.ndarray, np.ndarray]:
    """P and Q (galactic) of an orbit given relative to the ecliptic of J2000 (degrees)."""
    i, N = math.radians(incl), math.radians(node)
    w = math.radians(peri_long - node)
    P = np.array([
        math.cos(w) * math.cos(N) - math.sin(w) * math.sin(N) * math.cos(i),
        math.cos(w) * math.sin(N) + math.sin(w) * math.cos(N) * math.cos(i),
        math.sin(w) * math.sin(i),
    ])
    Q = np.array([
        -math.sin(w) * math.cos(N) - math.cos(w) * math.sin(N) * math.cos(i),
        -math.sin(w) * math.sin(N) + math.cos(w) * math.cos(N) * math.cos(i),
        math.cos(w) * math.sin(i),
    ])
    eps = OBLIQUITY
    to_eq = np.array([[1, 0, 0], [0, math.cos(eps), -math.sin(eps)], [0, math.sin(eps), math.cos(eps)]])
    return A_G @ (to_eq @ P), A_G @ (to_eq @ Q)


def position(P: np.ndarray, Q: np.ndarray, a: float, e: float, m: float) -> np.ndarray:
    """Position relative to the star (units of a) at mean anomaly m."""
    E = kepler_e(m, e)
    return a * (math.cos(E) - e) * P + a * math.sqrt(1 - e * e) * math.sin(E) * Q


def radius_from_mass(m_earth: float) -> float:
    """Radius (Earth radii) of a planet of a mass (Earth masses): Chen & Kipping (2017), the mean
    relation of their three regimes (terran, neptunian, jovian)."""
    if not np.isfinite(m_earth) or m_earth <= 0:
        return float("nan")
    if m_earth < 2.04:
        return m_earth**0.279
    r_2 = 2.04**0.279
    if m_earth < 132:
        return r_2 * (m_earth / 2.04) ** 0.589
    return r_2 * (132 / 2.04) ** 0.589 * (m_earth / 132) ** -0.044


# ------------------------------------------------------------------ hosts


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def match_hosts(planets: pd.DataFrame, stars: pd.DataFrame) -> dict[str, int]:
    """Archive host name -> row of `stars` (the built stars with a planet count): by designation
    (Gaia DR3, HIP, HD), by name, else the nearest host star in the direction of the archive's
    position (within 0.5 deg; with the distance within 30 %)."""
    hosts = planets.groupby("hostname").agg(
        gaia=("gaia_dr3_id", "first"), hip=("hip_name", "first"), hd=("hd_name", "first"),
        ra=("ra", "first"), dec=("dec", "first"), dist=("sy_dist", "first"), n=("pl_name", "nunique"),
    )
    by_key: dict[str, int] = {}
    for k, key in enumerate(stars["key"]):
        by_key.setdefault(_norm(key), k)
    by_name: dict[str, int] = {}
    for k, name in enumerate(stars["name_en"]):
        if isinstance(name, str):
            by_name.setdefault(_norm(name), k)
    xyz = stars[["x", "y", "z"]].to_numpy(float)
    d = np.linalg.norm(xyz, axis=1)
    u = xyz / np.maximum(d, 1e-9)[:, None]
    tree = cKDTree(u)
    out: dict[str, int] = {}
    taken: set[int] = set()
    counts = {"designation": 0, "name": 0, "position": 0}
    rest = []
    for host, h in hosts.iterrows():
        k = None
        for v in (h["gaia"], h["hip"], h["hd"]):
            if isinstance(v, str) and v and _norm(v) in by_key:
                k = by_key[_norm(v)]
                break
        how = "designation"
        if k is None and _norm(host) in by_name:
            k, how = by_name[_norm(host)], "name"
        if k is None or k in taken:
            rest.append(host)
            continue
        out[host] = k
        taken.add(k)
        counts[how] += 1
    for host in rest:
        h = hosts.loc[host]
        ra, dec, dist = float(h["ra"] or "nan"), float(h["dec"] or "nan"), float(h["dist"] or "nan")
        if not (np.isfinite(ra) and np.isfinite(dec)):
            continue
        hu = unit_vectors(np.array([ra]), np.array([dec]))[0] @ A_G.T
        for j in tree.query_ball_point(hu, r=2 * math.sin(math.radians(0.5) / 2)):
            if j in taken:
                continue
            if np.isfinite(dist) and abs(d[j] - dist * LY_PER_PC) > 0.3 * dist * LY_PER_PC:
                continue
            out[host] = j
            taken.add(j)
            counts["position"] += 1
            break
    log.info("hosts on the map: %d of %d (%s)", len(out), len(hosts), ", ".join(f"{v} by {k}" for k, v in counts.items()))
    return out


# ------------------------------------------------------------------ planets


def exoplanet_rows(planets: pd.DataFrame, host_of: dict[str, int], stars: pd.DataFrame) -> list[dict]:
    """The planets of the matched hosts with their orbits (see the module docstring)."""
    rows = []
    p = planets[planets["hostname"].isin(host_of.keys())].copy()
    for c in ("ra", "dec", "pl_orbper", "pl_orbsmax", "pl_orbeccen", "pl_orbincl", "pl_orblper", "pl_orbtper",
              "pl_tranmid", "pl_rade", "pl_bmasse", "pl_eqt", "st_mass", "disc_year", "cb_flag"):
        p[c] = _num(p[c])
    for host, g in p.groupby("hostname", sort=True):
        # the system's plane: the planets' measured inclinations (median), else a fixed
        # pseudo-random one (isotropic); its node line on the sky: unknown, fixed pseudo-random
        known_i = g["pl_orbincl"].dropna()
        sys_incl = float(np.median(known_i)) if len(known_i) else math.degrees(math.acos(1 - 2 * _hash01(host + ":i")))
        node = 360.0 * _hash01(host + ":node")
        # in the order of their distance from the star (missing ones from the period)
        mst = g["st_mass"].where(g["st_mass"] > 0, 1.0).fillna(1.0)
        a_est = g["pl_orbsmax"].fillna((mst * (g["pl_orbper"] / DAYS_PER_YEAR) ** 2) ** (1 / 3))
        for _, r in g.assign(_a=a_est).sort_values("_a").iterrows():
            flags = 0
            mstar = r["st_mass"] if np.isfinite(r["st_mass"]) and r["st_mass"] > 0 else 1.0
            per, a = r["pl_orbper"], r["pl_orbsmax"]
            if not np.isfinite(a) and np.isfinite(per):
                a = (mstar * (per / DAYS_PER_YEAR) ** 2) ** (1 / 3)
            if not np.isfinite(per) and np.isfinite(a):
                per = DAYS_PER_YEAR * math.sqrt(a**3 / mstar)
            if not (np.isfinite(a) and np.isfinite(per) and a > 0 and per > 0):
                continue
            e = r["pl_orbeccen"]
            if not np.isfinite(e):
                e, flags = 0.0, flags | F_ECC_ASSUMED
            e = min(max(float(e), 0.0), 0.97)
            incl = r["pl_orbincl"]
            if not np.isfinite(incl):
                incl, flags = sys_incl, flags | F_INCL_ASSUMED
            w = r["pl_orblper"] if np.isfinite(r["pl_orblper"]) else 90.0
            P, Q = sky_orbit_vectors(r["ra"], r["dec"], incl, node, w)
            # mean anomaly at J2000: from the time of periastron, else of the transit (the planet in
            # front of the star: true anomaly 90 deg - omega_star), else a fixed pseudo-random one
            n = 2 * math.pi / per
            if np.isfinite(r["pl_orbtper"]):
                m0 = n * (J2000 - r["pl_orbtper"])
            elif np.isfinite(r["pl_tranmid"]):
                m0 = mean_from_true(math.radians(90.0 - w), e) + n * (J2000 - r["pl_tranmid"])
            else:
                m0, flags = 2 * math.pi * _hash01(str(r["pl_name"]) + ":phase"), flags | F_PHASE_ASSUMED
            radius = r["pl_rade"]
            if not np.isfinite(radius):
                radius, flags = radius_from_mass(r["pl_bmasse"]), flags | F_RADIUS_EST
            if r["cb_flag"] == 1:
                flags |= F_CIRCUMBINARY
            method = METHODS.index(r["discoverymethod"]) if r["discoverymethod"] in METHODS else -1
            rows.append({
                "host": host, "star": host_of[host], "name": str(r["pl_name"]), "de": None, "a": a, "e": e,
                "period": per, "m0": m0 % (2 * math.pi), "P": P, "Q": Q, "incl": incl,
                "radius": radius, "mass": r["pl_bmasse"], "eqt": r["pl_eqt"], "method": method,
                "year": r["disc_year"], "flags": flags,
            })
    return rows


def solar_rows(sun: int) -> list[dict]:
    rows = []
    for en, de, a, e, i, L, peri, node, per, radius, mass in SOLAR_SYSTEM:
        P, Q = ecliptic_orbit_vectors(i, node, peri)
        rows.append({
            "host": "Sun", "star": sun, "name": en, "de": de if de != en else None, "a": a, "e": e, "period": per,
            "m0": math.radians(L - peri) % (2 * math.pi), "P": P, "Q": Q, "incl": i, "radius": radius,
            "mass": mass, "eqt": float("nan"), "method": METHODS.index("Solar System"), "year": float("nan"),
            "flags": F_SOLAR,
        })
    return rows


def _r(x: float, digits: int) -> float | None:
    return None if x is None or not np.isfinite(x) else float(round(x, digits))


def write(rows: list[dict], stars: pd.DataFrame, out: Path) -> dict:
    hosts: dict[int, dict] = {}
    planets = []
    for r in rows:
        k = r["star"]
        if k not in hosts:
            s = stars.iloc[k]
            hosts[k] = {"i": len(hosts), "path": str(s["path"]), "index": int(s["index"]), "name": r["host"],
                        # exactly the float32 values of the node (the app draws the star there)
                        "pos": [float(s["x"]), float(s["y"]), float(s["z"])], "planets": 0}
        h = hosts[k]
        h["planets"] += 1
        planets.append([
            h["i"], r["name"], r["de"], _r(r["a"], 7), _r(r["e"], 5), _r(r["period"], 6), _r(r["m0"], 6),
            [_r(v, 6) for v in r["P"]], [_r(v, 6) for v in r["Q"]], _r(r["radius"], 3), _r(r["mass"], 3),
            _r(r["eqt"], 0), r["method"], None if not np.isfinite(r["year"]) else int(r["year"]), r["flags"],
            _r(r["incl"], 2),
        ])
    meta = {
        "format": "galmap-planets",
        "version": 1,
        "generated": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "epoch": J2000,
        "frame": "galactic-heliocentric",
        "units": {"a": "AU", "period": "d", "m0": "rad", "radius": "Earth radii", "mass": "Earth masses", "eqt": "K"},
        "fields": ["host", "name", "nameDe", "a", "e", "period", "m0", "P", "Q", "radius", "mass", "eqt", "method", "year", "flags", "incl"],
        "flags": {"radiusEstimated": F_RADIUS_EST, "inclinationAssumed": F_INCL_ASSUMED, "phaseAssumed": F_PHASE_ASSUMED,
                  "eccentricityAssumed": F_ECC_ASSUMED, "solarSystem": F_SOLAR, "circumbinary": F_CIRCUMBINARY},
        "methods": METHODS,
        "hosts": [[h["path"], h["index"], h["name"], h["pos"], h["planets"]] for h in sorted(hosts.values(), key=lambda h: h["i"])],
        "planets": planets,
        "sources": [SOURCE_INFO, {
            "key": "jpl-elements",
            "title": "E. M. Standish, Keplerian Elements for Approximate Positions of the Major Planets (JPL)",
            "url": "https://ssd.jpl.nasa.gov/planets/approx_pos.html",
        }],
        "stats": {"hosts": len(hosts), "planets": len(planets)},
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "planets.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":"), allow_nan=False), "utf-8")
    log.info("planets.json: %d planets around %d stars, %.0f kB", len(planets), len(hosts), (out / "planets.json").stat().st_size / 1e3)
    return meta


def build(data: Path, refresh: bool = False) -> dict:
    data = Path(data)
    stars = read_stars(data)
    stars["index"] = stars.groupby("path", sort=False).cumcount()
    sun = stars.index[(stars["key"] == "Sun") & (stars["x"] == 0) & (stars["y"] == 0) & (stars["z"] == 0)]
    hosts = stars[stars["planets"] > 0].reset_index(drop=True)
    stars_used = pd.concat([hosts, stars.loc[sun]], ignore_index=True)
    rows = []
    try:
        raw = load(refresh)
        rows += exoplanet_rows(raw, match_hosts(raw, hosts), hosts)
    except Exception as err:  # the Solar System alone then
        log.warning("NASA Exoplanet Archive unavailable, the Solar System only: %s", err)
    if len(sun):
        rows += solar_rows(len(hosts))
    return write(rows, stars_used, data)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=Path(__file__).resolve().parents[2] / "public" / "data")
    ap.add_argument("--refresh", action="store_true", help="download the planets again")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    build(args.data, args.refresh)


if __name__ == "__main__":
    main()
