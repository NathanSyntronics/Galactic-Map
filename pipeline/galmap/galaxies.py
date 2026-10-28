"""Galaxies with redshift-independent distances for the web app (docs/GALAXIES.md).

    cd pipeline && python -m galmap.galaxies --out ../public/data

Three catalogues, matched by position:

* the Local Volume Database (Pace 2025): the dwarf galaxies of the Local Group and the Local
  Volume (satellites of the Milky Way and of Andromeda, field dwarfs to about 10 Mpc);
* the Updated Nearby Galaxy Catalog (Karachentsev, Makarov & Kaisina 2013): 869 galaxies within
  about 11 Mpc (36 million ly); those whose distance comes only from their velocity (Hubble flow)
  are left out;
* Cosmicflows-4 (Tully et al. 2023): 55,877 galaxies with distances from Tully-Fisher, the
  fundamental plane, surface brightness fluctuations, supernovae, Cepheids, the tip of the red
  giant branch and masers.

Sizes, axis ratios and position angles come from these catalogues and from the 2MASS Extended
Source Catalog; names (English and German) and catalogue numbers from Wikidata. Output:
galaxies.bin (fixed 36-byte records) and galaxies.json (names, sources, record layout).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import math
import re
import struct
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from .coords import A_G, LY_PER_PC, unit_vectors
from .download import CACHE_DIR, fetch, session, tap_sync

log = logging.getLogger("galmap.galaxies")

CACHE = CACHE_DIR / "galaxies"
CF4_URL = "https://content.cld.iop.org/journals/0004-637X/944/1/94/revision1/apjac94d8t2_mrt.txt"
UNGC_URL = "https://content.cld.iop.org/journals/1538-3881/145/4/101/revision1/aj459654t{n}_mrt.txt"
LVDB_URL = "https://github.com/apace7/local_volume_database/releases/download/v1.1.1/comb_all.csv"
IRSA_TAP = "https://irsa.ipac.caltech.edu/TAP"
WIKIDATA = "https://query.wikidata.org/sparql"

SOURCES = [
    {
        "key": "lvdb",
        "title": "Local Volume Database",
        "citation": "Pace A. B. 2025, The Open Journal of Astrophysics 8, 142 (release v1.1.1)",
        "url": "https://github.com/apace7/local_volume_database",
    },
    {
        "key": "ungc",
        "title": "Updated Nearby Galaxy Catalog",
        "citation": "Karachentsev I. D., Makarov D. I. & Kaisina E. I. 2013, AJ 145, 101",
        "url": "https://doi.org/10.1088/0004-6256/145/4/101",
    },
    {
        "key": "cf4",
        "title": "Cosmicflows-4",
        "citation": "Tully R. B. et al. 2023, ApJ 944, 94",
        "url": "https://doi.org/10.3847/1538-4357/ac94d8",
    },
    {
        "key": "2mass_xsc",
        "title": "2MASS Extended Source Catalog",
        "citation": "Jarrett T. H. et al. 2000, AJ 119, 2498 (sizes, axis ratios and position angles)",
        "url": "https://irsa.ipac.caltech.edu/Missions/2mass.html",
    },
    {
        "key": "wikidata",
        "title": "Wikidata",
        "citation": "Names and catalogue numbers of galaxies (CC0)",
        "url": "https://www.wikidata.org/",
        "license": "CC0",
    },
]

# record layout of galaxies.bin (little-endian), see docs/GALAXIES.md
RECORD = struct.Struct("<4f3b3bBBhBBBBHI")
assert RECORD.size == 36

# morphological classes
SPIRAL, LENTICULAR, ELLIPTICAL, IRREGULAR, SPHEROIDAL, MILKY_WAY = range(6)
CLASSES = ["spiral", "lenticular", "elliptical", "irregular", "spheroidal", "milkyway"]
# distance methods (index = code in the records)
METHODS = ["", "TRGB", "Cep", "maser", "SBF", "SNIa", "SNII", "FP", "TF", "RR", "HB", "CMD", "BS", "PNLF", "mem", "txt", "geom", "model", "other"]
# flags
F_LVDB, F_UNGC, F_CF4, F_LOCAL_GROUP, F_NAMED, F_MODEL = 1, 2, 4, 8, 16, 32

#: intrinsic thickness of a disk (axis ratio seen edge-on)
Q0 = 0.2
#: the Galactic Centre (Sgr A*: l = 359.944°, b = -0.046°, 8.178 kpc, GRAVITY 2019), ly
GC_DIST_LY = 8178 * LY_PER_PC
#: radius around the Local Group's barycentre within which a galaxy counts as a member (1.5 Mpc)
LG_RADIUS_LY = 1.5e6 * LY_PER_PC


# ------------------------------------------------------------------ catalogue files


def read_mrt(path: Path) -> pd.DataFrame:
    """A machine-readable table (CDS / AAS byte-by-byte format) as strings, blanks as NaN."""
    lines = Path(path).read_text("utf-8", errors="replace").splitlines()
    spec = re.compile(r"^\s*(\d+)(?:\s*-\s*(\d+))?\s+([AIEF][\d.]+)\s+\S+\s+(\S+)")
    cols, names = [], []
    in_desc = False
    for line in lines:
        if line.startswith("Byte-by-byte"):
            in_desc = True
            continue
        if in_desc:
            if line.startswith("Note") or line.startswith("===="):
                if cols:
                    break
            m = spec.match(line)
            if m:
                a = int(m.group(1))
                b = int(m.group(2) or m.group(1))
                cols.append((a - 1, b))
                names.append(m.group(4))
    if not cols:
        raise ValueError(f"{path}: no byte-by-byte description")
    dashes = [i for i, line in enumerate(lines) if re.fullmatch(r"-{20,}\s*", line)]
    body = "\n".join(line for line in lines[dashes[-1] + 1 :] if line.strip())
    df = pd.read_fwf(io.StringIO(body), colspecs=cols, names=names, dtype=str, header=None)
    return df.apply(lambda s: s.str.strip() if s.dtype == object else s).replace({"": np.nan})


def num(s: pd.Series) -> np.ndarray:
    return pd.to_numeric(s, errors="coerce").to_numpy(dtype=float)


def load_cf4(refresh: bool = False) -> pd.DataFrame:
    """Cosmicflows-4, distances of individual galaxies: pgc, ra, dec, dm, e_dm, method."""
    t = read_mrt(fetch(CF4_URL, CACHE / "cf4_t2.txt", refresh=refresh))
    out = pd.DataFrame({"pgc": num(t["PGC"]).astype(np.int64), "ra": num(t["RAdeg"]), "dec": num(t["DEdeg"]), "dm": num(t["DM"]), "e_dm": num(t["e_DM"])})
    # the most precise method the galaxy has (calibrators first)
    order = [("DMtrgb", "TRGB"), ("DMceph", "Cep"), ("DMmas", "maser"), ("DMsbf", "SBF"), ("DMsnIa", "SNIa"), ("DMsnII", "SNII"), ("DMfp", "FP"), ("DMtf", "TF")]
    method = np.full(len(t), "", dtype=object)
    for col, code in reversed(order):
        has = pd.notna(t[col]).to_numpy()
        method[has] = code
    out["method"] = method
    out["has_tf"] = pd.notna(t["DMtf"]).to_numpy()
    out["early"] = (pd.notna(t["DMfp"]) | pd.notna(t["DMsbf"])).to_numpy() & ~out["has_tf"].to_numpy()
    log.info("Cosmicflows-4: %d galaxies", len(out))
    return out


UNGC_METHOD = {"TRGB": "TRGB", "Cep": "Cep", "SN": "SNIa", "SBF": "SBF", "TF": "TF", "FP": "FP", "BS": "BS", "CMD": "CMD", "HB": "HB", "RR": "RR",
               "PNLF": "PNLF", "mem": "mem", "txt": "txt", "geom": "geom"}
#: typical distance modulus errors of the methods (mag), where a catalogue gives none
METHOD_ERR = {"TRGB": 0.1, "Cep": 0.1, "maser": 0.1, "geom": 0.1, "SBF": 0.15, "SNIa": 0.15, "SNII": 0.3, "RR": 0.1, "HB": 0.15, "CMD": 0.2, "PNLF": 0.2,
              "FP": 0.45, "TF": 0.45, "BS": 0.5, "mem": 0.35, "txt": 0.8, "other": 0.4}


def ungc_name(name: str) -> str:
    """'NGC0024' -> 'NGC 24', 'UGC00064' -> 'UGC 64', 'ESO349-031' -> 'ESO 349-031',
    'MESSIER081' -> 'M 81', 'HolmIX' -> 'Holmberg IX', 'KKH34' -> 'KKH 34'."""
    if re.fullmatch(r"[A-Z]{6,}", name):
        return name.title()  # 'CIRCINUS' -> 'Circinus'
    m = re.fullmatch(r"MESSIER0*(\d+)", name)
    if m:
        return f"M {m.group(1)}"
    m = re.fullmatch(r"Holm([IVX]+)", name)
    if m:
        return f"Holmberg {m.group(1)}"
    m = re.fullmatch(r"(NGC|IC|UGC|UGCA|DDO|PGC|KK|KKH|KKR|KKS|KKSG|KDG|KDGa|AGC|LV|BTS|FM|UA)\s*0*(\d+)([A-Z]?)", name)
    if m:
        return f"{m.group(1)} {m.group(2)}{m.group(3)}"
    m = re.fullmatch(r"ESO(\d+)-(\d+)", name)
    if m:
        return f"ESO {m.group(1)}-{m.group(2)}"
    return name


def load_ungc(refresh: bool = False) -> pd.DataFrame:
    """Updated Nearby Galaxy Catalog: name, ra, dec, distance, method, size, type, magnitudes."""
    t1 = read_mrt(fetch(UNGC_URL.format(n=1), CACHE / "ungc_t1.txt", refresh=refresh))
    t2 = read_mrt(fetch(UNGC_URL.format(n=2), CACHE / "ungc_t2.txt", refresh=refresh))
    t6 = read_mrt(fetch(UNGC_URL.format(n=6), CACHE / "ungc_t6.txt", refresh=refresh))
    ra = (num(t1["RAh"]) + num(t1["RAm"]) / 60 + num(t1["RAs"]) / 3600) * 15
    sign = np.where(t1["DE-"].fillna("+").to_numpy() == "-", -1.0, 1.0)
    dec = sign * (num(t1["DEd"]) + num(t1["DEm"]) / 60 + num(t1["DEs"]) / 3600)
    flag = t1["f_Dis"].fillna("").str.strip().to_numpy()
    out = pd.DataFrame(
        {
            "name": [ungc_name(str(n)) for n in t1["Name"]],
            "ra": ra,
            "dec": dec,
            "dist_mpc": num(t1["Dis"]),
            "flag": flag,
            "a26": num(t1["a26"]),
            "ba": num(t1["b/a"]),
            "bmag": num(t1["Bmag"]),
            "kmag": num(t1["Kmag"]),
            "ttype": num(t1["TType"]),
            "tdw": t1["Tdw1"].fillna("").str.strip().to_numpy(),
        }
    )
    two = pd.DataFrame({"name": [ungc_name(str(n)) for n in t2["Name"]], "logkl": num(t2["logKLum"]), "absb": num(t2["BMag"])})
    out = out.merge(two.drop_duplicates("name"), on="name", how="left")
    # the error of the adopted distance (Table 6 lists the measurements)
    six = pd.DataFrame({"name": [ungc_name(str(n)) for n in t6["Name"]], "e_dm": num(t6["e_DM"]), "n_dm": t6["n_DM"].fillna("").str.strip().to_numpy()})
    errs = {}
    for name, g in six.groupby("name"):
        errs[name] = {m: float(e) for m, e in zip(g["n_dm"], g["e_dm"]) if np.isfinite(e)}
    method = [UNGC_METHOD.get(f, "other") for f in out["flag"]]
    out["method"] = method
    out["e_dm"] = [errs.get(n, {}).get(f, METHOD_ERR.get(m, 0.4)) for n, f, m in zip(out["name"], out["flag"], method)]
    out["dm"] = 5 * np.log10(out["dist_mpc"].to_numpy() * 1e6) - 5
    # distances from the velocity alone (Hubble flow) are left out
    hubble = out["flag"].str.startswith("h").to_numpy() | ~np.isfinite(out["dm"].to_numpy())
    log.info("UNGC: %d galaxies, %d with a distance from the velocity only (left out unless another catalogue has one)", len(out), int(hubble.sum()))
    out.loc[hubble, "dm"] = np.nan
    # the Milky Way is a record of its own (milky_way())
    return out[out["name"] != "Milky Way"].reset_index(drop=True)


LVDB_TABLES = ("dwarf_mw", "dwarf_m31", "dwarf_local_field", "dwarf_local_field_distant")


def load_lvdb(refresh: bool = False) -> pd.DataFrame:
    """Local Volume Database: the dwarf galaxies (confirmed real), with structure and distance."""
    t = pd.read_csv(fetch(LVDB_URL, CACHE / "lvdb_comb_all.csv", refresh=refresh), low_memory=False)
    t = t[t["table"].isin(LVDB_TABLES) & (t["confirmed_real"].fillna(1) != 0)].reset_index(drop=True)
    em, ep = num(t["distance_modulus_em"]), num(t["distance_modulus_ep"])
    err = np.where(np.isfinite(em) & np.isfinite(ep), (em + ep) / 2, np.where(np.isfinite(em), em, ep))
    method = t["distance_measurement_method"].fillna("").astype(str).str.lower() if "distance_measurement_method" in t else pd.Series([""] * len(t))
    mmap = {"trgb": "TRGB", "rrl": "RR", "rr": "RR", "hb": "HB", "bhb": "HB", "cmd": "CMD", "ceph": "Cep", "cepheid": "Cep", "sbf": "SBF"}
    out = pd.DataFrame(
        {
            "key": t["key"].astype(str),
            "name": t["name"].astype(str),
            "host": t["host"].fillna("").astype(str),
            "table": t["table"].astype(str),
            "ra": num(t["ra"]),
            "dec": num(t["dec"]),
            "dm": num(t["distance_modulus"]),
            "e_dm": np.where(np.isfinite(err), err, 0.15),
            "method": [mmap.get(m.split("_")[0], "other") if m else "other" for m in method],
            "rhalf": num(t["rhalf"]),  # arcmin, major axis
            "ell": num(t["ellipticity"]),
            "pa": num(t["position_angle"]),
            "absv": num(t["M_V"]),
            "hi": num(t["flux_HI"]) if "flux_HI" in t else np.nan,
        }
    )
    out = out[np.isfinite(out["dm"]) & np.isfinite(out["ra"])].reset_index(drop=True)
    log.info("Local Volume Database: %d dwarf galaxies with a distance", len(out))
    return out


def load_xsc(refresh: bool = False) -> pd.DataFrame:
    """The 2MASS Extended Source Catalog (ra, dec, total radius, axis ratio, position angle, K)."""
    dest = CACHE / "xsc.parquet"
    if dest.exists() and not refresh:
        return pd.read_parquet(dest)
    parts = []
    for ra0 in range(0, 360, 10):
        q = f"SELECT ra,dec,r_ext,sup_ba,sup_phi,k_ba,k_phi,k_m_ext FROM fp_xsc WHERE ra >= {ra0} AND ra < {ra0 + 10}"
        df = tap_sync(IRSA_TAP, q, timeout=900)
        parts.append(df.apply(pd.to_numeric, errors="coerce"))
        log.info("2MASS XSC: ra %d-%d: %d sources", ra0, ra0 + 10, len(df))
    out = pd.concat(parts, ignore_index=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    out.to_parquet(dest, index=False)
    return out


WIKIDATA_LABELS = """SELECT ?item ?pgc ?en ?de ?enwiki ?dewiki WHERE {
  ?item wdt:P4095 ?pgc .
  OPTIONAL { ?item rdfs:label ?en FILTER(lang(?en)="en") }
  OPTIONAL { ?item rdfs:label ?de FILTER(lang(?de)="de") }
  OPTIONAL { ?ew schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?enwiki }
  OPTIONAL { ?dw schema:about ?item ; schema:isPartOf <https://de.wikipedia.org/> ; schema:name ?dewiki }
}"""
WIKIDATA_POS = """SELECT ?pgc ?ra ?dec WHERE { ?item wdt:P4095 ?pgc ; wdt:P6257 ?ra ; wdt:P6258 ?dec . }"""
WIKIDATA_CODES = """SELECT ?pgc ?code ?catLabel WHERE {
  ?item wdt:P4095 ?pgc . ?item p:P528 ?st . ?st ps:P528 ?code ; pq:P972 ?cat .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}"""


def _sparql(query: str, dest: Path, refresh: bool) -> pd.DataFrame:
    if dest.exists() and not refresh:
        return pd.read_csv(dest, dtype=str, keep_default_na=False)
    r = session().get(WIKIDATA, params={"query": query}, headers={"Accept": "text/csv"}, timeout=600)
    r.raise_for_status()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(r.content)
    return pd.read_csv(dest, dtype=str, keep_default_na=False)


def load_wikidata(refresh: bool = False) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Galaxies with a PGC number on Wikidata: labels and Wikipedia titles; catalogue numbers;
    positions."""
    labels = _sparql(WIKIDATA_LABELS, CACHE / "wd_labels.csv", refresh)
    codes = _sparql(WIKIDATA_CODES, CACHE / "wd_codes.csv", refresh)
    pos = _sparql(WIKIDATA_POS, CACHE / "wd_pos.csv", refresh)
    for df in (labels, codes, pos):
        df["pgc"] = pd.to_numeric(df["pgc"], errors="coerce")
    # an item with a Wikipedia article first where several share a PGC number
    labels["_wiki"] = (labels["enwiki"] != "") | (labels["dewiki"] != "")
    labels = labels.dropna(subset=["pgc"]).sort_values("_wiki", ascending=False, kind="stable").drop_duplicates("pgc").drop(columns="_wiki")
    codes = codes.dropna(subset=["pgc"])
    pos["ra"] = pd.to_numeric(pos["ra"], errors="coerce")
    pos["dec"] = pd.to_numeric(pos["dec"], errors="coerce")
    pos = pos.dropna().drop_duplicates("pgc")
    for df in (labels, codes, pos):
        df["pgc"] = df["pgc"].astype(np.int64)
    log.info("Wikidata: %d galaxies with a PGC number, %d catalogue numbers, %d positions", len(labels), len(codes), len(pos))
    return labels, codes, pos


WIKIDATA_BY_LABEL = """SELECT ?label ?item ?ra ?dec ?en ?de ?enwiki ?dewiki WHERE {{
  VALUES ?label {{ {values} }}
  ?item rdfs:label ?label ; wdt:P6257 ?ra ; wdt:P6258 ?dec .
  ?ew schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?enwiki .
  OPTIONAL {{ ?item rdfs:label ?en FILTER(lang(?en)="en") }}
  OPTIONAL {{ ?item rdfs:label ?de FILTER(lang(?de)="de") }}
  OPTIONAL {{ ?dw schema:about ?item ; schema:isPartOf <https://de.wikipedia.org/> ; schema:name ?dewiki }}
}}"""
LABEL_SUFFIXES = (
    "", " Dwarf", " Dwarf Galaxy", " dwarf galaxy", " Dwarf Spheroidal", " Dwarf Spheroidal Galaxy",
    " dwarf spheroidal galaxy", " Dwarf Elliptical Galaxy", " Dwarf Irregular Galaxy", " Galaxy", " (dwarf galaxy)",
)


def label_variants(name: str) -> list[str]:
    """English Wikidata labels a catalogue name may have: 'Fornax' -> 'Fornax Dwarf Galaxy', …;
    'Bootes I' -> 'Boötes I'; 'And XVI' -> 'Andromeda XVI'."""
    bases = {name}
    if "Bootes" in name:
        bases.add(name.replace("Bootes", "Boötes"))
    m = re.fullmatch(r"And ([IVX]+)", name)
    if m:
        bases.add(f"Andromeda {m.group(1)}")
    return [b + suffix for b in sorted(bases) for suffix in LABEL_SUFFIXES]


def load_wikidata_by_label(names: list[str], refresh: bool = False) -> pd.DataFrame:
    """Wikidata items with a sky position and an English Wikipedia article whose English label is a
    variant of one of the names (the galaxies Wikidata lists without a PGC number, such as the
    Fornax Dwarf Galaxy). Cached with the list of labels asked for."""
    dest, asked = CACHE / "wd_by_label.csv", CACHE / "wd_by_label.labels.txt"
    variants = sorted({v for n in names for v in label_variants(n)})
    if dest.exists() and asked.exists() and not refresh:
        if set(variants) <= set(asked.read_text("utf-8").splitlines()):
            return pd.read_csv(dest, dtype=str, keep_default_na=False)
    parts = []
    for i in range(0, len(variants), 400):
        values = " ".join(json.dumps(v, ensure_ascii=False) + "@en" for v in variants[i : i + 400])
        r = session().post(WIKIDATA, data={"query": WIKIDATA_BY_LABEL.format(values=values)}, headers={"Accept": "text/csv"}, timeout=600)
        r.raise_for_status()
        parts.append(pd.read_csv(io.BytesIO(r.content), dtype=str, keep_default_na=False))
    out = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=["label", "item", "ra", "dec", "en", "de", "enwiki", "dewiki"])
    dest.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(dest, index=False)
    asked.write_text("\n".join(variants), "utf-8")
    log.info("Wikidata: %d items found by %d labels", out["item"].nunique() if len(out) else 0, len(variants))
    return out


