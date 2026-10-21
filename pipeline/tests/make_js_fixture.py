"""Writes a tiny dataset used by the web app's decoder test (tests/js/format.test.ts).

    cd pipeline && python -m tests.make_js_fixture
"""

from pathlib import Path

import pandas as pd

from galmap.flags import Desig, Flag, Rank
from galmap.octree import write_dataset

OUT = Path(__file__).resolve().parents[2] / "tests" / "js" / "fixtures" / "data"

rows = [
    # x, y, z (galactic ly), absmag, logl, teff, flags, dist_err, spec, desig, name
    dict(x=0.0, y=0.0, z=0.0, absmag=4.83, logl=0.0, teff=5772, flags=Flag.SUN | Flag.NAMED, dist_err=0.0, spec_code=46,
         desig_cat=Desig.STRING, desig_lo=0, desig_hi=0, desig_str="Sun", name_rank=Rank.IAU, name_en="Sun", name_de="Sonne"),
    dict(x=-5.0322, y=-1.8735, z=-1.3418, absmag=1.42, logl=1.40, teff=9940, flags=Flag.SRC_HYG | Flag.NAMED, dist_err=0.004, spec_code=21,
         desig_cat=Desig.HIP, desig_lo=32349, desig_hi=0, desig_str=None, name_rank=Rank.IAU, name_en="Sirius", name_de=None,
         alt=["Alpha Canis Majoris A", "HD 48915"], system_id=7, spect="A1V"),
    dict(x=1.0, y=-3.0, z=0.5, absmag=15.5, logl=-2.8, teff=3042, flags=Flag.SRC_GCNS, dist_err=0.0015, spec_code=65,
         desig_cat=Desig.GAIA_DR3, desig_lo=5853498713190525696 & 0xFFFFFFFF, desig_hi=5853498713190525696 >> 32, desig_str=None,
         name_rank=Rank.NONE, name_en=None, name_de=None, planets=2),
    dict(x=2.0, y=2.0, z=2.0, absmag=float("nan"), logl=-5.2, teff=600, flags=Flag.SRC_CENSUS20 | Flag.BROWN_DWARF, dist_err=float("nan"),
         spec_code=87, desig_cat=Desig.TYC, desig_lo=9007 | (5848 << 16), desig_hi=1, desig_str=None, name_rank=Rank.NONE,
         name_en=None, name_de=None),
]
df = pd.DataFrame(rows)
for c, default in (("alt", None), ("system_id", -1), ("spect", None), ("planets", 0)):
    if c not in df:
        df[c] = default
df["system_id"] = df["system_id"].fillna(-1).astype(int)
df["planets"] = df["planets"].fillna(0).astype(int)
systems = pd.DataFrame([dict(system_id=7, name_en="Sirius", name_de=None, members=2, cx=-5.03, cy=-1.87, cz=-1.34, designation="HIP 32349")])
write_dataset(df, systems, OUT, sources=[{"key": "fixture", "title": "test fixture"}], params={}, capacity=4096)
print("wrote", OUT)
