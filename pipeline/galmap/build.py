"""Build the star data for the web app.

    cd pipeline && python -m galmap.build --out ../public/data

Steps: download catalogues -> merge -> positions -> physics -> systems -> names -> octree.
"""

from __future__ import annotations

import argparse
import gc
import logging
import time
from pathlib import Path

import numpy as np
import pandas as pd

from . import derive, merge, naming, systems
from .download import CACHE_DIR, fetch
from .flags import Desig, Flag, Rank
from .octree import write_dataset
from .photometry import MAMAJEK_URL, Photometry, load_mamajek
from .sources import athyg, census20, gaia, gcns, hyg, iau, simbad, wikidata

log = logging.getLogger("galmap.build")

MAMAJEK_FILE = CACHE_DIR / "mamajek" / "EEM_dwarf_UBVIJHK_colors_Teff.txt"
MAMAJEK_INFO = {
    "key": "mamajek",
    "title": "A Modern Mean Dwarf Stellar Color and Effective Temperature Sequence",
    "citation": "Pecaut M. J. & Mamajek E. E. 2013, ApJS 208, 9; E. Mamajek, table version 2022.04.16 "
    "(used for colour-temperature and bolometric corrections).",
    "url": MAMAJEK_URL,
}
GAIA_INFO = {
    "key": "gaia",
    "title": "Gaia Data Release 3",
    "citation": "Gaia Collaboration, Vallenari A. et al. 2023, A&A 674, A1. This work has made use of data from the "
    "European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data "
    "Processing and Analysis Consortium (DPAC). Parallax zero point: Lindegren et al. 2021, A&A 649, A4.",
    "url": "https://www.cosmos.esa.int/web/gaia/dr3",
    "license": "CC BY-SA 3.0 IGO",
}

HIPPARCOS_INFO = {
    "key": "hipparcos",
    "title": "Hipparcos, the New Reduction of the Raw Data",
    "citation": "van Leeuwen F. 2007, A&A 474, 653 (parallaxes of bright stars whose Gaia DR3 solution is poor).",
    "url": "https://doi.org/10.1051/0004-6361:20078357",
}


def sun_row() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "src": 0,
                "ra": 0.0,
                "dec": 0.0,
                "epoch": 2016.0,
                "plx": np.inf,
                "plx_err": 0.0,
                "plx_src": "sun",
                "pmra": 0.0,
                "pmdec": 0.0,
                "vmag": -26.74,
                "spect": "G2V",
                "teff_cat": 5772.0,
                "is_sun": True,
                "census_name": "Sun",
            }
        ]
    )


def external_names(s: pd.DataFrame, iau_names: pd.DataFrame) -> dict[int, dict]:
    ext: dict[int, dict] = {}
    by_hip = dict(zip(iau_names["hip"].dropna().astype(int), iau_names.loc[iau_names["hip"].notna(), "name"]))
    hip = s["hip"].to_numpy(dtype=object)
    for i, h in enumerate(hip):
        if pd.notna(h) and int(h) in by_hip:
            ext.setdefault(i, {})["iau"] = by_hip[int(h)]
    # IAU names of stars without HIP number: match the WGSN designation against HR / HD / GJ
    no_hip = iau_names[iau_names["hip"].isna()]
    hr = pd.Series(np.arange(len(s)), index=s["hr"].astype("Int64")).loc[lambda x: x.index.notna()]
    hd = pd.Series(np.arange(len(s)), index=s["hd"].astype("Int64")).loc[lambda x: x.index.notna()]
    gj_key = s["gj"].fillna(s.get("census_gj")).astype(object)
    gj = pd.Series(np.arange(len(s)), index=gj_key.where(gj_key.notna(), None)).loc[lambda x: x.index.notna()]
    found = 0
    for name, d in zip(no_hip["name"], no_hip["designation"]):
        d = str(d).strip()
        idx = None
        for prefix, table in (("HR ", hr), ("HD ", hd)):
            if d.startswith(prefix) and d[len(prefix):].strip().isdigit():
                k = int(d[len(prefix):])
                if k in table.index:
                    idx = table.loc[k]
        if d.startswith("GJ ") and d in gj.index:
            idx = gj.loc[d]
        if idx is not None:
            if isinstance(idx, pd.Series):
                idx = idx.iloc[0]
            ext.setdefault(int(idx), {})["iau"] = name
            found += 1
    log.info("IAU names attached: %d by HIP, %d by designation", sum(1 for v in ext.values() if "iau" in v) - found, found)
    return ext


def _write_debug_table(s: pd.DataFrame) -> None:
    """Nearby stars with their merged attributes, for inspection (pipeline/build/stars_100pc.parquet)."""
    cols = [c for c in (
        "x", "y", "z", "dist_pc", "dist_err", "plx", "plx_err", "plx_src", "ra", "dec", "epoch", "gaia", "hip", "hd",
        "tyc", "gj", "census_name", "common_name", "proper", "simbad_main_id", "simbad_otype", "spect", "teff", "absmag",
        "logl", "flags", "system_id", "name_rank", "name_en", "name_de", "desig_cat", "desig_str",
    ) if c in s]
    d = s.loc[s["dist_pc"] < 100, cols].copy()
    for c in d.columns:
        if d[c].dtype == object:
            d[c] = d[c].astype(str)
    out = Path(__file__).resolve().parents[1] / "build"
    out.mkdir(exist_ok=True)
    d.to_parquet(out / "stars_100pc.parquet", index=False)


