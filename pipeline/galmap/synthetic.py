"""Synthetic test catalogue for developing the web app without downloading real data.

    python -m galmap.synthetic --out ../public/data --stars 300000

The stars are random (plus a handful of well-known stars at approximately correct positions)
and must never be mistaken for real data; the manifest marks the source as synthetic.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from .coords import LY_PER_PC, icrs_to_galactic_xyz
from .flags import Desig, Flag, Rank, spectral_code
from .octree import write_dataset

# name, ra, dec, distance (ly), absmag V, teff, spectral type
KNOWN = [
    ("Proxima Centauri", 217.4289, -62.6795, 4.2465, 15.53, 3042, "M5.5Ve"),
    ("Rigil Kentaurus", 219.9021, -60.8340, 4.344, 4.38, 5790, "G2V"),
    ("Toliman", 219.8961, -60.8375, 4.344, 5.71, 5260, "K1V"),
    ("Barnard's Star", 269.4521, 4.6934, 5.963, 13.21, 3134, "M4.0V"),
    ("Wolf 359", 164.1203, 7.0147, 7.856, 16.55, 2800, "M6.0V"),
    ("Lalande 21185", 165.8341, 35.9699, 8.307, 10.48, 3547, "M2.0V"),
    ("Sirius", 101.2872, -16.7161, 8.611, 1.42, 9940, "A1V"),
    ("Epsilon Eridani", 53.2327, -9.4583, 10.475, 6.19, 5084, "K2V"),
    ("Procyon", 114.8255, 5.2250, 11.46, 2.66, 6530, "F5IV-V"),
    ("61 Cygni A", 316.7248, 38.7494, 11.403, 7.49, 4526, "K5V"),
    ("Tau Ceti", 26.0170, -15.9375, 11.912, 5.69, 5344, "G8V"),
    ("Altair", 297.6958, 8.8683, 16.73, 2.22, 7670, "A7V"),
    ("Vega", 279.2347, 38.7837, 25.04, 0.58, 9602, "A0V"),
    ("Arcturus", 213.9153, 19.1824, 36.7, -0.30, 4286, "K1.5III"),
    ("Capella", 79.1723, 45.9980, 42.9, -0.48, 4970, "G8III"),
    ("Aldebaran", 68.9802, 16.5093, 65.3, -0.64, 3910, "K5III"),
    ("Regulus", 152.0930, 11.9672, 79.3, -0.52, 12460, "B8IVn"),
    ("Polaris", 37.9546, 89.2641, 433.0, -3.6, 6015, "F7Ib"),
    ("Betelgeuse", 88.7929, 7.4071, 548.0, -5.85, 3600, "M1-M2Ia-ab"),
    ("Rigel", 78.6345, -8.2016, 860.0, -7.84, 12100, "B8Ia"),
    ("Deneb", 310.3580, 45.2803, 2600.0, -8.38, 8525, "A2Ia"),
]


def make(n: int, seed: int = 1) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    # faint dwarfs: uniform within 400 ly
    nd = int(n * 0.75)
    r = 400 * rng.random(nd) ** (1 / 3)
    v = rng.normal(size=(nd, 3))
    v /= np.linalg.norm(v, axis=1)[:, None]
    dwarfs = v * r[:, None]
    mag_d = rng.normal(11.5, 2.5, nd).clip(4, 18)
    # luminous stars: disk with scale height ~1000 ly out to 6000 ly
    nl = n - nd
    rr = 6000 * np.sqrt(rng.random(nl))
    phi = rng.random(nl) * 2 * np.pi
    z = rng.laplace(0, 1000, nl)
    lum = np.stack([rr * np.cos(phi), rr * np.sin(phi), z], axis=1)
    mag_l = rng.normal(0.5, 2.0, nl).clip(-8, 4)
    xyz = np.vstack([dwarfs, lum])
    absmag = np.concatenate([mag_d, mag_l])
    teff = np.clip(10 ** (3.76 - (absmag - 4.8) * 0.045 + rng.normal(0, 0.05, n)), 2400, 40000)
    df = pd.DataFrame({"x": xyz[:, 0], "y": xyz[:, 1], "z": xyz[:, 2]})
    df["absmag"] = absmag
    df["logl"] = (4.74 - absmag) / 2.5
    df["teff"] = teff
    df["flags"] = Flag.SRC_GCNS
    df["dist_err"] = np.abs(rng.normal(0, 0.01, n)) + np.linalg.norm(xyz, axis=1) / 1e5
    df["spec_code"] = 255
    df["spect"] = None
    df["desig_cat"] = Desig.GAIA_DR3
    ids = rng.integers(1, 2**62, n, dtype=np.int64)
    df["desig_lo"] = ids & 0xFFFFFFFF
    df["desig_hi"] = ids >> 32
    df["desig_str"] = None
    df["name_rank"] = Rank.NONE
    df["name_en"] = None
    df["name_de"] = None
    df["alt"] = None
    df["system_id"] = -1
    # brown dwarfs and white dwarfs
    bd = rng.random(n) < 0.03
    df.loc[bd, "flags"] |= Flag.BROWN_DWARF
    df.loc[bd, "teff"] = rng.uniform(400, 2200, bd.sum())
    df.loc[bd, "logl"] = rng.uniform(-6, -3.7, bd.sum())
    wd = (~bd) & (rng.random(n) < 0.02)
    df.loc[wd, "flags"] |= Flag.WHITE_DWARF
    df.loc[wd, "teff"] = rng.uniform(5000, 25000, wd.sum())
    df.loc[wd, "logl"] = rng.uniform(-4, -1.5, wd.sum())

    rows = []
    for i, (name, ra, dec, d, mv, t, sp) in enumerate(KNOWN):
        p = icrs_to_galactic_xyz(ra, dec, d)
        rows.append(
            {
                "x": p[0],
                "y": p[1],
                "z": p[2],
                "absmag": mv,
                "logl": (4.74 - mv) / 2.5,
                "teff": t,
                "flags": Flag.SRC_HYG | Flag.NAMED,
                "dist_err": 0.005,
                "spec_code": spectral_code(sp),
                "spect": sp,
                "desig_cat": Desig.STRING,
                "desig_lo": 0,
                "desig_hi": 0,
                "desig_str": f"SYN {i + 1}",
                "name_rank": Rank.IAU,
                "name_en": name,
                "name_de": {"Vega": "Wega", "Betelgeuse": "Beteigeuze", "Procyon": "Prokyon", "Barnard's Star": "Barnards Pfeilstern"}.get(name),
                "alt": [f"SYN {i + 1}"],
                "system_id": -1,
            }
        )
    rows.append(
        {
            "x": 0.0,
            "y": 0.0,
            "z": 0.0,
            "absmag": 4.83,
            "logl": 0.0,
            "teff": 5772,
            "flags": Flag.SUN | Flag.NAMED,
            "dist_err": 0.0,
            "spec_code": spectral_code("G2V"),
            "spect": "G2V",
            "desig_cat": Desig.STRING,
            "desig_lo": 0,
            "desig_hi": 0,
            "desig_str": "Sun",
            "name_rank": Rank.IAU,
            "name_en": "Sun",
            "name_de": "Sonne",
            "alt": None,
            "system_id": -1,
        }
    )
    return pd.concat([df, pd.DataFrame(rows)], ignore_index=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[2] / "public" / "data")
    ap.add_argument("--stars", type=int, default=300_000)
    ap.add_argument("--capacity", type=int, default=4096)
    args = ap.parse_args()
    stars = make(args.stars)
    m = write_dataset(
        stars,
        None,
        args.out,
        sources=[{"key": "synthetic", "title": "SYNTHETIC TEST DATA – not real stars", "rows": len(stars), "used": len(stars)}],
        params={"synthetic": True},
        capacity=args.capacity,
    )
    print(f"wrote {m['starCount']} stars in {m['nodeCount']} nodes, {len(m['packs'])} packs to {args.out}")


if __name__ == "__main__":
    main()
