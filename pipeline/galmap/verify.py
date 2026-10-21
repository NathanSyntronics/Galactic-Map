"""Sanity checks of a built dataset against well-known stars.

    python -m galmap.verify ../public/data

Reference distances are trigonometric parallaxes from Gaia DR3 / Hipparcos 2007 / the 20 pc
census; tolerances are generous enough to allow for catalogue differences but catch real
errors (wrong cross-matches, unit mistakes, wrong frame).
"""

from __future__ import annotations

import json
import re
import struct
import sys
from pathlib import Path

import numpy as np

from .coords import galactic_lb
from .flags import Flag

# name -> (distance in ly, tolerance as fraction, expected flags or 0)
REFERENCE = {
    "Proxima Centauri": (4.2465, 0.01, 0),
    "Alpha Centauri A": (4.344, 0.015, 0),
    "Alpha Centauri B": (4.344, 0.015, 0),
    "Barnard's Star": (5.963, 0.01, 0),
    "Wolf 359": (7.856, 0.01, 0),
    "Lalande 21185": (8.304, 0.01, 0),
    # Hipparcos 379.21 mas (8.60 ly), HST 376.68 (8.66 ly, Bond+2017), Gaia DR3 of Sirius B 374.49 (8.71 ly,
    # adopted for the system by the 20 pc census)
    "Sirius": (8.66, 0.01, 0),
    "Epsilon Eridani": (10.475, 0.01, 0),
    "Procyon": (11.46, 0.015, 0),
    "61 Cygni A": (11.40, 0.01, 0),
    "Tau Ceti": (11.91, 0.01, 0),
    "Altair": (16.73, 0.02, 0),
    "Vega": (25.04, 0.02, 0),
    "Arcturus": (36.7, 0.03, 0),
}
# names that must be displayed (English, German or None for "same as English") ...
DISPLAYED = {
    "Gliese 229 B": None,
    "Gliese 887": "Lacaille 9352",
    "Barnard's Star": "Barnards Pfeilstern",
    "40 Eridani A": "Keid A",  # the German article is titled "Keid"
    "Gliese 436": None,
    "f Eridani A": None,
    "Nu¹ Columbae": "Ny¹ Columbae",
    "Van Biesbroeck 8": None,
    "AK Leporis": None,
    "Capella H": None,
    "Zeta Herculis B": None,
    "Castor Ab": None,
    "Beta Aquilae Ba": "Alschain Ba",
}
# ... and names that must not be (survey numbers promoted to names, raw SIMBAD codes, nebulae,
# Wikipedia's capitalised Latin Bayer letters, the IAU name of a primary on its companion)
NOT_DISPLAYED = ("Luyten 668-21 A", "Eskimo Nebula", "Prawn Nebula", "F Eridani", "B1 Hydrae", "Tianji B", "Guniibuu B", "Capella A")
RAW_PREFIXES = ("Cl* ", "Cl ", "GR* ", "EM* ", "SV* ", "HIDDEN NAME", "NAME ", "* ", "V* ", "** ")
# stars that must exist (by any name in the search index), optionally with flags
MUST_EXIST = {
    "Luhman 16": Flag.BROWN_DWARF,
    "WISE 0855": Flag.BROWN_DWARF,
    "Sirius B": Flag.WHITE_DWARF,
    "Teegarden's Star": 0,
}
# known planet hosts -> minimum number of planets (NASA Exoplanet Archive)
PLANETS = {"Proxima Centauri": 2, "51 Pegasi": 1, "TRAPPIST-1": 7, "Epsilon Eridani": 1}


def _read_node(out: Path, manifest: dict, path: str) -> dict:
    entry = next(e for e in manifest["nodes"] if e[0] == path)
    _, count, nbytes, _mask, pack, offset = entry
    with open(out / manifest["packs"][pack], "rb") as fh:
        fh.seek(offset)
        blob = fh.read(nbytes)
    offs = struct.unpack_from("<" + "I" * 11, blob, 12)
    pos = np.frombuffer(blob, "<f4", count * 3, offs[0]).reshape(count, 3).astype(float)
    flags = np.frombuffer(blob, "<u2", count, offs[4])
    extra = json.loads(blob[offs[9]:offs[9] + offs[10]].decode("utf-8")) if offs[10] else {}
    return {"pos": pos, "flags": flags, "extra": extra}


def _norm(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum())


