"""Close binaries: components that the catalogues place at one position, separated by their orbits.

The 20 pc census lists the components of some systems at one common position (Alpha Centauri A
and B at the system's), so no zoom could separate them. Where the Sixth Catalog of Orbits of Visual
Binary Stars (ORB6, Hartkopf, Mason & Worley, USNO / Georgia State University) has the pair's
orbit, the secondary is placed where the orbit puts it relative to the primary at the map's epoch
(J2016.0, Gaia DR3): on the sky from the visual orbit, along the line of sight from its
inclination (the sign of that offset is not known from a visual orbit; the one of the formulas).
"""

from __future__ import annotations

import logging
import math
import re

import numpy as np
import pandas as pd

from .coords import A_G, LY_PER_PC
from .download import CACHE_DIR, session

log = logging.getLogger(__name__)

URL = "http://www.astro.gsu.edu/wds/orb6/orb6orbits.txt"
FILE = CACHE_DIR / "orb6" / "orb6orbits.txt"
EPOCH = 2016.0
AU_PER_LY = 63241.077

SOURCE_INFO = {
    "key": "orb6",
    "title": "Sixth Catalog of Orbits of Visual Binary Stars (Hartkopf, Mason & Worley; USNO / GSU)",
    "url": "http://www.astro.gsu.edu/wds/orb6.html",
}


def _f(line: str, a: int, b: int) -> float:
    try:
        return float(line[a - 1 : b].strip().rstrip("*q"))
    except ValueError:
        return float("nan")


def parse(text: str) -> pd.DataFrame:
    """The orbits of ORB6 (fixed columns, see orb6format.txt): units converted to years and arcsec."""
    rows = []
    for line in text.splitlines():
        if len(line) < 215 or not re.match(r"^\d{6}", line):
            continue
        p, pu = _f(line, 81, 92), line[92:93]
        a, au = _f(line, 106, 114), line[114:115]
        t0, tu = _f(line, 163, 174), line[174:175]
        p_years = {"y": p, "d": p / 365.25, "c": p * 100}.get(pu, float("nan"))
        a_arcsec = {"a": a, "m": a / 1000, "M": a * 60, "u": a / 1e6}.get(au, float("nan"))
        if tu == "y":
            t_years = t0
        elif tu == "c":
            t_years = t0 * 100
        elif tu == "d":
            t_years = 2000.0 + (t0 + 2400000.0 - 2451545.0) / 365.25
        elif tu == "m":
            t_years = 2000.0 + (t0 + 2400000.5 - 2451545.0) / 365.25
        else:
            t_years = float("nan")
        disc = line[30:44]
        m = re.search(r"([A-Z][a-z]?(?:,[A-Z][a-z]?)?|[A-Z][a-z]?[A-Z][a-z]?)\s*$", disc.strip())
        rows.append(
            {
                "wds": line[19:29].strip(),
                "disc": disc.strip(),
                # without component letters a designation names the pair AB
                "pair": m.group(1) if m else ("AB" if re.search(r"\d$", disc.strip()) else ""),
                "hd": int(line[51:57]) if line[51:57].strip().isdigit() else None,
                "hip": int(line[58:64]) if line[58:64].strip().isdigit() else None,
                "P": p_years,
                "a": a_arcsec,
                "i": _f(line, 126, 133),
                "node": _f(line, 144, 151),
                "T": t_years,
                "e": _f(line, 188, 195),
                "omega": _f(line, 206, 213),
                "grade": int(line[233:234]) if line[233:234].isdigit() else 9,
            }
        )
    df = pd.DataFrame(rows)
    ok = df[["P", "a", "i", "node", "T", "e", "omega"]].notna().all(axis=1) & (df["P"] > 0) & (df["a"] > 0)
    return df[ok].reset_index(drop=True)


def load(refresh: bool = False) -> pd.DataFrame:
    if FILE.exists() and not refresh:
        text = FILE.read_text("utf-8", errors="replace")
    else:
        r = session().get(URL, timeout=300)
        r.raise_for_status()
        text = r.text
        FILE.parent.mkdir(parents=True, exist_ok=True)
        FILE.write_text(text, "utf-8")
    orbits = parse(text)
    log.info("ORB6: %d orbits", len(orbits))
    return orbits


def split_pair(pair: str) -> tuple[str, str] | None:
    """'AB' -> (A, B); 'Aa,Ab' -> (Aa, Ab); 'BC' -> (B, C)."""
    if "," in pair:
        a, b = pair.split(",", 1)
        return (a, b) if a and b else None
    m = re.fullmatch(r"([A-Z][a-z]?)([A-Z][a-z]?)", pair)
    return (m.group(1), m.group(2)) if m else None