# ------------------------------------------------------------------ matching


def match(ra, dec, radius_arcmin, tra, tdec, tradius_arcmin=None) -> np.ndarray:
    """For each object (ra, dec) the index of the nearest target within the match radius (the
    larger of both objects' radii), or -1."""
    out = np.full(len(ra), -1, dtype=np.int64)
    if not len(ra) or not len(tra):
        return out
    tree = cKDTree(unit_vectors(tra, tdec))
    u = unit_vectors(ra, dec)
    rad = np.radians(np.asarray(radius_arcmin, dtype=float) / 60)
    trad = np.radians(np.asarray(tradius_arcmin, dtype=float) / 60) if tradius_arcmin is not None else np.zeros(len(tra))
    rmax = float(np.max(rad) if len(rad) else 0) + float(np.max(trad) if len(trad) else 0)
    hits = tree.query_ball_point(u, r=2 * np.sin(rmax / 2))
    for i, lst in enumerate(hits):
        best, bd = -1, np.inf
        for j in lst:
            d = 2 * np.arcsin(min(1.0, np.linalg.norm(u[i] - tree.data[j]) / 2))
            if d <= max(rad[i], trad[j]) and d < bd:
                best, bd = j, d
        out[i] = best
    return out


# ------------------------------------------------------------------ the galaxy list


