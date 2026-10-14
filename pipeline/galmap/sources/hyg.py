"""HYG v4.4 (D. Nash / astronexus, CC BY-SA 4.0).

AT-HYG already contains every HYG row (joined through the `hyg` id). We read HYG only for
the fields AT-HYG lacks: variable-star designations and the Gliese multiple-system grouping
(`base`, `comp`).
"""

from __future__ import annotations

import pandas as pd

from ..download import CACHE_DIR, fetch

URL = "https://codeberg.org/astronexus/hyg/media/commit/53e3df311869e813ace5f1ad2ec4ce909f13256c/data/hyg/CURRENT/hyg_v44.csv.gz"
SHA256 = "00b349893b9a53106dd488d8371e8d2fa586043e500bb3cdb8bff3931682197d"
FILE = CACHE_DIR / "hyg" / "hyg_v44.csv.gz"

SOURCE_INFO = {
    "key": "hyg",
    "title": "HYG Database v4.4",
    "citation": "D. Nash, The Astronomy Nexus (Hipparcos, Yale Bright Star and Gliese catalogues).",
    "url": "https://codeberg.org/astronexus/hyg",
    "license": "CC BY-SA 4.0",
}

COMP_LETTER = {1: "A", 2: "B", 3: "C", 4: "D"}


def load(refresh: bool = False) -> pd.DataFrame:
    path = fetch(URL, FILE, sha256=SHA256, refresh=refresh)
    df = pd.read_csv(
        path,
        usecols=["id", "gl", "con", "var", "base", "comp", "comp_primary", "proper"],
        dtype=str,
        keep_default_na=False,
        encoding="utf-8",
    )
    df["id"] = pd.to_numeric(df["id"]).astype("Int64")
    df["comp"] = pd.to_numeric(df["comp"], errors="coerce").astype("Int64")
    df["base"] = df["base"].str.split().str.join(" ").replace("", pd.NA)
    df["var"] = df["var"].replace("", pd.NA)
    df = df.rename(columns={"id": "hyg", "var": "hyg_var", "base": "hyg_base", "comp": "hyg_comp", "proper": "hyg_proper"})
    return df[["hyg", "hyg_var", "hyg_base", "hyg_comp", "hyg_proper"]]