def relative_position(orbit, epoch: float = EPOCH) -> np.ndarray:
    """The secondary's position relative to the primary (arcsec) at an epoch: north, east and along
    the line of sight (away from us), Thiele-Innes form of the visual orbit."""
    n = 2 * math.pi / orbit["P"]
    m = n * (epoch - orbit["T"])
    e = orbit["e"]
    E = m if e < 0.8 else math.pi
    for _ in range(50):
        d = (E - e * math.sin(E) - m) / (1 - e * math.cos(E))
        E -= d
        if abs(d) < 1e-12:
            break
    f = 2 * math.atan2(math.sqrt(1 + e) * math.sin(E / 2), math.sqrt(1 - e) * math.cos(E / 2))
    r = orbit["a"] * (1 - e * math.cos(E))
    i, N, w = math.radians(orbit["i"]), math.radians(orbit["node"]), math.radians(orbit["omega"])
    u = w + f
    return r * np.array([
        math.cos(N) * math.cos(u) - math.sin(N) * math.sin(u) * math.cos(i),
        math.sin(N) * math.cos(u) + math.cos(N) * math.sin(u) * math.cos(i),
        math.sin(u) * math.sin(i),
    ])


def offset_ly(orbit, ra: float, dec: float, dist_pc: float, epoch: float = EPOCH) -> np.ndarray:
    """The secondary's offset from the primary in light years, galactic frame."""
    north_e, east_e, away_e = relative_position(orbit, epoch)
    a, d = math.radians(ra), math.radians(dec)
    away = np.array([math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)])
    north = np.array([-math.sin(d) * math.cos(a), -math.sin(d) * math.sin(a), math.cos(d)])
    east = np.array([-math.sin(a), math.cos(a), 0.0])
    v_arcsec = north_e * north + east_e * east + away_e * away
    return (A_G @ v_arcsec) * dist_pc / AU_PER_LY  # 1" at 1 pc = 1 AU


def _letter(name) -> str | None:
    if not isinstance(name, str):
        return None
    m = re.search(r"\s([A-Z][a-z]?)$", name.strip())
    return m.group(1) if m else None


def separate(s: pd.DataFrame, orbits: pd.DataFrame, epoch: float = EPOCH) -> int:
    """Moves the secondaries of the pairs that share one position (and have an ORB6 orbit) to where
    their orbits put them relative to their primaries. Returns the number of stars moved."""
    xyz = s[["x", "y", "z"]].to_numpy(float)
    sun = s["is_sun"].to_numpy(bool) if "is_sun" in s else np.zeros(len(s), bool)
    key = pd.Series(list(map(tuple, xyz.round(9))))
    shared = key.duplicated(keep=False).to_numpy() & ~sun
    if not shared.any():
        return 0
    by_hip: dict[int, list[int]] = {}
    by_hd: dict[int, list[int]] = {}
    for k, o in orbits.sort_values("grade", kind="stable").iterrows():
        if pd.notna(o["hip"]) and o["hip"]:
            by_hip.setdefault(int(o["hip"]), []).append(k)
        if pd.notna(o["hd"]) and o["hd"]:
            by_hd.setdefault(int(o["hd"]), []).append(k)
    names = s["census_name"] if "census_name" in s else pd.Series([None] * len(s))
    disp = s["name_en"] if "name_en" in s else pd.Series([None] * len(s))
    hip = s["hip"] if "hip" in s else pd.Series([pd.NA] * len(s))
    hd = s["hd"] if "hd" in s else pd.Series([pd.NA] * len(s))
    moved = 0
    groups = pd.Series(np.nonzero(shared)[0]).groupby(key[shared].to_numpy()).apply(list)
    new_xyz = xyz.copy()
    for members in groups:
        letters = {}
        for j in members:
            c = _letter(names.iat[j]) or _letter(disp.iat[j])
            if c and c not in letters:
                letters[c] = j
        cand: list[int] = []
        for j in members:
            for col, table in ((hip, by_hip), (hd, by_hd)):
                v = col.iat[j]
                if pd.notna(v) and int(v) in table:
                    cand += [k for k in table[int(v)] if k not in cand]
        placed: set[int] = set()
        for k in cand:
            o = orbits.loc[k]
            pr = split_pair(o["pair"])
            if not pr or pr[0] not in letters or pr[1] not in letters:
                continue
            p, q = letters[pr[0]], letters[pr[1]]
            if q in placed or p == q:
                continue
            ra, dec, dist = float(s.at[p, "ra"]), float(s.at[p, "dec"]), float(s.at[p, "dist_pc"])
            new_xyz[q] = new_xyz[p] + offset_ly(o, ra, dec, dist, epoch)
            placed.add(q)
            moved += 1
    s["x"], s["y"], s["z"] = new_xyz[:, 0], new_xyz[:, 1], new_xyz[:, 2]
    log.info("binaries: %d components separated from their primaries by their ORB6 orbits (%d groups shared a position)", moved, len(groups))
    return moved