def merged(cf4: pd.DataFrame, ungc: pd.DataFrame, lvdb: pd.DataFrame) -> pd.DataFrame:
    """One row per galaxy: Cosmicflows-4, then the UNGC and LVDB galaxies matched to it by position
    (and distance where both have one) or added."""
    g = pd.DataFrame(
        {
            "ra": cf4["ra"].to_numpy(),
            "dec": cf4["dec"].to_numpy(),
            "pgc": cf4["pgc"].to_numpy(),
            "cf4": np.arange(len(cf4)),
            "ungc": -1,
            "lvdb": -1,
        }
    )

    def attach(cat: pd.DataFrame, key: str, radius: np.ndarray, max_ddm: float) -> pd.DataFrame:
        nonlocal g
        idx = match(cat["ra"].to_numpy(), cat["dec"].to_numpy(), radius, g["ra"].to_numpy(), g["dec"].to_numpy())
        # a match must also agree in distance where both catalogues have one
        dm_cat = cat["dm"].to_numpy(dtype=float)
        dm_g = best_dm_so_far(g, cf4, ungc)
        for i, j in enumerate(idx):
            if j >= 0 and np.isfinite(dm_cat[i]) and np.isfinite(dm_g[j]) and abs(dm_cat[i] - dm_g[j]) > max_ddm:
                idx[i] = -1
        # one catalogue row per galaxy: the nearest wins
        taken: dict[int, int] = {}
        for i, j in enumerate(idx):
            if j < 0:
                continue
            if j in taken:
                k = taken[j]
                du = np.hypot(cat["ra"].iat[i] - g["ra"].iat[j], cat["dec"].iat[i] - g["dec"].iat[j])
                dk = np.hypot(cat["ra"].iat[k] - g["ra"].iat[j], cat["dec"].iat[k] - g["dec"].iat[j])
                if du >= dk:
                    idx[i] = -1
                    continue
                idx[k] = -1
            taken[j] = i
        hit = idx >= 0
        col = g[key].to_numpy().copy()
        col[idx[hit]] = np.nonzero(hit)[0]
        g[key] = col
        new = pd.DataFrame({"ra": cat["ra"].to_numpy()[~hit], "dec": cat["dec"].to_numpy()[~hit], "pgc": 0, "cf4": -1, "ungc": -1, "lvdb": -1})
        new[key] = np.nonzero(~hit)[0]
        log.info("%s: %d matched, %d added", key, int(hit.sum()), int((~hit).sum()))
        g = pd.concat([g, new], ignore_index=True)
        return g

    # match radius: 1.5', or a third of the galaxy's own radius (large nearby galaxies)
    attach(ungc, "ungc", np.maximum(1.5, np.nan_to_num(ungc["a26"].to_numpy()) / 6), 1.0)
    attach(lvdb, "lvdb", np.maximum(1.5, np.nan_to_num(lvdb["rhalf"].to_numpy()) / 2), 1.0)
    return g


