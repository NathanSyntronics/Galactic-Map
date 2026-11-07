"""The spacecraft leaving the Solar System (docs/PROBES.md): Voyager 1 and 2, Pioneer 10 and 11 and
New Horizons, their trajectories from JPL Horizons, heliocentric, in the galactic frame of the map.

    cd pipeline && python -m galmap.probes --out ../public/data

Horizons gives the state vectors every 10 days from launch to the end of each trajectory file
(2100 for the Voyagers, 2050 for the others); the app continues in a straight line with the last
velocity beyond. Points that linear interpolation in time reproduces to 0.001 AU are left out.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .coords import A_G
from .download import CACHE_DIR, request

log = logging.getLogger(__name__)

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
DIR = CACHE_DIR / "probes"
STEP_DAYS = 10
TOLERANCE_AU = 1e-3

# key, Horizons id, name, launch date (UTC), first date asked for, last
PROBES = [
    ("voyager1", "-31", "Voyager 1", "1977-09-05", "1977-09-07", "2099-12-31"),
    ("voyager2", "-32", "Voyager 2", "1977-08-20", "1977-08-22", "2099-12-31"),
    ("pioneer10", "-23", "Pioneer 10", "1972-03-03", "1972-03-05", "2049-12-31"),
    ("pioneer11", "-24", "Pioneer 11", "1973-04-06", "1973-04-08", "2049-12-31"),
    ("newhorizons", "-98", "New Horizons", "2006-01-19", "2006-01-21", "2049-12-31"),
]

SOURCE_INFO = {
    "key": "horizons",
    "title": "JPL Horizons System (NASA Jet Propulsion Laboratory): spacecraft trajectories",
    "url": "https://ssd.jpl.nasa.gov/horizons/",
}


def _query(pid: str, start: str, stop: str) -> str:
    params = {
        "format": "json", "COMMAND": f"'{pid}'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'VECTORS'", "CENTER": "'500@10'", "START_TIME": f"'{start}'", "STOP_TIME": f"'{stop}'",
        "STEP_SIZE": f"'{STEP_DAYS} d'", "VEC_TABLE": "'2'", "REF_PLANE": "'FRAME'", "OUT_UNITS": "'AU-D'",
        "CSV_FORMAT": "'YES'",
    }
    return request("GET", API, params=params, timeout=300).json().get("result", "")


def fetch(key: str, pid: str, start: str, stop: str, refresh: bool = False) -> str:
    """The Horizons vectors table (ICRF, AU, AU/day), cached; the range is narrowed to what the
    trajectory file covers when Horizons says it ends earlier or begins later."""
    dest = DIR / f"{key}.txt"
    if dest.exists() and not refresh:
        return dest.read_text("utf-8")
    for _ in range(3):
        text = _query(pid, start, stop)
        if "$$SOE" in text:
            DIR.mkdir(parents=True, exist_ok=True)
            dest.write_text(text, "utf-8")
            return text
        after = re.search(r"after A\.D\. (\d{4})-([A-Z]{3})-(\d{2})", text)
        prior = re.search(r"prior to A\.D\. (\d{4})-([A-Z]{3})-(\d{2})", text)
        if after:
            d = datetime.strptime(f"{after.group(1)}-{after.group(2).title()}-{after.group(3)}", "%Y-%b-%d")
            stop = f"{d.year}-{d.month:02d}-{max(d.day - 1, 1):02d}"
        elif prior:
            d = datetime.strptime(f"{prior.group(1)}-{prior.group(2).title()}-{prior.group(3)}", "%Y-%b-%d")
            start = f"{d.year}-{d.month:02d}-{min(d.day + 1, 28):02d}"
        else:
            break
    raise RuntimeError(f"Horizons gave no vectors for {key}: {text[:300]}")


def parse(text: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Julian dates (TDB), positions and velocities (ICRF, AU and AU/day) of a vectors table."""
    body = text[text.index("$$SOE") + 5 : text.index("$$EOE")]
    rows = [r.split(",") for r in body.strip().splitlines() if r.strip()]
    jd = np.array([float(r[0]) for r in rows])
    pos = np.array([[float(v) for v in r[2:5]] for r in rows])
    vel = np.array([[float(v) for v in r[5:8]] for r in rows])
    return jd, pos, vel


def simplify(jd: np.ndarray, pos: np.ndarray, tol: float = TOLERANCE_AU) -> list[int]:
    """The points to keep: from each kept point the farthest one such that interpolating linearly
    in time between the two reproduces every point in between to `tol` (AU)."""
    keep = [0]
    i = 0
    n = len(jd)
    while i < n - 1:
        j = i + 1
        while j + 1 < n:
            k = np.arange(i + 1, j + 2)
            f = ((jd[k] - jd[i]) / (jd[j + 1] - jd[i]))[:, None]
            err = np.linalg.norm(pos[i] + f * (pos[j + 1] - pos[i]) - pos[k], axis=1)
            if err.max() > tol:
                break
            j += 1
        keep.append(j)
        i = j
    return keep


def build(out: Path, refresh: bool = False) -> dict:
    probes = []
    for key, pid, name, launch, start, stop in PROBES:
        jd, pos, vel = parse(fetch(key, pid, start, stop, refresh))
        # the galactic frame of the map (ICRF -> galactic)
        gpos, gvel = pos @ A_G.T, vel @ A_G.T
        keep = simplify(jd, gpos)
        probes.append({
            "key": key,
            "name": name,
            "launch": launch,
            "t": [round(float(jd[k]), 3) for k in keep],
            "p": [[round(float(v), 5) for v in gpos[k]] for k in keep],
            # the velocity at the last point: the straight line beyond (AU / day)
            "v": [round(float(v), 9) for v in gvel[-1]],
        })
        log.info("%s: %d of %d points, %.1f AU on %s", name, len(keep), len(jd), float(np.linalg.norm(gpos[-1])), stop)
    meta = {
        "format": "galmap-probes",
        "version": 1,
        "generated": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "frame": "galactic-heliocentric",
        "units": {"t": "JD (TDB)", "p": "AU", "v": "AU/d"},
        "probes": probes,
        "sources": [SOURCE_INFO],
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "probes.json").write_text(json.dumps(meta, separators=(",", ":"), allow_nan=False), "utf-8")
    log.info("probes.json: %d probes, %.0f kB", len(probes), (out / "probes.json").stat().st_size / 1e3)
    return meta


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[2] / "public" / "data")
    ap.add_argument("--refresh", action="store_true", help="ask Horizons again (ignore the cache)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    build(args.out, args.refresh)


if __name__ == "__main__":
    main()
