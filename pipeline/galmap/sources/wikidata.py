"""Wikidata: English and German Wikipedia article titles of stars.

The Wikipedia article title is the best available measure of which name of a star is most
commonly used ("Epsilon Eridani" rather than the newer IAU name "Ran"), and the German
Wikipedia provides the German names ("Wega", "Barnards Pfeilstern").

We query all items that have a SIMBAD identifier (P3083) and an English or German Wikipedia
article. The public Wikidata query service often times out on such queries, so we use the
QLever SPARQL engine (University of Freiburg), which answers this one in a few seconds.
Matching to our stars is done through the SIMBAD main identifier, Gaia DR3 id or HIP number.
"""

from __future__ import annotations

import io
import logging
import re

import pandas as pd

from ..download import CACHE_DIR, session

log = logging.getLogger(__name__)

ENDPOINT = "https://qlever.dev/api/wikidata"
FILE = CACHE_DIR / "wikidata" / "wikidata_stars.csv"
MIN_ROWS = 15_000

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
}
GROUP BY ?item
"""


def _fetch(refresh: bool) -> pd.DataFrame:
    if FILE.exists() and not refresh:
        return pd.read_csv(FILE, dtype=str, keep_default_na=False)
    r = session().post(ENDPOINT, data={"query": QUERY}, headers={"Accept": "text/csv"}, timeout=600)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.content.decode("utf-8")), dtype=str, keep_default_na=False)
    if len(df) < MIN_ROWS:
        raise RuntimeError(f"Wikidata query returned only {len(df)} rows")
    FILE.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(FILE, index=False)
    return df


def load(refresh: bool = False) -> pd.DataFrame:
    """One row per Wikidata item: qid, simbad (list), en, de, hip (list of int), gaia (list of int)."""
    df = _fetch(refresh)

    def clean(v: str) -> str | None:
        v = (v or "").strip()
        return v or None

    out = pd.DataFrame(
        {
            "qid": df["item"].str.rsplit("/", n=1).str[-1],
            "simbad": df["simbad"].map(lambda v: [re.sub(r"\s+", " ", x).strip() for x in v.split("|") if x.strip()]),
            "en": [clean(a) or clean(b) or clean(c) for a, b, c in zip(df["entitle"], df["enlabel"], df["mullabel"])],
            "en_is_title": df["entitle"].str.strip() != "",
            "de": [clean(a) or clean(b) for a, b in zip(df["detitle"], df["delabel"])],
            "hip": df["hips"].map(lambda v: [int(m) for m in re.findall(r"HIP\s*(\d+)", v)]),
            "gaia": df["gaias"].map(lambda v: [int(m) for m in re.findall(r"Gaia DR3\s*(\d+)", v)]),
        }
    )
    log.info("Wikidata: %d items with an English or German Wikipedia article", len(out))
    return out


def attach(stars: pd.DataFrame, wd: pd.DataFrame) -> dict[int, dict]:
    """Row index -> {"wiki_en": ..., "wiki_de": ...}, matched by SIMBAD main id, Gaia DR3 id, HIP."""
    by_simbad: dict[str, int] = {}
    by_gaia: dict[int, int] = {}
    by_hip: dict[int, int] = {}
    for k, row in enumerate(wd.itertuples(index=False)):
        for s in row.simbad:
            by_simbad.setdefault(s, k)
        for g in row.gaia:
            by_gaia.setdefault(g, k)
        for h in row.hip:
            by_hip.setdefault(h, k)
    out: dict[int, dict] = {}
    main_id = stars["simbad_main_id"].to_numpy(dtype=object) if "simbad_main_id" in stars else [None] * len(stars)
    gaia = stars["gaia"].astype("Int64").to_numpy(dtype=object)
    hip = stars["hip"].astype("Int64").to_numpy(dtype=object)
    used: set[int] = set()
    n_s = n_g = n_h = 0
    for i in range(len(stars)):
        k = None
        m = main_id[i]
        if isinstance(m, str) and m in by_simbad:
            k = by_simbad[m]
            n_s += 1
        elif pd.notna(gaia[i]) and int(gaia[i]) in by_gaia:
            k = by_gaia[int(gaia[i])]
            n_g += 1
        elif pd.notna(hip[i]) and int(hip[i]) in by_hip:
            k = by_hip[int(hip[i])]
            n_h += 1
        if k is None or k in used:
            continue
        used.add(k)
        r = wd.iloc[k]
        # missing titles come back as NaN from the pandas string dtype
        out[i] = {k: (v if isinstance(v, str) and v else None) for k, v in (("wiki_en", r["en"]), ("wiki_de", r["de"]))}
    log.info("Wikidata: %d stars matched (%d by SIMBAD id, %d by Gaia DR3, %d by HIP)", len(out), n_s, n_g, n_h)
    return out