def name_key(name: str) -> str:
    """A name reduced for comparing: 'MESSIER081', 'Messier 81' and 'M 81' -> 'M81',
    'ESO 349-031' -> 'ESO349-31', 'And XVIII' and 'Andromeda XVIII' -> 'ANDXVIII'."""
    s = str(name).upper().strip()
    s = re.sub(r"^MESSIER\b|^MESSIER(?=\d)", "M", s)
    s = re.sub(r"^ANDROMEDA\b", "AND", s)
    s = re.sub(r"[\s_]+", "", s)
    return re.sub(r"\d+", lambda m: str(int(m.group())), s)


def pgc_by_name(labels: pd.DataFrame, codes: pd.DataFrame) -> dict[str, int]:
    """Wikidata's labels and catalogue numbers -> PGC number (names that name one galaxy only)."""
    seen: dict[str, set[int]] = {}
    for col in ("en", "enwiki"):
        for pgc, v in zip(labels["pgc"], labels[col]):
            if v:
                seen.setdefault(name_key(v), set()).add(int(pgc))
    for pgc, v in zip(codes["pgc"], codes["code"]):
        if v:
            seen.setdefault(name_key(v), set()).add(int(pgc))
    return {k: next(iter(v)) for k, v in seen.items() if len(v) == 1 and k}


