"""SIMBAD (CDS, Strasbourg): identifiers and common names of all objects within 100 pc.

We fetch the `basic` rows (main identifier, object type, spectral type, parallax) of every
object with a parallax >= 10 mas and all of their identifiers, and attach them to our stars
through the Gaia DR3 source_id or the HIP number. They provide common names ("NAME ..."),
Bayer/Flamsteed and variable-star designations, historical and survey catalogue names, object
types (brown dwarf, white dwarf) and spectral types for stars that lack them.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

import numpy as np
import pandas as pd

from scipy.spatial import cKDTree

from ..coords import propagate, unit_vectors
from ..download import CACHE_DIR, exact_int64, tap_sync
from ..names import letters_conflict

log = logging.getLogger(__name__)

TAP = "https://simbad.cds.unistra.fr/simbad/sim-tap"
DIR = CACHE_DIR / "simbad"
BASIC_FILE = DIR / "simbad_basic_plx10.csv"
IDENT_FILE = DIR / "simbad_ident_plx10.csv"
MIN_PLX = 10.0
MAXREC = 2_000_000

SOURCE_INFO = {
    "key": "simbad",
    "title": "SIMBAD astronomical database",
    "citation": "Wenger M. et al. 2000, A&AS 143, 9. This research has made use of the SIMBAD database, "
    "operated at CDS, Strasbourg, France.",
    "url": "https://simbad.cds.unistra.fr/",
    "license": "ODbL 1.0 (CDS data)",
}

# Objects with a parallax >= 10 mas, plus their components/children without a parallax of their own
# (Procyon B, Luhman 16 A/B, many system objects have plx NULL in SIMBAD).
W10 = (
    "(b.plx_value >= 10 OR (b.plx_value IS NULL AND b.oid IN "
    "(SELECT h.child FROM h_link AS h JOIN basic AS p ON p.oid = h.parent WHERE p.plx_value >= 10)))"
)
BASIC_QUERY = (
    "SELECT b.oid, b.main_id, b.otype, b.ra, b.dec, b.pmra, b.pmdec, b.plx_value, b.plx_err, b.sp_type "
    f"FROM basic AS b WHERE {W10}"
)
IDENT_QUERY = f"SELECT i.oidref, i.id FROM ident AS i JOIN basic AS b ON b.oid = i.oidref WHERE {W10}"
BASIC_COUNT = f"SELECT COUNT(*) AS n FROM basic AS b WHERE {W10}"
IDENT_COUNT = f"SELECT COUNT(*) AS n FROM ident AS i JOIN basic AS b ON b.oid = i.oidref WHERE {W10}"

# Identifier prefixes that never yield a useful name (cross-match catalogues etc.). Double-star
# designations ("** STF 2398") stay: some carry traditional names (Struve 2398, Kruger 60), and so do
# "HIDDEN NAME" identifiers ("HIDDEN NAME 17 Com B"). Cluster members ("Cl* Melotte 25 S 6",
# "Cl Melotte 111 132") and other catalogues with a "*" acronym ("GR* 195", "EM* StHA 67", "SV* ZI 2047")
# are not names either.
NOISE = re.compile(
    r"^(TIC|Gaia DR[12]|Gaia EDR3|UCAC\d|UCAC|AG[+-]|PPM|SAO|GSC|USNO|URAT|TYC|HIC|IRAS|AKARI|ASCC|KIC|EPIC|"
    r"ALLWISE|AllWISE|WISEA|GALEX|SDSS|PS1|SKY#|N30|FK5|GCRV|uvby98|YZ|CSI|PLX|IDS|CCDM|WDS|Renson|JP11|"
    r"UBV|ROT|SPOCS|TD1|Ci|BPS|GEN#|LEP|NSV|RAVE|LAMOST|Pan-STARRS|PSO J\d|2MASX|XMMU|1RXS|RX J|1ES|EUVE|"
    r"\[|CNS|BIBCODE|Zkh|MCC|StKM|TOI|KOI|K2-|Kepler-|Cl |(?!V\* )[A-Za-z][A-Za-z0-9]{0,3}\?*\* )"
)
# catalogue designations used to check a position match against the star's own numbers
_DESIG = re.compile(r"^(HD|HIP|GJ|Gl|Gaia DR3)\s*(\d+(?:\.\d+)?)\s*([A-H][a-c]?)?$")

# object types that are not stars (planets, clusters, associations, quasars, errors)
NON_STELLAR = {"Pl", "Pl?", "MGr", "As*", "OpC", "St*", "Cl*", "SFR", "GlC", "QSO", "err", "G", "MoC", "HII"}


def _fetch(query: str, count_query: str, dest: Path, refresh: bool) -> pd.DataFrame:
    """One synchronous query (MAXREC raised; SIMBAD silently truncates at 50,000 rows otherwise),
    checked against a COUNT(*) of the same selection."""
    if dest.exists() and not refresh:
        return pd.read_csv(dest, dtype=str, keep_default_na=False)
    expected = int(tap_sync(TAP, count_query)["n"].iloc[0])
    if expected >= MAXREC:
        raise RuntimeError(f"SIMBAD query would return {expected} rows (> MAXREC); page it")
    for attempt in range(3):
        df = tap_sync(TAP, query, maxrec=MAXREC, timeout=1800)
        # counts can drift by a few rows while SIMBAD is being updated
        if abs(len(df) - expected) <= max(50, expected // 1000):
            break
        log.warning("SIMBAD returned %d rows, expected %d; retrying", len(df), expected)
    else:
        raise RuntimeError(f"SIMBAD query incomplete: {len(df)} of {expected} rows")
    dest.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(dest, index=False)
    log.info("SIMBAD: fetched %d rows into %s", len(df), dest.name)
    return df


def load(refresh: bool = False) -> tuple[pd.DataFrame, pd.DataFrame]:
    basic = _fetch(BASIC_QUERY, BASIC_COUNT, BASIC_FILE, refresh)
    ident = _fetch(IDENT_QUERY, IDENT_COUNT, IDENT_FILE, refresh)
    basic["oid"] = pd.to_numeric(basic["oid"]).astype("int64")
    basic["main_id"] = basic["main_id"].str.replace(r"\s+", " ", regex=True).str.strip()
    basic = basic[~basic["otype"].isin(NON_STELLAR)].reset_index(drop=True)
    ident["oidref"] = pd.to_numeric(ident["oidref"]).astype("int64")
    ident["id"] = ident["id"].str.replace(r"\s+", " ", regex=True).str.strip()
    ident = ident[ident["oidref"].isin(basic["oid"])].reset_index(drop=True)
    log.info("SIMBAD: %d objects, %d identifiers", len(basic), len(ident))
    return basic, ident


def attach(stars: pd.DataFrame, basic: pd.DataFrame, ident: pd.DataFrame) -> tuple[dict[int, list[str]], pd.DataFrame]:
    """Map SIMBAD objects onto star rows via Gaia DR3 id or HIP number, and the remaining nearby
    stars by position.

    Returns ({row index: [identifier, ...]}, per-row frame with main_id, otype, sp_type, wds and
    simbad_match: "gaia", "hip" or "pos").
    """
    gaia = ident[ident["id"].str.startswith("Gaia DR3 ")]
    g_oid = pd.Series(gaia["oidref"].to_numpy(), index=exact_int64(gaia["id"].str.slice(9)))
    g_oid = g_oid[~g_oid.index.duplicated(keep=False)]
    hip = ident[ident["id"].str.match(r"^HIP \d+$")]
    h_oid = pd.Series(hip["oidref"].to_numpy(), index=pd.to_numeric(hip["id"].str.slice(4)).astype("int64"))
    h_oid = h_oid[~h_oid.index.duplicated(keep=False)]

    row_oid = np.full(len(stars), -1, dtype=np.int64)
    sg = stars["gaia"].astype("Int64")
    m = sg.isin(g_oid.index).to_numpy()
    row_oid[m] = g_oid.loc[sg[m]].to_numpy()
    sh = stars["hip"].astype("Int64")
    m2 = (row_oid < 0) & sh.isin(h_oid.index).to_numpy()
    row_oid[m2] = h_oid.loc[sh[m2]].to_numpy()
    # Gaia id and HIP number name different SIMBAD objects (often a component and its system):
    # keep the Gaia match unless it is another component than the 20 pc census says the star is
    # (census "zeta Her A" with the Gaia source SIMBAD lists as "* zet Her B")
    both = np.nonzero(m & sh.isin(h_oid.index).to_numpy())[0]
    if len(both) and "census_name" in stars:
        h_both = h_oid.loc[sh.iloc[both]].to_numpy()
        differ = h_both != row_oid[both]
        census_letters = _census_letter_check(stars, ident, basic)
        switched = 0
        for i, o_h in zip(both[differ], h_both[differ]):
            if not census_letters(int(i), int(row_oid[i])) and census_letters(int(i), int(o_h)):
                row_oid[i] = o_h
                m[i] = False
                m2[i] = True
                switched += 1
        log.info("SIMBAD: %d stars matched by HIP instead of a Gaia id that SIMBAD gives another component", switched)
    # Remaining nearby stars (brown dwarfs and others without Gaia DR3 / HIP ids) by position:
    # SIMBAD coordinates are ICRS at epoch J2000; our rows carry their own epoch and proper motion.
    pos_matched = rejected = 0
    plx = stars["plx"].to_numpy(float)
    todo = np.nonzero((row_oid < 0) & (plx > MIN_PLX * 0.9))[0]
    taken = set(int(v) for v in row_oid[row_oid >= 0])
    cand = basic[~basic["oid"].isin(taken)].copy()
    cand["ra_f"] = pd.to_numeric(cand["ra"], errors="coerce")
    cand["dec_f"] = pd.to_numeric(cand["dec"], errors="coerce")
    cand = cand.dropna(subset=["ra_f", "dec_f"])
    if len(todo) and len(cand):
        tree = cKDTree(unit_vectors(cand["ra_f"].to_numpy(), cand["dec_f"].to_numpy()))
        ra, dec = propagate(
            stars["ra"].to_numpy(float)[todo], stars["dec"].to_numpy(float)[todo],
            stars["pmra"].to_numpy(float)[todo], stars["pmdec"].to_numpy(float)[todo],
            2000.0 - stars["epoch"].to_numpy(float)[todo],
        )
        # SIMBAD positions of fast-moving objects are often at their observation epoch rather than
        # propagated to J2000 (WISE 0855-0714 moves 8"/yr), so the radius grows with the proper motion;
        # matches beyond 3" additionally need a consistent SIMBAD parallax.
        pm_tot = np.nan_to_num(np.hypot(stars["pmra"].to_numpy(float)[todo], stars["pmdec"].to_numpy(float)[todo]))
        radius = (3.0 + np.clip(pm_tot / 1000.0 * 15.0, 0.0, 120.0)) / 206264.806
        dist, k = tree.query(unit_vectors(ra, dec), k=4, distance_upper_bound=float(radius.max()))
        cplx = pd.to_numeric(cand["plx_value"], errors="coerce").to_numpy()
        coid = cand["oid"].to_numpy()
        consistent = _consistency_check(stars, ident, basic)
        for j, i in enumerate(todo):
            for d_, k_ in zip(dist[j], k[j]):
                if not np.isfinite(d_) or d_ > radius[j]:
                    continue
                p_s = cplx[k_]
                if np.isfinite(p_s):
                    if abs(p_s - plx[i]) > 0.2 * plx[i]:
                        continue
                elif d_ > 3.0 / 206264.806:
                    continue
                o = int(coid[k_])
                if o in taken:
                    continue
                # the neighbour of a companion is often the other component: the object must not
                # carry other catalogue numbers or another component letter than the star itself
                if not consistent(int(i), o):
                    rejected += 1
                    continue
                row_oid[i] = o
                taken.add(o)
                pos_matched += 1
                break
    log.info("SIMBAD: %d further stars matched by position (%d inconsistent neighbours rejected)", pos_matched, rejected)
    pos = np.zeros(len(stars), bool)
    pos[[i for i in todo if row_oid[i] >= 0]] = True

    # one SIMBAD object per star row (if two rows claim the same object, the first wins)
    seen: set[int] = set()
    for i in np.nonzero(row_oid >= 0)[0]:
        if row_oid[i] in seen:
            row_oid[i] = -1
        else:
            seen.add(int(row_oid[i]))
    log.info("SIMBAD: %d stars matched (%d by Gaia DR3 id, %d by HIP)", int((row_oid >= 0).sum()), int(m.sum()), int(m2.sum()))

    useful = ident[~ident["id"].str.match(NOISE)]
    by_oid = useful.groupby("oidref")["id"].apply(list)
    idents: dict[int, list[str]] = {}
    for i in np.nonzero(row_oid >= 0)[0]:
        lst = by_oid.get(int(row_oid[i]))
        if lst:
            idents[int(i)] = lst
    b = basic.set_index("oid")
    info = pd.DataFrame(index=stars.index)
    ok = row_oid >= 0
    info["simbad_main_id"] = None
    info["simbad_otype"] = None
    info["simbad_sp_type"] = None
    info["wds"] = None
    info["simbad_match"] = None
    info.loc[ok & m, "simbad_match"] = "gaia"
    info.loc[ok & m2, "simbad_match"] = "hip"
    info.loc[ok & pos, "simbad_match"] = "pos"
    wds = ident[ident["id"].str.match(r"^WDS J\d{5}[+-]\d{4}")]
    wds_of = pd.Series(wds["id"].str.extract(r"^WDS (J\d{5}[+-]\d{4})")[0].to_numpy(), index=wds["oidref"].to_numpy())
    wds_of = wds_of[~wds_of.index.duplicated()]
    info.loc[ok, "wds"] = wds_of.reindex(row_oid[ok]).to_numpy()
    sub = b.loc[row_oid[ok]]
    info.loc[ok, "simbad_main_id"] = sub["main_id"].str.replace(r"\s+", " ", regex=True).to_numpy()
    info.loc[ok, "simbad_otype"] = sub["otype"].to_numpy()
    info.loc[ok, "simbad_sp_type"] = sub["sp_type"].replace("", None).to_numpy()
    return idents, info


def _census_letter_check(stars: pd.DataFrame, ident: pd.DataFrame, basic: pd.DataFrame):
    """f(row, oid) -> False if the SIMBAD object is another component than the star's census
    designation says ("* zet Her B" for the census star "zeta Her A")."""
    from ..naming import contradicts, lettered_designations  # naming does not import the sources

    main = dict(zip(basic["oid"].to_numpy(), basic["main_id"].to_numpy()))
    lettered = ident[ident["id"].str.contains(r"(?:\s|\d)[A-H][a-c]?$", regex=True)]
    obj_lettered = lettered.groupby("oidref")["id"].apply(list).to_dict()
    cols = [c for c in ("census_name", "census_gj", "catalog_names") if c in stars]
    values = {c: stars[c].to_numpy(dtype=object) for c in cols}

    def check(i: int, o: int) -> bool:
        own = lettered_designations({c: values[c][i] for c in cols}, census_only=True)
        if not own:
            return True
        mid = main.get(o)
        return not any(contradicts(x, own) for x in ([mid] if isinstance(mid, str) else []) + obj_lettered.get(o, []))

    return check


def _consistency_check(stars: pd.DataFrame, ident: pd.DataFrame, basic: pd.DataFrame):
    """f(row, oid) -> False if the SIMBAD object contradicts the star's own HD / HIP / Gaia DR3 /
    Gliese numbers or its component letter (Algieba B must not get "* gam01 Leo" = HD 89484,
    Wolf 1130 C not "Wolf 1130 B")."""
    from ..naming import component_letter, contradicts, lettered_designations  # naming does not import the sources

    d = ident["id"].str.extract(_DESIG)
    ok = d[0].notna().to_numpy()
    obj: dict[int, list[tuple[str, str, str | None]]] = {}
    for o, cat, num, let in zip(ident["oidref"].to_numpy()[ok], d[0][ok], d[1][ok], d[2][ok]):
        cat = "GJ" if cat == "Gl" else cat
        obj.setdefault(int(o), []).append((cat, re.sub(r"\.0$", "", num), let if isinstance(let, str) else None))
    # identifiers that end in a component letter ("Wolf 1130 B", "* alf Com A", "HD 73752A")
    lettered = ident[ident["id"].str.contains(r"(?:\s|\d)[A-H][a-c]?$", regex=True)]
    obj_lettered = lettered.groupby("oidref")["id"].apply(list).to_dict()
    main = dict(zip(basic["oid"].to_numpy(), basic["main_id"].to_numpy()))
    cols = [c for c in ("census_name", "system_size", "system_row", "census_gj", "gj", "hyg_base", "hyg_comp", "catalog_names") if c in stars]
    values = {c: stars[c].to_numpy(dtype=object) for c in cols}

    def num(v) -> str | None:
        return str(int(v)) if pd.notna(v) else None

    hd = stars["hd"].to_numpy(dtype=object) if "hd" in stars else np.full(len(stars), None)
    hip = stars["hip"].to_numpy(dtype=object)
    gaia = stars["gaia"].to_numpy(dtype=object)

    def check(i: int, o: int) -> bool:
        row = {c: values[c][i] for c in cols}
        letter = component_letter(row)
        own = lettered_designations(row)
        mid = main.get(o)
        for x in ([mid] if isinstance(mid, str) else []) + obj_lettered.get(o, []):
            if contradicts(x, own):
                return False
        gj_num = gj_let = None
        for key in ("census_gj", "gj"):
            g = row.get(key)
            if isinstance(g, str):
                mg = re.fullmatch(r"\s*(?:GJ|Gl|Gliese)\s*(\d+(?:\.\d+)?)\s*([A-H][a-c]?)?\s*", g)
                if mg:
                    gj_num, gj_let = re.sub(r"\.0$", "", mg.group(1)), mg.group(2)
                    break
        lst = obj.get(o, [])
        for cat, own, own_let in (
            ("HD", num(hd[i]), letter),
            ("HIP", num(hip[i]), None),
            ("Gaia DR3", num(gaia[i]), None),
            ("GJ", gj_num, gj_let or letter),
        ):
            if own is None:
                continue
            same = [(n, lt) for c, n, lt in lst if c == cat]
            if not same:
                continue
            hits = [lt for n, lt in same if n == own]
            if not hits:
                return False
            if own_let and all(lt and letters_conflict(lt, own_let) for lt in hits):
                return False
        return True

    return check
