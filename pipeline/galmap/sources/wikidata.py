"""Wikidata: English and German Wikipedia article titles of stars.

The Wikipedia article title is the best available measure of which name of a star is most
commonly used ("Epsilon Eridani" rather than the newer IAU name "Ran"), and the German
Wikipedia provides the German names ("Wega", "Barnards Pfeilstern").

We query all items that have a SIMBAD identifier (P3083) and an English or German Wikipedia
article, with their labels, HIP / Gaia DR3 numbers and classes (P31). Many articles about
multiple stars are on items without a SIMBAD identifier ("40 Eridani", "Gliese 229"), so a second
query adds the items of a stellar class without one, with their catalogue codes (P528). The
public Wikidata query service often times out on such queries, so we use the QLever SPARQL
engine (University of Freiburg), which answers them in a few seconds.

Only article titles count as Wikipedia names; labels of items without an article in that
language are ordinary name candidates. Nebulae, clusters, galaxies and planets are dropped
(their HIP codes would otherwise put "Eskimo Nebula" on the central star). Items are matched to
our stars in passes: SIMBAD main identifier first, then Gaia DR3 id, then HIP number, then the
HD / HR / Gliese / Bayer / Flamsteed catalogue codes.
"""

from __future__ import annotations

import io
import logging
import re

import numpy as np
import pandas as pd

from ..download import CACHE_DIR, session
from ..names import GREEK, designation_key

log = logging.getLogger(__name__)

ENDPOINT = "https://qlever.dev/api/wikidata"
# v2: with the P31 classes (the v1 file without them is left alone)
FILE = CACHE_DIR / "wikidata" / "wikidata_stars_v2.csv"
MIN_ROWS = 15_000
# items of a stellar class without a SIMBAD identifier, with their catalogue codes
SYSTEMS_FILE = CACHE_DIR / "wikidata" / "wikidata_star_systems_v1.csv"
SYSTEMS_MIN_ROWS = 300

SOURCE_INFO = {
    "key": "wikidata",
    "title": "Wikidata / Wikipedia article titles",
    "citation": "Wikidata (https://www.wikidata.org), queried with QLever (University of Freiburg).",
    "url": "https://www.wikidata.org/",
    "license": "CC0 1.0",
}

QUERY = """
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX p: <http://www.wikidata.org/prop/>
PREFIX ps: <http://www.wikidata.org/prop/statement/>
PREFIX pq: <http://www.wikidata.org/prop/qualifier/>
PREFIX schema: <http://schema.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?item (GROUP_CONCAT(DISTINCT ?s; SEPARATOR="|") AS ?simbad) (SAMPLE(?en) AS ?entitle) (SAMPLE(?de) AS ?detitle)
       (SAMPLE(?el) AS ?enlabel) (SAMPLE(?dl) AS ?delabel) (SAMPLE(?ml) AS ?mullabel)
       (GROUP_CONCAT(DISTINCT ?hip; SEPARATOR="|") AS ?hips) (GROUP_CONCAT(DISTINCT ?gaia; SEPARATOR="|") AS ?gaias)
       (GROUP_CONCAT(DISTINCT STR(?cls); SEPARATOR="|") AS ?classes)
WHERE {
  ?item wdt:P3083 ?s .
  OPTIONAL { ?a schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?en . }
  OPTIONAL { ?b schema:about ?item ; schema:isPartOf <https://de.wikipedia.org/> ; schema:name ?de . }
  FILTER(BOUND(?en) || BOUND(?de))
  OPTIONAL { ?item rdfs:label ?el . FILTER(LANG(?el) = "en") }
  OPTIONAL { ?item rdfs:label ?dl . FILTER(LANG(?dl) = "de") }
  OPTIONAL { ?item rdfs:label ?ml . FILTER(LANG(?ml) = "mul") }
  OPTIONAL { ?item p:P528 ?st1 . ?st1 pq:P972 wd:Q537199 ; ps:P528 ?hip . }
  OPTIONAL { ?item p:P528 ?st3 . ?st3 pq:P972 wd:Q66061041 ; ps:P528 ?gaia . }
  OPTIONAL { ?item wdt:P31 ?cls . }
}
GROUP BY ?item
"""

