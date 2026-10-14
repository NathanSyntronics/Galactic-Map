"""IAU Catalog of Star Names (Working Group on Star Names, WGSN).

The current list is only published as an HTML table on the WGSN's site exopla.net
(the export buttons are client-side JavaScript), so we parse the table.
"""

from __future__ import annotations

import logging
import re
from html.parser import HTMLParser

import pandas as pd

from ..download import CACHE_DIR, fetch

log = logging.getLogger(__name__)

URL = "https://exopla.net/star-names/modern-iau-star-names/"
FILE = CACHE_DIR / "iau_wgsn" / "modern-iau-star-names.html"
NEC_URL = "https://exopla.net/wp-content/uploads/2025/05/NEC.csv"
NEC_FILE = CACHE_DIR / "iau_wgsn" / "NEC.csv"
FAINTS_URL = "https://exopla.net/wp-content/uploads/2025/05/wgsnFaints.csv"
FAINTS_FILE = CACHE_DIR / "iau_wgsn" / "wgsnFaints.csv"
MIN_ROWS = 600

SOURCE_INFO = {
    "key": "iau",
    "title": "IAU Catalog of Star Names",
    "citation": "IAU Working Group on Star Names (WGSN)",
    "url": URL,
    "license": "IAU: CC BY 4.0 (with attribution)",
}


class _TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[dict] = []
        self.cur: dict | None = None
        self.row: list[str] | None = None
        self.cell: list[str] | None = None
        self.sect: str | None = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "table":
            self.cur = {"id": a.get("id"), "head": [], "body": []}
            self.tables.append(self.cur)
        elif tag in ("thead", "tbody", "tfoot"):
            self.sect = {"thead": "head", "tbody": "body", "tfoot": "foot"}[tag]
        elif tag == "tr" and self.cur is not None:
            self.row = []
            if self.sect in ("head", "body"):
                self.cur[self.sect].append(self.row)
        elif tag in ("td", "th") and self.row is not None:
            self.cell = []
        elif tag == "br" and self.cell is not None:
            self.cell.append(" ")

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None and self.row is not None:
            self.row.append(re.sub(r"\s+", " ", "".join(self.cell)).strip())
            self.cell = None
        elif tag in ("thead", "tbody", "tfoot"):
            self.sect = None

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)


def load(refresh: bool = False) -> pd.DataFrame:
    """Columns: name, hip (Int64), designation, nec (Int64)."""
    path = fetch(URL, FILE, refresh=refresh)
    p = _TableParser()
    p.feed(path.read_text(encoding="utf-8"))
    tables = [t for t in p.tables if t["id"] == "table_1"]
    if not tables or not tables[0]["head"]:
        raise RuntimeError("IAU star name table not found – page layout changed?")
    t = tables[0]
    hdr = t["head"][0]
    rows = [r for r in t["body"] if len(r) == len(hdr)]
    if len(rows) < MIN_ROWS:
        raise RuntimeError(f"IAU star name table has only {len(rows)} rows – page layout changed?")
    df = pd.DataFrame(rows, columns=hdr)
    out = pd.DataFrame(
        {
            "name": df["proper names"].str.strip(),
            "hip": pd.to_numeric(df["HIP"], errors="coerce").astype("Int64"),
            "designation": df["Designation"].str.strip(),
            "nec": pd.to_numeric(df["NEC+"], errors="coerce").astype("Int64"),
        }
    )
    # Fill missing HIP numbers through the WGSN NEC / Faints catalogues.
    try:
        nec = pd.read_csv(fetch(NEC_URL, NEC_FILE, refresh=refresh), dtype=str, keep_default_na=False)
        nec_hip = dict(
            zip(pd.to_numeric(nec["NEC"], errors="coerce"), pd.to_numeric(nec["HIP"].str.replace("HIP", "").str.strip(), errors="coerce"))
        )
        faint = pd.read_csv(fetch(FAINTS_URL, FAINTS_FILE, refresh=refresh), dtype=str, keep_default_na=False)
        faint_hip = dict(
            zip(
                pd.to_numeric(faint.iloc[:, 0], errors="coerce"),
                pd.to_numeric(faint["HIP"].str.replace("HIP", "").str.strip(), errors="coerce"),
            )
        )
        lookup = {**nec_hip, **faint_hip}
        miss = out["hip"].isna() & out["nec"].notna()
        out.loc[miss, "hip"] = [
            int(lookup[n]) if n in lookup and pd.notna(lookup[n]) else pd.NA for n in out.loc[miss, "nec"]
        ]
    except Exception as err:  # the NEC files are only a convenience
        log.warning("could not use WGSN NEC tables: %s", err)
    log.info("IAU names: %d (%d with HIP)", len(out), out["hip"].notna().sum())
    return out