def build(out: Path, refresh: bool = False, capacity: int = 4096, limit: int | None = None, use_simbad: bool = True) -> dict:
    t0 = time.time()
    phot = Photometry(load_mamajek(fetch(MAMAJEK_URL, MAMAJEK_FILE, refresh=refresh)))

    a = athyg.load(refresh)
    if limit:
        a = a.sample(n=min(limit, len(a)), random_state=1).sort_index()
    g = gaia.load(refresh, extra_ids=a["gaia"].dropna().astype("int64").to_numpy())
    a = merge.link_gaia(a, g)
    s = merge.athyg_rows(a, hyg.load(refresh), gaia.load_hipparcos(refresh))
    s = s[~s["is_sun"].astype(bool)]
    s = merge.merge_gcns(s, gcns.load(refresh), g)
    del a, g  # the full AT-HYG and Gaia tables are no longer needed (memory)
    gc.collect()
    s = merge.dedupe_against_gaia(s)
    s = merge.merge_census(s, census20.load(refresh))
    s = pd.concat([s, sun_row()], ignore_index=True)
    s["is_sun"] = s["is_sun"].fillna(False).astype(bool)
    s["src"] = s["src"].fillna(0).astype(np.int64)
    for c in ("brown_dwarf", "white_dwarf"):
        s[c] = s[c].fillna(False).astype(bool)
    s = derive.positions(s)

    # SIMBAD: identifiers, object types and spectral types for everything within ~100 pc
    sb_idents: dict[int, list[str]] = {}
    try:
        if not use_simbad:
            raise RuntimeError("disabled with --no-simbad")
        basic, ident = simbad.load(refresh)
        sb_idents, sb_info = simbad.attach(s, basic, ident)
        s = pd.concat([s, sb_info], axis=1)
        no_spt = s["spect"].isna() & s["simbad_sp_type"].notna()
        s.loc[no_spt, "spect"] = s.loc[no_spt, "simbad_sp_type"]
        otype = s["simbad_otype"].astype(object)
        s["brown_dwarf"] = s["brown_dwarf"] | otype.isin(["BD*"]).to_numpy()
        s["white_dwarf"] = s["white_dwarf"] | otype.isin(["WD*"]).to_numpy()
        log.info("SIMBAD: spectral types added to %d stars", int(no_spt.sum()))
    except Exception as err:  # names are a bonus; the map works without SIMBAD
        log.warning("SIMBAD unavailable, continuing without it: %s", err)
        s["simbad_main_id"] = None

    s = derive.physics(s, phot)
    s = systems.assign_systems(s)
    derive.place(s, systems.common_distances(s))
    ext = external_names(s, iau.load(refresh))
    for i, lst in sb_idents.items():
        ext.setdefault(i, {})["simbad"] = lst
    # Wikipedia article titles (via Wikidata) decide which of several names is the common one
    try:
        for i, v in wikidata.attach(s, wikidata.load(refresh)).items():
            ext.setdefault(i, {}).update({k: x for k, x in v.items() if x})
    except Exception as err:
        log.warning("Wikidata unavailable, continuing without it: %s", err)
    s = naming.assign_names(s, ext)
    sun = s["is_sun"].to_numpy()
    s.loc[sun, ["name_rank", "name_en", "name_de", "desig_cat", "desig_str"]] = [Rank.IAU, "Sun", "Sonne", Desig.STRING, "Sun"]
    s.loc[sun, ["x", "y", "z", "dist_err"]] = 0.0
    sys_table = systems.system_table(s)
    _write_debug_table(s)

    stats = {
        "stars": int(len(s)),
        "named": int((s["name_rank"] <= Rank.NAMED_MAX).sum()),
        "brownDwarfs": int(((s["flags"] & Flag.BROWN_DWARF) != 0).sum()),
        "whiteDwarfs": int(((s["flags"] & Flag.WHITE_DWARF) != 0).sum()),
        "systems": int(len(sys_table)),
        "within20pc": int((s["dist_pc"] < 20).sum()),
        "within100pc": int((s["dist_pc"] < 100).sum()),
    }
    sources = []
    for info, flag in (
        (census20.SOURCE_INFO, Flag.SRC_CENSUS20),
        (gcns.SOURCE_INFO, Flag.SRC_GCNS),
        (athyg.SOURCE_INFO, Flag.SRC_ATHYG),
        (hyg.SOURCE_INFO, None),
        (GAIA_INFO, None),
        (HIPPARCOS_INFO, None),
        (iau.SOURCE_INFO, None),
        (simbad.SOURCE_INFO, None),
        (wikidata.SOURCE_INFO, None),
        (MAMAJEK_INFO, None),
    ):
        entry = dict(info)
        if flag is not None:
            entry["used"] = int(((s["flags"] & flag) != 0).sum())
        sources.append(entry)
    params = {
        "maxDistancePc": derive.MAX_DIST_PC,
        "maxRelativeDistanceError": derive.MAX_REL_ERR,
        "censusLimitPc": merge.CENSUS_LIMIT_PC,
        "wideBinaryMaxSepAu": systems.MAX_SEP_AU,
    }
    manifest = write_dataset(s, sys_table, out, sources=sources, params=params, stats=stats, capacity=capacity)
    log.info("done in %.0f s: %s", time.time() - t0, stats)
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[2] / "public" / "data")
    ap.add_argument("--refresh", action="store_true", help="download all catalogues again")
    ap.add_argument("--capacity", type=int, default=4096, help="stars per octree node")
    ap.add_argument("--limit", type=int, default=None, help="use only a random sample of AT-HYG (for testing)")
    ap.add_argument("--no-simbad", action="store_true", help="skip the SIMBAD name lookup")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    build(args.out, refresh=args.refresh, capacity=args.capacity, limit=args.limit, use_simbad=not args.no_simbad)


if __name__ == "__main__":
    main()