def adopt_pgc(g: pd.DataFrame, cf4: pd.DataFrame, ungc: pd.DataFrame, lvdb: pd.DataFrame, labels: pd.DataFrame, codes: pd.DataFrame, wpos: pd.DataFrame) -> pd.DataFrame:
    """The galaxies added from the UNGC or the LVDB get a PGC number from Wikidata: by name, else
    by position (within 1.5' or the galaxy's own match radius). One that turns out to be a galaxy
    already in the list (missed by the position match, or listed under the same UNGC / LVDB name)
    is merged into it."""
    by_name = pgc_by_name(labels, codes)
    pgc = g["pgc"].to_numpy().copy()
    ucol, lcol = g["ungc"].to_numpy().copy(), g["lvdb"].to_numpy().copy()
    added = np.nonzero(pgc == 0)[0]
    if not len(added):
        return g
    radius = np.full(len(added), 1.5)
    a26 = np.where(ucol[added] >= 0, ungc["a26"].to_numpy()[np.maximum(ucol[added], 0)], np.nan)
    rh = np.where(lcol[added] >= 0, lvdb["rhalf"].to_numpy()[np.maximum(lcol[added], 0)], np.nan)
    radius = np.maximum(radius, np.nan_to_num(a26) / 6)
    radius = np.maximum(radius, np.nan_to_num(rh) / 2)
    near = match(g["ra"].to_numpy()[added], g["dec"].to_numpy()[added], radius, wpos["ra"].to_numpy(), wpos["dec"].to_numpy())
    row_of = {int(p): k for k, p in enumerate(pgc) if p}
    dm = best_dm_so_far(g, cf4, ungc)
    lv_dm = lvdb["dm"].to_numpy(dtype=float)
    dm = np.where(np.isfinite(dm), dm, np.where(lcol >= 0, lv_dm[np.maximum(lcol, 0)], np.nan))

    def own_names(k: int) -> list[str]:
        out = []
        if ucol[k] >= 0:
            out.append(ungc["name"].iat[ucol[k]])
        if lcol[k] >= 0:
            out.append(lvdb["name"].iat[lcol[k]])
        return out

    by_own: dict[str, int] = {}
    for k in np.nonzero(pgc != 0)[0]:
        for v in own_names(k):
            by_own.setdefault(name_key(v), int(k))
    drop: list[int] = []
    n_name = n_pos = n_merged = 0
    for a, k in enumerate(added):
        names = own_names(k)
        # listed already under the same name (centres too far apart for the position match)
        j = next((by_own[key] for key in map(name_key, names) if key in by_own), -1)
        if j >= 0 and (ucol[k] < 0 or ucol[j] < 0) and (lcol[k] < 0 or lcol[j] < 0) and not abs(dm[k] - dm[j]) > 1.0:
            if ucol[k] >= 0:
                ucol[j] = ucol[k]
            if lcol[k] >= 0:
                lcol[j] = lcol[k]
            drop.append(k)
            n_merged += 1
            continue
        p = next((by_name[key] for key in map(name_key, names) if key in by_name), 0)
        if p:
            n_name += 1
        elif near[a] >= 0:
            p = int(wpos["pgc"].iat[near[a]])
            n_pos += 1
        if not p:
            continue
        j = row_of.get(p)
        if j is None:
            pgc[k] = p
            row_of[p] = k
        elif (ucol[k] < 0 or ucol[j] < 0) and (lcol[k] < 0 or lcol[j] < 0):
            # the same galaxy as row j
            if ucol[k] >= 0:
                ucol[j] = ucol[k]
            if lcol[k] >= 0:
                lcol[j] = lcol[k]
            drop.append(k)
            n_merged += 1
    g = g.copy()
    g["pgc"], g["ungc"], g["lvdb"] = pgc, ucol, lcol
    log.info("PGC numbers from Wikidata: %d by name, %d by position, %d merged into a galaxy already listed", n_name, n_pos, n_merged)
    return g.drop(index=drop).reset_index(drop=True)


def best_dm_so_far(g: pd.DataFrame, cf4: pd.DataFrame, ungc: pd.DataFrame) -> np.ndarray:
    dm = np.full(len(g), np.nan)
    c = g["cf4"].to_numpy()
    dm[c >= 0] = cf4["dm"].to_numpy()[c[c >= 0]]
    u = g["ungc"].to_numpy()
    use = (u >= 0) & ~np.isfinite(dm)
    dm[use] = ungc["dm"].to_numpy()[u[use]]
    return dm


def calibrate(a: np.ndarray, b: np.ndarray, default: float) -> float:
    """Median ratio a / b over the pairs where both are known."""
    ok = np.isfinite(a) & np.isfinite(b) & (a > 0) & (b > 0)
    return float(np.median(a[ok] / b[ok])) if ok.sum() >= 10 else default