# Classes (P31) of items that are not stars, although they carry a SIMBAD id and sometimes the
# HIP number of a star in them: nebulae, clusters and associations, galaxies, planets, ...
NON_STELLAR_CLASSES = {
    # nebulae and interstellar matter
    "Q42372", "Q13632", "Q2035809", "Q11282", "Q202265", "Q203958", "Q204194", "Q854857", "Q2722426",
    "Q207436", "Q2318940", "Q41872", "Q272447", "Q1054444", "Q3346004", "Q50048", "Q27150479",
    "Q1621824",
    # star clusters, associations, moving groups, streams, asterisms
    "Q168845", "Q11387", "Q11276", "Q736194", "Q921336", "Q12046080", "Q935337", "Q9262", "Q650001",
    "Q882646", "Q72803708", "Q56425403",
    # galaxies and beyond
    "Q318", "Q2488", "Q192078", "Q184348", "Q72802508", "Q71965638", "Q217012", "Q644507", "Q46587",
    "Q195577", "Q1151284", "Q83373", "Q115518", "Q71965429", "Q28738741", "Q190397", "Q204107",
    "Q2490", "Q213930", "Q190438", "Q195385", "Q1491746", "Q1284344", "Q726611", "Q654754", "Q221221",
    "Q27521", "Q3272595", "Q752374", "Q65259218", "Q211301", "Q2495", "Q195724", "Q3757442", "Q308492",
    "Q845371", "Q2743798", "Q1565388", "Q53403265", "Q234077", "Q2557101", "Q1133705", "Q15922837",
    "Q14515149", "Q2311038",
    # planets and moons
    "Q44559", "Q18611609", "Q327757", "Q382979", "Q97359320", "Q83148567", "Q3388369", "Q420490",
    "Q115772494", "Q634",
    # not an object
    "Q4167410", "Q15623926", "Q7936582", "Q1369227", "Q82794", "Q185243", "Q912471",
}
# Classes of stars and star systems. An item with one of them is a star even if it also has a
# non-stellar class (Wikidata calls the white dwarf G 117-B15A a galaxy, FG Sagittae a planetary nebula).
STELLAR_CLASSES = {
    "Q523", "Q5871", "Q101600", "Q6243", "Q13890", "Q50053", "Q878367", "Q1993624", "Q1457376", "Q2247863",
    "Q2088753", "Q595871", "Q5893", "Q497654", "Q6232", "Q1044693", "Q120621195", "Q6251", "Q72803622",
    "Q353834", "Q1153690", "Q744691", "Q565309", "Q5864", "Q1353952", "Q471805", "Q767432", "Q863936",
    "Q50081", "Q5898", "Q1048372", "Q193599", "Q12795622", "Q3132741", "Q1062509", "Q285400", "Q797219",
    "Q1392913", "Q1362543", "Q2168098", "Q24452", "Q1141942", "Q836976", "Q10451997", "Q616386", "Q130019",
    "Q451152", "Q812800", "Q1142192", "Q66521853", "Q11853210", "Q43001876", "Q1059564", "Q5875", "Q6227",
    "Q5881", "Q244393", "Q11878917", "Q24039974", "Q1073768", "Q6220", "Q54231557", "Q67511102", "Q136562",
    "Q3037794", "Q978297", "Q14745284", "Q995268", "Q1007122", "Q14745279", "Q1103085", "Q112881",
}
# titles that name a nebula, a cluster or a galaxy rather than a star ("NGC 2392", but not the
# cluster star "NGC 2423-3")
NON_STELLAR_TITLE = re.compile(
    r"(nebula|nebel\b|cluster|haufen\b|galax|\bassociation\b|assoziation\b|\bmoving group\b|"
    r"^(?:NGC|IC|M|Messier|Sh ?2-|LDN|Barnard)\s?\d+$)",
    re.IGNORECASE,
)


SYSTEMS_QUERY = """
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX schema: <http://schema.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?item (SAMPLE(?en) AS ?entitle) (SAMPLE(?de) AS ?detitle)
       (SAMPLE(?el) AS ?enlabel) (SAMPLE(?dl) AS ?delabel) (SAMPLE(?ml) AS ?mullabel)
       (GROUP_CONCAT(DISTINCT ?code; SEPARATOR="|") AS ?codes)
       (GROUP_CONCAT(DISTINCT STR(?cls); SEPARATOR="|") AS ?classes)
WHERE {
  { SELECT DISTINCT ?item WHERE {
      VALUES ?c0 { %s }
      ?item wdt:P31 ?c0 .
      { ?a0 schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . } UNION
      { ?b0 schema:about ?item ; schema:isPartOf <https://de.wikipedia.org/> . }
      MINUS { ?item wdt:P3083 ?s . }
  } }
  OPTIONAL { ?a schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?en . }
  OPTIONAL { ?b schema:about ?item ; schema:isPartOf <https://de.wikipedia.org/> ; schema:name ?de . }
  OPTIONAL { ?item rdfs:label ?el . FILTER(LANG(?el) = "en") }
  OPTIONAL { ?item rdfs:label ?dl . FILTER(LANG(?dl) = "de") }
  OPTIONAL { ?item rdfs:label ?ml . FILTER(LANG(?ml) = "mul") }
  OPTIONAL { ?item wdt:P528 ?code . }
  OPTIONAL { ?item wdt:P31 ?cls . }
}
GROUP BY ?item
"""