def verify(out: Path) -> list[str]:
    out = Path(out)
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    search = json.loads((out / "search.json").read_text("utf-8"))
    by_name: dict[str, list] = {}
    for e in search:
        for n in [e[0], e[1]] + ((e[8] or []) if len(e) > 8 else []):
            if n:
                by_name.setdefault(_norm(n), []).append(e)
    problems = []
    for name, (ref, tol, _flags) in REFERENCE.items():
        hits = by_name.get(_norm(name)) or by_name.get(_norm(f"{name} A"))
        if not hits:
            problems.append(f"{name}: not found")
            continue
        e = hits[0]
        # the primary of a system whose companion is shown as "<name> B" is labelled "<name> A"
        if e[0] not in (name, f"{name} A"):
            problems.append(f"{name}: displayed as '{e[0]}'")
        node = _read_node(out, manifest, e[2])
        p = node["pos"][e[3]]
        d = float(np.linalg.norm(p))
        if abs(d - ref) > tol * ref:
            problems.append(f"{name}: distance {d:.3f} ly, expected {ref} ly")
        if not np.allclose(p, e[4:7], atol=2e-3):
            problems.append(f"{name}: search index position {e[4:7]} differs from node position {p}")
    # official IAU names stay searchable when another name is displayed
    for name in ("Rigil Kentaurus", "Toliman", "Ran", "Alsafi"):
        if not by_name.get(_norm(name)):
            problems.append(f"{name}: not searchable")
    sirius = by_name.get(_norm("Sirius")) or by_name.get(_norm("Sirius A"))
    if sirius:
        l, b = galactic_lb(np.array(sirius[0][4:7]))
        if abs(l - 227.23) > 0.05 or abs(b + 8.89) > 0.05:
            problems.append(f"Sirius: galactic l/b = {l:.2f}/{b:.2f}, expected 227.23/-8.89")
    for name, flag in MUST_EXIST.items():
        hits = by_name.get(_norm(name))
        if not hits:
            # also accept component names like "Luhman 16 A"
            hits = [v[0] for k, v in by_name.items() if k.startswith(_norm(name))]
            hits = [hits[0]] if hits else None
        if not hits:
            problems.append(f"{name}: not found")
            continue
        if flag:
            e = hits[0]
            node = _read_node(out, manifest, e[2])
            if not node["flags"][e[3]] & flag:
                problems.append(f"{name}: expected flag {flag}")
    problems += check_names(search)
    problems += check_designations(search)
    for name, n in PLANETS.items():
        hits = by_name.get(_norm(name)) or by_name.get(_norm(f"{name} A"))
        if not hits:
            problems.append(f"{name}: not found")
            continue
        e = hits[0]
        got = _read_node(out, manifest, e[2])["extra"].get("p", {}).get(str(e[3]), 0)
        if got < n:
            problems.append(f"{name}: {got} known planets, expected at least {n}")
    # the Sun is in the root node at the origin
    root = _read_node(out, manifest, "r")
    sun = np.nonzero(root["flags"] & Flag.SUN)[0]
    if len(sun) != 1 or np.abs(root["pos"][sun[0]]).max() > 1e-6:
        problems.append("Sun: not at the origin of the root node")
    return problems


def check_designations(search: list) -> list[str]:
    """The primary designation identifies a star (user data is stored under it): unique, never empty."""
    seen: dict[str, str] = {}
    problems = []
    for e in search:
        d = e[9] if len(e) > 9 else None
        if not d:
            problems.append(f"{e[0]}: no primary designation")
        elif d in seen:
            problems.append(f"{e[0]}: primary designation '{d}' also used by {seen[d]}")
        else:
            seen[d] = e[0]
    return problems[:20]


def check_names(search: list) -> list[str]:
    """Display names: the expected names of a few stars, no raw catalogue codes, no name shown
    for two stars that are close together (the components of a pair) and no component shown with
    the letter of its parent pair."""
    problems = []
    shown = {e[0]: e for e in search}
    for name, de in DISPLAYED.items():
        e = shown.get(name)
        if e is None:
            problems.append(f"{name}: not displayed")
        elif (e[1] or None) != de:
            problems.append(f"{name}: German name {e[1]!r}, expected {de!r}")
    for name in NOT_DISPLAYED:
        if name in shown:
            problems.append(f"{name}: displayed")
    raw = [e[0] for e in search if e[0].startswith(RAW_PREFIXES) or "(" in e[0] or "[" in e[0]]
    if raw:
        problems.append(f"{len(raw)} raw catalogue strings displayed, e.g. {raw[:5]}")
    by_name: dict[str, list] = {}
    for e in search:
        by_name.setdefault(e[0], []).append(np.array(e[4:7], float))
    close = [n for n, ps in by_name.items() if len(ps) > 1 and min(
        float(np.linalg.norm(a - b)) for k, a in enumerate(ps) for b in ps[k + 1:]
    ) < 1.0]
    if close:
        problems.append(f"{len(close)} names displayed for two stars less than 1 ly apart, e.g. {close[:5]}")
    nested = nested_letters(search)
    if nested:
        problems.append(f"{len(nested)} components shown with the letter of their parent pair, e.g. {nested[:5]}")
    return problems


def nested_letters(search: list) -> list[str]:
    """Names 'X A' next to (less than 1 ly from) 'X Aa' / 'X Ab': a component shown under the letter
    of the pair it belongs to ("Castor A" for Castor Ab)."""
    lettered: dict[str, list] = {}
    for e in search:
        m = re.fullmatch(r"(.+) ([A-H])([a-e]{0,2})", e[0])
        if m:
            lettered.setdefault(m.group(1), []).append((m.group(2), m.group(3), np.array(e[4:7], float), e[0]))
    out = []
    for lst in lettered.values():
        for up, low, p, name in lst:
            if not low and any(u == up and lo and float(np.linalg.norm(q - p)) < 1.0 for u, lo, q, _ in lst):
                out.append(name)
    return out


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "public" / "data"
    problems = verify(out)
    for p in problems:
        print("PROBLEM:", p)
    print("verify: OK" if not problems else f"verify: {len(problems)} problem(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