def galaxy_table(cf4, ungc, lvdb, xsc, labels, codes, wpos) -> pd.DataFrame:
    """Every galaxy with position, distance, size, shape, class, luminosity and names."""
    g = adopt_pgc(merged(cf4, ungc, lvdb), cf4, ungc, lvdb, labels, codes, wpos)
    n = len(g)
    ci, ui, li = g["cf4"].to_numpy(), g["ungc"].to_numpy(), g["lvdb"].to_numpy()

    def take(cat: pd.DataFrame, idx: np.ndarray, col: str, fill=np.nan) -> np.ndarray:
        v = cat[col].to_numpy()
        out = np.full(n, fill, dtype=v.dtype if v.dtype != object else object)
        out[idx >= 0] = v[idx[idx >= 0]]
        return out

    # --- distance: the most precise of the catalogues
    cand = [
        (take(lvdb, li, "dm"), take(lvdb, li, "e_dm"), take(lvdb, li, "method", ""), F_LVDB),
        (take(ungc, ui, "dm"), take(ungc, ui, "e_dm"), take(ungc, ui, "method", ""), F_UNGC),
        (take(cf4, ci, "dm"), take(cf4, ci, "e_dm"), take(cf4, ci, "method", ""), F_CF4),
    ]
    dm = np.full(n, np.nan)
    edm = np.full(n, np.inf)
    method = np.full(n, "", dtype=object)
    flags = np.zeros(n, np.int64)
    for d, e, m, f in cand:
        ok = np.isfinite(d)
        better = ok & (np.nan_to_num(e, nan=0.5) < edm)
        dm[better], edm[better], method[better] = d[better], np.nan_to_num(e[better], nan=0.5), m[better]
    flags |= np.where(li >= 0, F_LVDB, 0) | np.where(ui >= 0, F_UNGC, 0) | np.where(ci >= 0, F_CF4, 0)
    keep = np.isfinite(dm)
    log.info("galaxies: %d in all, %d without a redshift-independent distance left out", n, int((~keep).sum()))
    dist_ly = 10 ** (dm / 5 + 1) * LY_PER_PC
    ra, dec = g["ra"].to_numpy(), g["dec"].to_numpy()

    # --- 2MASS: size, shape and K magnitude of the galaxies it has (within 10" or 1/4 of its size)
    xi = match(ra, dec, np.full(n, 10 / 60), xsc["ra"].to_numpy(), xsc["dec"].to_numpy(), np.nan_to_num(xsc["r_ext"].to_numpy()) / 60 / 4)
    r_ext = take(xsc, xi, "r_ext")
    x_ba = np.where(np.isfinite(take(xsc, xi, "sup_ba")), take(xsc, xi, "sup_ba"), take(xsc, xi, "k_ba"))
    x_pa = np.where(np.isfinite(take(xsc, xi, "sup_phi")), take(xsc, xi, "sup_phi"), take(xsc, xi, "k_phi"))
    kmag_x = take(xsc, xi, "k_m_ext")

    # --- size (diameter in arcmin): UNGC Holmberg diameter, else 2MASS or LVDB scaled to it
    a26 = take(ungc, ui, "a26")
    rhalf = take(lvdb, li, "rhalf")
    k_x = calibrate(a26 * 60, 2 * r_ext, 2.0)
    k_l = calibrate(a26, 2 * rhalf, 2.0)
    log.info("sizes: Holmberg diameter = %.2f x 2MASS total diameter = %.2f x LVDB half-light diameter", k_x, k_l)
    diam_arcmin = np.where(np.isfinite(a26), a26, np.where(np.isfinite(r_ext), k_x * 2 * r_ext / 60, k_l * 2 * rhalf))
    diam_ly = np.radians(diam_arcmin / 60) * dist_ly

    # --- luminosity (log L_sun, near infrared where possible)
    logl = take(ungc, ui, "logkl")
    from_k = (3.28 - (kmag_x - dm)) / 2.5
    logl = np.where(np.isfinite(logl), logl, from_k)
    from_v = (4.83 - take(lvdb, li, "absv")) / 2.5
    logl = np.where(np.isfinite(logl), logl, from_v)
    from_b = (5.48 - take(ungc, ui, "absb")) / 2.5
    logl = np.where(np.isfinite(logl), logl, from_b)
    # galaxies without a size: from their luminosity (fit over those with both), else 30,000 ly
    ok = np.isfinite(diam_ly) & np.isfinite(logl) & (diam_ly > 0)
    if ok.sum() > 50:
        slope, icpt = np.polyfit(logl[ok], np.log10(diam_ly[ok]), 1)
        est = 10 ** (icpt + slope * logl)
    else:
        est = np.full(n, 30000.0)
    diam_ly = np.where(np.isfinite(diam_ly) & (diam_ly > 0), diam_ly, np.where(np.isfinite(est), est, 30000.0))
    logl = np.where(np.isfinite(logl), logl, (np.log10(diam_ly) - (icpt if ok.sum() > 50 else 0)) / (slope if ok.sum() > 50 else 1))

    # --- shape: LVDB ellipticity and position angle, else 2MASS, else UNGC axis ratio
    q = 1 - take(lvdb, li, "ell")
    pa = take(lvdb, li, "pa")
    q = np.where(np.isfinite(q), q, x_ba)
    pa = np.where(np.isfinite(pa), pa, x_pa)
    q = np.where(np.isfinite(q), q, take(ungc, ui, "ba"))
    # unknown position angles: fixed pseudo-random ones
    seed = np.array([_hash(f"{p}:{r:.4f}:{d:.4f}") for p, r, d in zip(g["pgc"], ra, dec)], dtype=np.uint64)
    pa = np.where(np.isfinite(pa), pa, (seed % 18000) / 100.0)
    q = np.clip(np.where(np.isfinite(q), q, 0.75), 0.05, 1.0)

    # --- class
    ttype = take(ungc, ui, "ttype")
    tdw = take(ungc, ui, "tdw", "")
    cls = np.full(n, SPIRAL, np.int64)
    early = take(cf4, ci, "early", False).astype(bool)
    cls[early] = ELLIPTICAL
    has_t = np.isfinite(ttype)
    cls[has_t & (ttype <= -4)] = ELLIPTICAL
    cls[has_t & (ttype > -4) & (ttype <= 0)] = LENTICULAR
    cls[has_t & (ttype > 0) & (ttype <= 8)] = SPIRAL
    cls[has_t & (ttype > 8)] = IRREGULAR
    dw = np.array([str(t) for t in tdw])
    cls[np.isin(dw, ["Sph", "dE", "dEem", "dS0em"])] = SPHEROIDAL
    cls[np.isin(dw, ["Ir", "Im", "BCD", "Tr"])] = IRREGULAR
    lv_only = (li >= 0) & ~has_t & (ci < 0)
    host = take(lvdb, li, "host", "")
    satellite = np.array([h not in ("", "nan") for h in host])
    cls[lv_only & satellite] = SPHEROIDAL
    cls[lv_only & ~satellite] = IRREGULAR

    # --- orientation and position
    major, normal = orientation(ra, dec, pa, q, cls, seed)
    xyz = (unit_vectors(ra, dec) @ A_G.T) * dist_ly[:, None]

    out = pd.DataFrame(
        {
            "ra": ra,
            "dec": dec,
            "pgc": g["pgc"].to_numpy(),
            "x": xyz[:, 0],
            "y": xyz[:, 1],
            "z": xyz[:, 2],
            "dist_ly": dist_ly,
            "dm": dm,
            "e_dm": edm,
            "method": method,
            "diam_ly": diam_ly,
            "q": q,
            "pa": pa,
            "cls": cls,
            "logl": logl,
            "flags": flags,
            "ungc_name": take(ungc, ui, "name", None),
            "lvdb_name": take(lvdb, li, "name", None),
        }
    )
    out[["mx", "my", "mz"]] = major
    out[["nx", "ny", "nz"]] = normal
    out = out[keep].reset_index(drop=True)
    out = add_names(out, labels, codes)
    out = local_group(out)
    return out


def _hash(s: str) -> int:
    return int.from_bytes(hashlib.blake2b(s.encode(), digest_size=8).digest(), "little")