def _fetch(refresh: bool, query: str = QUERY, file=FILE, min_rows: int = MIN_ROWS) -> pd.DataFrame:
    if file.exists() and not refresh:
        return pd.read_csv(file, dtype=str, keep_default_na=False)
    r = session().post(ENDPOINT, data={"query": query}, headers={"Accept": "text/csv"}, timeout=600)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.content.decode("utf-8")), dtype=str, keep_default_na=False)
    if len(df) < min_rows:
        raise RuntimeError(f"Wikidata query returned only {len(df)} rows")
    file.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(file, index=False)
    return df


def _fetch_systems(refresh: bool) -> pd.DataFrame:
    """Items of a stellar class without a SIMBAD identifier, in the frame of the main query
    (simbad empty, hips / gaias from the catalogue codes) plus their codes."""
    query = SYSTEMS_QUERY % " ".join(f"wd:{c}" for c in sorted(STELLAR_CLASSES))
    df = _fetch(refresh, query, SYSTEMS_FILE, SYSTEMS_MIN_ROWS)
    df["simbad"] = ""
    df["hips"] = df["codes"].map(lambda v: "|".join(x for x in v.split("|") if re.fullmatch(r"HIP \d+", x)))
    df["gaias"] = df["codes"].map(lambda v: "|".join(x for x in v.split("|") if re.fullmatch(r"Gaia DR3 \d+", x)))
    return df


def _clean(v) -> str | None:
    v = (v or "").strip() if isinstance(v, str) else ""
    return v or None


def is_stellar(classes: list[str], titles: list[str | None] = ()) -> bool:
    """False for items that are nebulae, clusters, galaxies, planets etc.: a non-stellar class and
    no stellar one, or a title that names a nebula, cluster or galaxy."""
    if NON_STELLAR_CLASSES.intersection(classes) and not STELLAR_CLASSES.intersection(classes):
        return False
    return not any(is_nonstellar_title(t) for t in titles)


def is_nonstellar_title(title: str | None) -> bool:
    return isinstance(title, str) and bool(NON_STELLAR_TITLE.search(title))


def load(refresh: bool = False) -> pd.DataFrame:
    """One row per Wikidata item: qid, simbad (list), en / de (article titles or None),
    en_label / de_label (labels of items without an article in that language), hip (list of int),
    gaia (list of int), stellar (False for items of a non-stellar class: nebulae, clusters,
    galaxies, planets). Titles and labels that name a nebula, cluster or galaxy are removed, and
    items left without any are dropped."""
    df = _fetch(refresh)
    df["codes"] = ""
    try:
        df = pd.concat([df, _fetch_systems(refresh)], ignore_index=True)
    except Exception as err:  # the second query only adds a few hundred multiple stars
        log.warning("Wikidata: star systems without SIMBAD id unavailable: %s", err)
    classes = df["classes"].map(lambda v: [c.rsplit("/", 1)[-1] for c in v.split("|") if c]) if "classes" in df else pd.Series([[]] * len(df))
    en = df["entitle"].map(_clean)
    de = df["detitle"].map(_clean)
    en_label = [None if t else (_clean(a) or _clean(b)) for t, a, b in zip(en, df["enlabel"], df["mullabel"])]
    de_label = [None if t else _clean(a) for t, a in zip(de, df["delabel"])]

    def guard(v):
        return None if is_nonstellar_title(v) else v

    out = pd.DataFrame(
        {
            "qid": df["item"].str.rsplit("/", n=1).str[-1],
            "simbad": df["simbad"].map(lambda v: [re.sub(r"\s+", " ", x).strip() for x in v.split("|") if x.strip()]),
            "en": en.map(guard),
            "de": de.map(guard),
            "en_label": [guard(v) for v in en_label],
            "de_label": [guard(v) for v in de_label],
            "hip": df["hips"].map(lambda v: [int(m) for m in re.findall(r"HIP\s*(\d+)", v)]),
            "gaia": df["gaias"].map(lambda v: [int(m) for m in re.findall(r"Gaia DR3\s*(\d+)", v)]),
            "stellar": [is_stellar(c) for c in classes],
            "codes": df["codes"].map(lambda v: [x.strip() for x in v.split("|") if x.strip()]),
        }
    )
    named = out[["en", "de", "en_label", "de_label"]].notna().any(axis=1)
    # a nebula title on an item without a stellar class: the item is the nebula ("Eskimo Nebula")
    nebula = [
        any(is_nonstellar_title(v) for v in (a, b, c, d)) and not STELLAR_CLASSES.intersection(cl)
        for a, b, c, d, cl in zip(en, de, en_label, de_label, classes)
    ]
    keep = named.to_numpy() & ~pd.Series(nebula).to_numpy()
    log.info(
        "Wikidata: %d items with an English or German Wikipedia article (%d of them not stellar; %d nebulae etc. dropped)",
        int(keep.sum()), int((keep & ~out["stellar"].to_numpy()).sum()), len(out) - int(keep.sum()),
    )
    return out[keep].reset_index(drop=True)