def orientation(ra, dec, pa, q, cls, seed) -> tuple[np.ndarray, np.ndarray]:
    """Unit vectors (galactic frame) of each galaxy's major axis and disk normal. The major axis
    lies on the sky at the position angle; the disk is tilted out of the sky plane about it by the
    inclination that the axis ratio gives (with an intrinsic thickness Q0); which way it tilts the
    sky does not tell, so a fixed pseudo-random choice. Seen from the Sun every disk then looks as
    on the sky."""
    s = unit_vectors(ra, dec)
    r, d = np.radians(ra), np.radians(dec)
    east = np.stack([-np.sin(r), np.cos(r), np.zeros_like(r)], axis=1)
    north = np.stack([-np.sin(d) * np.cos(r), -np.sin(d) * np.sin(r), np.cos(d)], axis=1)
    p = np.radians(pa)
    m = np.sin(p)[:, None] * east + np.cos(p)[:, None] * north
    w = np.cross(s, m)
    qq = np.where(cls == SPHEROIDAL, np.maximum(q, 0.3), q)
    cosi = np.sqrt(np.clip((qq**2 - Q0**2) / (1 - Q0**2), 0, 1))
    sini = np.sqrt(1 - cosi**2)
    sign = np.where(seed % 2 == 0, 1.0, -1.0)
    nrm = cosi[:, None] * s + (sini * sign)[:, None] * w
    major = m @ A_G.T
    normal = nrm @ A_G.T
    return major / np.linalg.norm(major, axis=1)[:, None], normal / np.linalg.norm(normal, axis=1)[:, None]


CATALOGUE_RE = re.compile(
    r"^(?i:NGC|IC|UGCA?|PGC|LEDA|ESO|MCG|CGCG|IRAS|2MASXJ?|2MASS|SDSS|KUG|MRK|Markarian|DDO|KKSG|KKH|KKR|KKS|KK|KDG|AGC|HIPASS|6dF|Holmberg|VCC|FCC|NPM1?G?|UZC|LSBC|ABELL|ARK|HCG|AM|GALEXASC|APMUKS|WISEA|FGC|IRSF|3C|4C|Z|F|A|B)"
    r"\s*[+\-]?[\dJIVX][\s\d+\-.:/A-Z]*$"
)


def catalogue_rank(code: str) -> int:
    if re.match(r"^(M|Messier)\s*\d+$", code):
        return 1
    if code.upper().startswith("NGC"):
        return 2
    if code.upper().startswith("IC"):
        return 3
    return 4


MESSIER_RE = re.compile(r"^(?:Messier|M)\s*(\d+)$", re.I)


def messier(name: str | None) -> str | None:
    """'Messier 81' -> 'M 81' (the short form in both languages)."""
    m = MESSIER_RE.match(name) if name else None
    return f"M {m.group(1)}" if m else name


def add_names(g: pd.DataFrame, labels: pd.DataFrame, codes: pd.DataFrame) -> pd.DataFrame:
    """Display names (English, German) with a rank, and other designations, per galaxy."""
    lab = labels.set_index("pgc")
    cat_of: dict[int, dict[str, str]] = {}
    for pgc, code, cat in zip(codes["pgc"], codes["code"], codes["catLabel"]):
        d = cat_of.setdefault(int(pgc), {})
        if cat == "Messier object":
            d.setdefault("M", re.sub(r"^M\s*", "M ", code))
        elif cat == "New General Catalogue":
            d.setdefault("NGC", code)
        elif cat == "Index Catalogue":
            d.setdefault("IC", code)
        elif cat == "Uppsala General Catalogue":
            d.setdefault("UGC", code)
        elif cat == "European Southern Observatory Catalog":
            d.setdefault("ESO", code)
    en, de, rank, alt = [], [], [], []
    for pgc, un, ln, flag in zip(g["pgc"], g["ungc_name"], g["lvdb_name"], g["flags"]):
        pgc = int(pgc)
        row = lab.loc[pgc] if pgc and pgc in lab.index else None
        cats = cat_of.get(pgc, {})
        own = [v for v in (ln, un) if isinstance(v, str) and v and v != "nan"]
        designations = []
        for v in (
            [cats[k] for k in ("M", "NGC", "IC") if k in cats]
            + [v for v in own if not CATALOGUE_RE.match(v)]
            + [cats[k] for k in ("UGC", "ESO") if k in cats]
            + [v for v in own if CATALOGUE_RE.match(v)]
            + ([f"PGC {pgc}"] if pgc else [])
        ):
            if name_key(v) not in {name_key(x) for x in designations}:
                designations.append(v)
        e = d = None
        r = 99
        if row is not None:
            e = messier(row["en"] or row["enwiki"] or None)
            d = messier(row["de"] or row["dewiki"] or None)
        common = e and not CATALOGUE_RE.match(e) and not MESSIER_RE.match(e)
        if common and (row["enwiki"] or row["dewiki"]):
            r = 0
        elif designations and not designations[0].startswith("PGC"):
            # the best catalogue designation; the LVDB / UNGC names ("Bootes I", "WLM") count as names
            best = designations[0]
            r = catalogue_rank(best) if best in cats.values() else 4
            if e is None or CATALOGUE_RE.match(e) or MESSIER_RE.match(e):
                e = best
        elif e is None:
            e = designations[0] if designations else None
        if d is None or (CATALOGUE_RE.match(d) and r != 0):
            d = e if r != 0 or d is None else d
        en.append(e)
        de.append(d if d != e else None)
        rank.append(r)
        alt.append([x for x in designations if x != e][:8])
    g = g.copy()
    g["name_en"], g["name_de"], g["rank"], g["alt"] = en, de, rank, alt
    g["designation"] = [f"PGC {p}" if p else (a[0] if a else e) for p, a, e in zip(g["pgc"], g["alt"], g["name_en"])]
    g.loc[g["rank"] < 99, "flags"] |= F_NAMED
    return g


def wikipedia_names(g: pd.DataFrame, found: pd.DataFrame) -> pd.DataFrame:
    """A galaxy without a common name whose LVDB / UNGC name is (the start of) the label of a
    Wikidata item with a Wikipedia article at the same place on the sky (within 20' or its own
    size) gets that item's names: 'Fornax' -> 'Fornax Dwarf Galaxy' / 'Fornax-Zwerggalaxie'."""
    if not len(found):
        return g
    found = found.copy()
    found["ra"] = pd.to_numeric(found["ra"], errors="coerce")
    found["dec"] = pd.to_numeric(found["dec"], errors="coerce")
    found = found.dropna(subset=["ra", "dec"])
    by_label: dict[str, list[int]] = {}
    for k, label in enumerate(found["label"]):
        by_label.setdefault(label, []).append(k)
    fu = unit_vectors(found["ra"].to_numpy(), found["dec"].to_numpy())
    g = g.copy()
    en, de, rank, alt, flags = g["name_en"].tolist(), g["name_de"].tolist(), g["rank"].to_numpy().copy(), g["alt"].tolist(), g["flags"].to_numpy().copy()
    gu = unit_vectors(g["ra"].to_numpy(), g["dec"].to_numpy())
    size = np.degrees(g["diam_ly"].to_numpy() / g["dist_ly"].to_numpy()) * 60
    n = 0
    for k in np.nonzero(rank != 0)[0]:
        own = [v for v in (g["lvdb_name"].iat[k], g["ungc_name"].iat[k]) if isinstance(v, str) and v and not CATALOGUE_RE.match(v)]
        cands = {j for v in own for lab in label_variants(v) for j in by_label.get(lab, [])}
        best, bd = -1, np.radians(max(20.0, size[k]) / 60)
        for j in cands:
            d = 2 * np.arcsin(min(1.0, np.linalg.norm(fu[j] - gu[k]) / 2))
            if d <= bd:
                best, bd = j, d
        if best < 0:
            continue
        item = found.iloc[best]
        e = messier(item["en"] or item["enwiki"] or None)
        d = messier(item["de"] or item["dewiki"] or None)
        if not e or CATALOGUE_RE.match(e) or MESSIER_RE.match(e):
            continue
        old = en[k]
        alt[k] = ([old] if isinstance(old, str) and old != e else []) + [x for x in alt[k] if x not in (e, old)]
        alt[k] = alt[k][:8]
        en[k], de[k], rank[k] = e, (d if d and d != e else None), 0
        flags[k] |= F_NAMED
        n += 1
    g["name_en"], g["name_de"], g["rank"], g["alt"], g["flags"] = en, de, rank, alt, flags
    log.info("Wikipedia names by label: %d galaxies", n)
    return g