_GREEK_CHARS = dict(zip("αβγδεζηθικλμνξοπρστυφχψω", (
    "alf", "bet", "gam", "del", "eps", "zet", "eta", "tet", "iot", "kap", "lam", "mu", "nu", "ksi", "omi", "pi",
    "rho", "sig", "sig", "tau", "ups", "phi", "chi", "psi", "ome",
)))
_CODE = re.compile(r"^(?:GJ|Gl|Gliese|Wo)\s*\d|^\d{1,3}\s+[A-Z][A-Za-z]{2}$|^[a-zA-Z]{1,3}\d{0,2}\s+[A-Z][A-Za-z]{2}$")


def code_key(code: str) -> str | None:
    """designation_key of a Wikidata catalogue code that names a star or system: 'GJ 166',
    '40 Eri', 'ο² Eri' (Greek letters as in Wikidata); None for other catalogues."""
    c = code.strip()
    if c and c[0] in _GREEK_CHARS:
        c = _GREEK_CHARS[c[0]] + c[1:].translate(str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹", "0123456789"))
    if not _CODE.match(c):
        return None
    word = re.match(r"^[a-zA-Z]*", c).group(0)
    if word and not re.match(r"^(?:GJ|Gl|Gliese|Wo)\s*\d", c) and len(word) > 1 and word.lower() not in GREEK:
        return None  # not a Bayer letter ("ADS 123")
    return designation_key(c)


def _row_strings(stars: pd.DataFrame, idents: dict[int, list[str]] | None):
    """(row, designation) of the stars' SIMBAD identifiers, census names and Gliese numbers."""
    for col in ("simbad_main_id", "census_name", "census_gj", "gj"):
        if col in stars:
            arr = stars[col].to_numpy(dtype=object)
            for i in np.nonzero(pd.notna(arr))[0]:
                if isinstance(arr[i], str):
                    yield int(i), arr[i]
    if "catalog_names" in stars:
        for i, v in enumerate(stars["catalog_names"].to_numpy(dtype=object)):
            if isinstance(v, (list, tuple, np.ndarray)):
                for x in v:
                    if isinstance(x, str):
                        yield i, x
    for i, lst in (idents or {}).items():
        for x in lst:
            yield int(i), x


def attach(stars: pd.DataFrame, wd: pd.DataFrame, idents: dict[int, list[str]] | None = None) -> dict[int, dict]:
    """Row index -> {"wiki_en", "wiki_de", "label_en", "label_de"} (None where missing).

    Each item names one star and each star gets one item. Matches are made in passes, so that an
    exact SIMBAD main-identifier match is never taken away by a looser one: first by SIMBAD main
    identifier, then by Gaia DR3 id, then by HIP number, then (items without SIMBAD id) by HD /
    HR number and Gliese / Bayer / Flamsteed codes against the stars' designations (idents: the
    SIMBAD identifiers of the rows). Items of a non-stellar class (a nebula or a planet that
    carries the HIP number of its star) are matched only by SIMBAD identifier."""
    by_simbad: dict[str, int] = {}
    by_gaia: dict[int, int] = {}
    by_hip: dict[int, int] = {}
    stellar = wd["stellar"].to_numpy(dtype=bool) if "stellar" in wd else np.ones(len(wd), bool)
    for k, row in enumerate(wd.itertuples(index=False)):
        for s in row.simbad:
            by_simbad.setdefault(s, k)
        if not stellar[k]:
            continue
        for g in row.gaia:
            by_gaia.setdefault(g, k)
        for h in row.hip:
            by_hip.setdefault(h, k)
    n = len(stars)
    main_id = stars["simbad_main_id"].to_numpy(dtype=object) if "simbad_main_id" in stars else [None] * n
    gaia = stars["gaia"].astype("Int64").to_numpy(dtype=object)
    hip = stars["hip"].astype("Int64").to_numpy(dtype=object)
    item_of: dict[int, int] = {}
    used: set[int] = set()
    counts = []

    def run(key_of, table) -> None:
        c = 0
        for i in range(n):
            if i in item_of:
                continue
            key = key_of(i)
            if key is None:
                continue
            k = table.get(key)
            if k is None or k in used:
                continue
            item_of[i] = k
            used.add(k)
            c += 1
        counts.append(c)

    run(lambda i: main_id[i] if isinstance(main_id[i], str) else None, by_simbad)
    run(lambda i: int(gaia[i]) if pd.notna(gaia[i]) else None, by_gaia)
    run(lambda i: int(hip[i]) if pd.notna(hip[i]) else None, by_hip)
    counts.append(_attach_by_codes(stars, wd, idents, item_of, used, stellar))
    out: dict[int, dict] = {}
    cols = ("en", "de", "en_label", "de_label")
    keys = ("wiki_en", "wiki_de", "label_en", "label_de")
    for i, k in item_of.items():
        r = wd.iloc[k]
        out[i] = {key: (r[c] if isinstance(r[c], str) and r[c] else None) for key, c in zip(keys, cols)}
    log.info("Wikidata: %d stars matched (%d by SIMBAD id, %d by Gaia DR3, %d by HIP, %d by catalogue code)", len(out), *counts)
    return out


def _attach_by_codes(stars, wd, idents, item_of: dict[int, int], used: set[int], stellar) -> int:
    """Pass 4 of attach(): the remaining stellar items with catalogue codes."""
    if "codes" not in wd:
        return 0
    todo = [k for k, cs in enumerate(wd["codes"]) if k not in used and stellar[k] and len(cs)]
    if not todo:
        return 0
    flags = stars["flags"].to_numpy(np.int64) if "flags" in stars else np.zeros(len(stars), np.int64)

    def column_index(col: str) -> dict[int, list[int]]:
        out: dict[int, list[int]] = {}
        if col in stars:
            for i, v in enumerate(stars[col].to_numpy(dtype=object)):
                if pd.notna(v):
                    out.setdefault(int(v), []).append(i)
        return out

    by_hd, by_hr = column_index("hd"), column_index("hr")
    item_keys: dict[int, list[str]] = {}
    for k in todo:
        keys = [code_key(c) for c in wd["codes"].iloc[k]]
        item_keys[k] = [x for x in dict.fromkeys(keys) if x]
    wanted = {x + sfx for ks in item_keys.values() for x in ks for sfx in ("", "a", "aa")}
    first = {re.match(r"[a-z]+|\d+", x).group(0) for x in wanted if re.match(r"[a-z]+|\d+", x)}
    rows_of: dict[str, list[int]] = {}
    for i, x in _row_strings(stars, idents):
        s = re.sub(r"^V?\*+\s*", "", x.strip())
        w = re.match(r"[A-Za-z]+|\d+", s)
        if not w:
            continue
        w = w.group(0).lower()
        if w not in first and GREEK.get(w, ("",))[0].lower() not in first:
            continue
        key = designation_key(x)
        if key in wanted:
            lst = rows_of.setdefault(key, [])
            if i not in lst:
                lst.append(i)
    n = 0
    for k in todo:
        cand: list[int] = []
        for c in wd["codes"].iloc[k]:
            m = re.fullmatch(r"(HD|HR)\s*(\d+)", c.strip())
            if m:
                cand += (by_hd if m.group(1) == "HD" else by_hr).get(int(m.group(2)), [])
        for sfx in ("", "a", "aa"):
            for x in item_keys[k]:
                cand += rows_of.get(x + sfx, [])
        cand = [i for i in dict.fromkeys(cand) if i not in item_of]
        if not cand:
            continue
        # a system's article goes to its primary
        i = min(cand, key=lambda j: (0 if flags[j] & 8 else 1, cand.index(j)))
        item_of[i] = k
        used.add(k)
        n += 1
    return n