def local_group(g: pd.DataFrame) -> pd.DataFrame:
    """Flags the members of the Local Group: within 1.5 Mpc of its barycentre (between the Milky
    Way and Andromeda, a little nearer to Andromeda)."""
    gc = galactic_centre()
    m31 = g[g["pgc"] == 2557]
    if len(m31):
        a = m31[["x", "y", "z"]].to_numpy()[0]
        bary = gc + 0.55 * (a - gc)
        d = np.linalg.norm(g[["x", "y", "z"]].to_numpy() - bary, axis=1)
        g.loc[d < LG_RADIUS_LY, "flags"] |= F_LOCAL_GROUP
        log.info("Local Group: %d galaxies within 1.5 Mpc of its barycentre", int((d < LG_RADIUS_LY).sum()))
    return g


def galactic_centre() -> np.ndarray:
    l, b = math.radians(359.944), math.radians(-0.046)
    return GC_DIST_LY * np.array([math.cos(b) * math.cos(l), math.cos(b) * math.sin(l), math.sin(b)])


def milky_way() -> dict:
    """The Milky Way (drawn as a model, see docs/GALAXIES.md) as the first record."""
    c = galactic_centre()
    return {
        "x": c[0], "y": c[1], "z": c[2], "diam_ly": 100_000.0, "q": 1.0, "cls": MILKY_WAY, "logl": 10.8,
        "dist_ly": float(np.linalg.norm(c)), "e_dm": 0.02, "method": "geom", "flags": F_MODEL | F_LOCAL_GROUP | F_NAMED,
        "pgc": 0, "mx": 1.0, "my": 0.0, "mz": 0.0, "nx": 0.0, "ny": 0.0, "nz": 1.0,
        "name_en": "Milky Way", "name_de": "Milchstraße", "rank": 0, "alt": [], "designation": "Milky Way",
    }


# ------------------------------------------------------------------ output


def _text(v) -> str | None:
    """A name, or None (pandas stores a missing one as NaN)."""
    return v if isinstance(v, str) and v else None


def write(g: pd.DataFrame, out: Path) -> dict:
    """galaxies.bin (records) and galaxies.json (names, sources, layout)."""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    rows = [milky_way()] + g.to_dict("records")
    buf = bytearray()
    names = []
    methods = {m: k for k, m in enumerate(METHODS)}
    for k, r in enumerate(rows):
        derr = r["e_dm"] * math.log(10) / 5  # relative distance error
        logl = r["logl"]
        buf += RECORD.pack(
            float(r["x"]), float(r["y"]), float(r["z"]), float(r["diam_ly"]),
            *(int(round(np.clip(v, -1, 1) * 127)) for v in (r["mx"], r["my"], r["mz"])),
            *(int(round(np.clip(v, -1, 1) * 127)) for v in (r["nx"], r["ny"], r["nz"])),
            int(round(np.clip(r["q"], 0, 1) * 255)),
            int(r["cls"]),
            int(round(logl * 1000)) if np.isfinite(logl) else -32768,
            int(min(round(derr * 200), 254)) if np.isfinite(derr) else 255,
            methods.get(r["method"], methods["other"]),
            int(r["flags"]) & 0xFF,
            0,
            0,
            int(r["pgc"]),
        )
        if r["rank"] < 99 or not r["pgc"]:
            entry = [k, _text(r["name_en"]), _text(r["name_de"]), int(r["rank"]), r["designation"]]
            other = [x for x in r["alt"] if x != r["designation"]]
            if other:
                entry.append(other)
            names.append(entry)
    (out / "galaxies.bin").write_bytes(bytes(buf))
    meta = {
        "format": "galmap-galaxies",
        "version": 1,
        "generated": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "units": "ly",
        "frame": "galactic-heliocentric",
        "count": len(rows),
        "recordBytes": RECORD.size,
        "data": "galaxies.bin",
        "classes": CLASSES,
        "methods": METHODS,
        "names": names,
        "sources": SOURCES,
        "stats": {
            "galaxies": len(rows),
            "localGroup": int(sum(1 for r in rows if r["flags"] & F_LOCAL_GROUP)),
            "named": int(sum(1 for r in rows if r["rank"] < 99)),
            "cf4": int(sum(1 for r in rows if r["flags"] & F_CF4)),
            "ungc": int(sum(1 for r in rows if r["flags"] & F_UNGC)),
            "lvdb": int(sum(1 for r in rows if r["flags"] & F_LVDB)),
            "maxDistanceLy": float(max(r["dist_ly"] for r in rows)),
        },
    }
    (out / "galaxies.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":"), allow_nan=False), "utf-8")
    log.info("galaxies: %d written (%d named, %d in the Local Group), %.1f MB", len(rows), meta["stats"]["named"], meta["stats"]["localGroup"], len(buf) / 1e6)
    return meta


def build(out: Path, refresh: bool = False) -> dict:
    cf4 = load_cf4(refresh)
    ungc = load_ungc(refresh)
    lvdb = load_lvdb(refresh)
    xsc = load_xsc(refresh)
    labels, codes, wpos = load_wikidata(refresh)
    names = [v for v in pd.concat([ungc["name"], lvdb["name"]]) if isinstance(v, str) and v and not CATALOGUE_RE.match(v)]
    found = load_wikidata_by_label(names, refresh)
    return write(wikipedia_names(galaxy_table(cf4, ungc, lvdb, xsc, labels, codes, wpos), found), out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[2] / "public" / "data")
    ap.add_argument("--refresh", action="store_true", help="download the catalogues again")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    build(args.out, args.refresh)


if __name__ == "__main__":
    main()
