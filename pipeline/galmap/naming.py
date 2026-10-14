"""Choosing display names (English and German), alternative designations and the primary designation."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .flags import Desig, Flag, Rank
from .names import (
    CONSTELLATIONS,
    bayer_name,
    classify_name,
    constellation,
    expand_abbreviated,
    flamsteed_name,
    german_variant,
    parse_hyg_bayer,
    prettify_simbad,
    strip_disambiguation,
)

log = logging.getLogger(__name__)

# A few famous stars whose German name differs (used when no Wikipedia title is available).
GERMAN_NAMES = {
    "Sun": "Sonne",
    "Vega": "Wega",
    "Betelgeuse": "Beteigeuze",
    "Procyon": "Prokyon",
    "Altair": "Atair",
    "Arcturus": "Arktur",
    "Polaris": "Polarstern",
    "Barnard's Star": "Barnards Pfeilstern",
}

# source priority for equal ranks (lower wins)
P_IAU, P_WIKI, P_CENSUS, P_SIMBAD, P_ATHYG, P_GENERATED, P_ID = range(7)

_COMP_RE = re.compile(r"\s([A-H][a-c]?)$")


@dataclass
class Cand:
    en: str
    de: str | None
    rank: int
    prio: int


def german_of(en: str) -> str | None:
    """German form of an English name, if it differs (generic rules)."""
    if en in GERMAN_NAMES:
        return GERMAN_NAMES[en]
    g = german_variant(en)
    if g:
        return g
    m = re.fullmatch(r"(.+?)'s Star( [A-H])?", en)
    if m:
        owner = m.group(1)
        sep = "' " if owner[-1] in "sxzß" else "s "
        return f"{owner}{sep}Stern" + (m.group(2) or "")
    return None


def gliese_display(gj: str | None) -> str | None:
    """SIMBAD-form 'GJ 551 A' -> 'Gliese 551 A'; numbers >= 1000 stay 'GJ 1061'."""
    if not isinstance(gj, str):
        return None
    m = re.fullmatch(r"\s*(?:GJ|Gl|Gliese)\s*(\d+)(\.\d+)?\s*([A-D][a-c]?)?\s*", gj)
    if not m:
        return gj.strip() or None
    num, frac, comp = m.group(1), m.group(2) or "", m.group(3)
    prefix = "Gliese" if int(num) < 1000 else "GJ"
    return f"{prefix} {num}{frac}" + (f" {comp}" if comp else "")


def component_letter(row) -> str | None:
    """Component letter of a star that is a member of a multiple system (A, B, Ba, ...)."""
    name = row.get("census_name")
    if isinstance(name, str) and (row.get("system_size") or 0) > 1:
        m = _COMP_RE.search(name)
        if m:
            return m.group(1)
    for key in ("census_gj", "gj"):
        g = row.get(key)
        if isinstance(g, str):
            m = re.search(r"\d\s*([A-D])$", g.strip())
            if m:
                return m.group(1)
    if pd.notna(row.get("hyg_base")) and pd.notna(row.get("hyg_comp")):
        return {1: "A", 2: "B", 3: "C", 4: "D"}.get(int(row["hyg_comp"]))
    return None


def _with_comp(name: str | None, comp: str | None) -> str | None:
    if not name or not comp:
        return name
    if _COMP_RE.search(name):
        return name
    return f"{name} {comp}"


def candidates(row, ext: dict) -> list[Cand]:
    """All name candidates of one star.

    ext: external names for this star: {"iau": str, "wiki_en": str, "wiki_de": str,
    "simbad": [ident, ...]}.
    """
    out: list[Cand] = []
    comp = component_letter(row)
    in_system = (int(row.get("flags", 0)) & Flag.IN_SYSTEM) != 0 or comp is not None

    def add(en, rank, prio, de=None):
        if isinstance(en, str) and en.strip():
            en = en.strip()
            out.append(Cand(en, de if de and de != en else german_of(en), rank, prio))

    def add_text(text, prio, max_rank=Rank.SURVEY, force_rank=None):
        """Add a free-text name (expanding abbreviated Bayer/Flamsteed forms like 'tau Cet')."""
        if not isinstance(text, str) or not text.strip():
            return
        t = re.sub(r"^NAME\s+", "", text.strip())
        t = re.sub(r"\s*\(([A-Za-z]{1,3})\)\s*$", "", t).strip()
        full = expand_abbreviated(t)
        if full:
            add(full, classify_name(full), prio, expand_abbreviated(t, "de"))
            return
        r = force_rank if force_rank is not None else classify_name(t)
        if r <= max_rank:
            add(t, r, prio)

    if ext.get("iau"):
        add(ext["iau"], Rank.IAU, P_IAU)
    if ext.get("wiki_en"):
        en = strip_disambiguation(ext["wiki_en"])
        de = strip_disambiguation(ext["wiki_de"]) if ext.get("wiki_de") else None
        r = classify_name(en)
        add(en, r, P_WIKI, de)
    cn = row.get("common_name")
    if isinstance(cn, str):
        for part in cn.split("|"):
            add_text(part, P_CENSUS)
    proper = row.get("proper")
    if isinstance(proper, str) and proper != "Sol":
        add_text(proper, P_ATHYG)
    for ident in ext.get("simbad", []) or []:
        p = prettify_simbad(ident)
        if p:
            de = prettify_simbad(ident, "de")
            r = classify_name(p)
            if r <= Rank.SURVEY:
                add(p, r, P_SIMBAD, de)
        else:
            add_text(ident, P_SIMBAD)
    bf = row.get("bayer_flamsteed")
    if isinstance(bf, str):
        for ident in bf.split("|"):
            p = prettify_simbad(ident.strip())
            if p:
                pde = prettify_simbad(ident.strip(), "de")
                add(_with_comp(p, comp if in_system else None), classify_name(p), P_CENSUS, _with_comp(pde, comp if in_system else None))
    con = row.get("con")
    b = parse_hyg_bayer(row.get("bayer"))
    if b and constellation(con):
        letter, idx = b
        if len(letter) == 1 and letter.islower():  # Latin Bayer letter, e.g. "p Eridani"
            en = f"{letter} {CONSTELLATIONS[constellation(con)]}"
            de = en
        else:
            en = bayer_name(letter, con, idx, None, "en")
            de = bayer_name(letter, con, idx, None, "de")
        if en:
            c = comp if (in_system and not idx) else None
            add(_with_comp(en, c), Rank.BAYER, P_GENERATED, _with_comp(de, c))
    flam = row.get("flam")
    if pd.notna(flam) and constellation(con):
        en = flamsteed_name(int(flam), con)
        add(_with_comp(en, comp if in_system else None), Rank.FLAMSTEED, P_GENERATED)
    var = row.get("hyg_var")
    if isinstance(var, str) and constellation(con):
        b2 = parse_hyg_bayer(var)
        if not (b2 and b2[0].lower() in ("alp", "bet", "gam", "del", "eps", "zet", "eta", "the", "iot", "kap", "lam", "mu", "nu", "xi", "omi", "pi", "rho", "sig", "tau", "ups", "phi", "chi", "psi", "ome")):
            add(f"{var} {CONSTELLATIONS[constellation(con)]}", Rank.VARIABLE, P_GENERATED)
    vn = row.get("var_name")
    if isinstance(vn, str):
        p = prettify_simbad(vn if vn.startswith("V*") else f"V* {vn}")
        if p:
            add(p, Rank.VARIABLE, P_CENSUS)
    cat_names = row.get("catalog_names")
    for nm in cat_names if isinstance(cat_names, (list, tuple)) else []:
        add_text(nm, P_CENSUS)
    cname = row.get("census_name")
    if isinstance(cname, str):
        add_text(cname, P_CENSUS)
    gj = gliese_display(row.get("census_gj") or row.get("gj"))
    if gj:
        add(gj, Rank.GJ, P_GENERATED)
    return out


def choose(cands: list[Cand]) -> tuple[Cand | None, list[str]]:
    """The English Wikipedia title is taken as the most commonly used name (if it is a name and
    not a bare catalogue number); otherwise the IAU name; otherwise the best-ranked candidate."""
    if not cands:
        return None, []
    wiki = [c for c in cands if c.prio == P_WIKI and c.rank <= Rank.SURVEY]
    iau = [c for c in cands if c.prio == P_IAU]
    if wiki:
        best = wiki[0]
        # keep the IAU name if Wikipedia only offers a catalogue-style title
        if iau and best.rank >= Rank.GJ:
            best = iau[0]
    else:
        best = min(cands, key=lambda c: (c.rank, c.prio, len(c.en)))
    seen = {best.en.lower()}
    alts = []
    for c in sorted(cands, key=lambda c: (c.rank, c.prio)):
        k = c.en.lower()
        if k not in seen:
            seen.add(k)
            alts.append(c.en)
    return best, alts


def catalogue_designations(row) -> list[tuple[int, str]]:
    out = []
    if pd.notna(row.get("hr")):
        out.append((Rank.HR, f"HR {int(row['hr'])}"))
    if pd.notna(row.get("hip")):
        out.append((Rank.HIP, f"HIP {int(row['hip'])}"))
    if pd.notna(row.get("hd")):
        out.append((Rank.HD, f"HD {int(row['hd'])}"))
    if isinstance(row.get("tyc"), str):
        out.append((Rank.TYC, f"TYC {row['tyc']}"))
    if pd.notna(row.get("gaia")):
        out.append((Rank.GAIA, f"Gaia DR3 {int(row['gaia'])}"))
    m2 = row.get("name_2mass")
    if isinstance(m2, str) and m2:
        out.append((Rank.OTHER, f"2MASS J{m2}" if not m2.startswith("2MASS") else m2))
    return out


def primary_designation(row) -> tuple[int, int, int, str | None]:
    """(desig_cat, lo, hi, string) following the rank order HR > HIP > HD > TYC > Gaia > other."""
    if pd.notna(row.get("hr")):
        return Desig.HR, int(row["hr"]), 0, None
    if pd.notna(row.get("hip")):
        return Desig.HIP, int(row["hip"]), 0, None
    if pd.notna(row.get("hd")):
        return Desig.HD, int(row["hd"]), 0, None
    tyc = row.get("tyc")
    if isinstance(tyc, str):
        m = re.fullmatch(r"(\d+)-(\d+)-(\d+)", tyc.strip())
        if m:
            t1, t2, t3 = (int(v) for v in m.groups())
            return Desig.TYC, t1 | (t2 << 16), t3, None
    if pd.notna(row.get("gaia")):
        g = int(row["gaia"])
        return Desig.GAIA_DR3, g & 0xFFFFFFFF, g >> 32, None
    for key in ("census_name", "name_2mass"):
        v = row.get(key)
        if isinstance(v, str) and v:
            return Desig.STRING, 0, 0, (f"2MASS J{v}" if key == "name_2mass" and not v.startswith("2MASS") else v)
    return Desig.STRING, 0, 0, None


def assign_names(s: pd.DataFrame, external: dict[int, dict]) -> pd.DataFrame:
    """Adds name_rank, name_en, name_de, alt, desig_* and system_name_* columns.

    external: row index -> {"iau": ..., "wiki_en": ..., "wiki_de": ..., "simbad": [...]}.
    """
    s = s.copy()
    n = len(s)
    name_rank = np.full(n, Rank.NONE, dtype=np.int64)
    name_en = np.full(n, None, dtype=object)
    name_de = np.full(n, None, dtype=object)
    alt = np.full(n, None, dtype=object)
    sys_en = np.full(n, None, dtype=object)
    sys_de = np.full(n, None, dtype=object)

    has_name_fields = np.zeros(n, bool)
    for c in ("proper", "bayer", "flam", "hyg_var", "gj", "census_name", "common_name", "var_name", "census_gj"):
        if c in s:
            has_name_fields |= s[c].notna().to_numpy()
    has_name_fields |= s.index.isin(list(external.keys()))
    rows = np.nonzero(has_name_fields)[0]
    log.info("naming: %d stars with name candidates", len(rows))
    cols = list(s.columns)
    values = s.to_numpy(dtype=object)
    ci = {c: k for k, c in enumerate(cols)}

    class RowView(dict):
        pass

    def row_of(i):
        r = RowView()
        v = values[i]
        for c, k in ci.items():
            r[c] = v[k]
        return r

    bayer_sys: dict[int, tuple[str, str | None]] = {}
    for i in rows:
        r = row_of(i)
        cands = candidates(r, external.get(int(s.index[i]), {}))
        best, alts = choose(cands)
        desigs = [d for _, d in catalogue_designations(r)]
        cname = r.get("census_name")
        if (best is None or best.rank > Rank.NAMED_MAX) and isinstance(cname, str) and cname != "Sun":
            # objects of the 20 pc census are listed (and searchable) under their census designation
            best = Cand(cname, None, Rank.SURVEY, P_CENSUS)
        if best is not None and best.rank <= Rank.NAMED_MAX:
            name_rank[i] = best.rank
            name_en[i] = best.en
            name_de[i] = best.de if best.de and best.de != best.en else None
            more = [a for a in alts if a != best.en] + [d for d in desigs if d not in alts]
            alt[i] = more[:10] or None
        else:
            alts2 = [a for a in alts] + desigs
            alt[i] = alts2[:10] or None
        # system naming material: Bayer / Flamsteed without component
        sid = int(r.get("system_id", -1)) if pd.notna(r.get("system_id", -1)) else -1
        if sid >= 0:
            for c in cands:
                if c.rank in (Rank.BAYER, Rank.FLAMSTEED):
                    base_en = re.sub(r"[⁰¹²³⁴⁵⁶⁷⁸⁹]+", "", _COMP_RE.sub("", c.en))
                    base_de = re.sub(r"[⁰¹²³⁴⁵⁶⁷⁸⁹]+", "", _COMP_RE.sub("", c.de)) if c.de else None
                    prev = bayer_sys.get(sid)
                    if prev is None or (c.rank == Rank.BAYER and classify_name(prev[0]) != Rank.BAYER):
                        bayer_sys[sid] = (base_en, base_de)

    # Components of a named system: "Sirius B", "Procyon B", "Groombridge 34 B".
    if "system_id" in s:
        sid_arr = s["system_id"].to_numpy()
        flags0 = s["flags"].to_numpy(np.int64)
        comp_of = {}
        for i in rows:
            if sid_arr[i] >= 0:
                c = component_letter(row_of(i))
                if c:
                    comp_of[i] = c
        prim_name: dict[int, tuple[str, str | None, int]] = {}
        for i in np.nonzero((flags0 & Flag.SYSTEM_PRIMARY) != 0)[0]:
            if name_en[i] and name_rank[i] <= Rank.TRADITIONAL:
                prim_name[int(sid_arr[i])] = (_COMP_RE.sub("", name_en[i]), _COMP_RE.sub("", name_de[i]) if name_de[i] else None, int(name_rank[i]))
        renamed = 0
        for i, c in comp_of.items():
            k = int(sid_arr[i])
            if k not in prim_name:
                continue
            base_en, base_de, base_rank = prim_name[k]
            if (flags0[i] & Flag.SYSTEM_PRIMARY) and name_en[i] and _COMP_RE.sub("", name_en[i]) == base_en:
                continue
            if name_rank[i] > base_rank or name_en[i] is None:
                old = name_en[i]
                name_en[i] = f"{base_en} {c}"
                name_de[i] = f"{base_de} {c}" if base_de else None
                name_rank[i] = min(base_rank, Rank.COMMON) if base_rank <= Rank.COMMON else base_rank
                if old and old != name_en[i]:
                    alt[i] = [old] + [a for a in (alt[i] or []) if a != old and a != name_en[i]][:9]
                renamed += 1
        log.info("naming: %d system components named after their primary", renamed)

    s["name_rank"] = name_rank
    s["name_en"] = name_en
    s["name_de"] = name_de
    s["alt"] = alt
    flags = s["flags"].to_numpy(np.int64).copy()
    flags |= np.where(name_rank <= Rank.VARIABLE, Flag.NAMED, 0)
    s["flags"] = flags

    # system names
    if "system_id" in s:
        sid = s["system_id"].to_numpy()
        prim = np.nonzero((flags & Flag.SYSTEM_PRIMARY) != 0)[0]
        named_members = pd.Series(name_rank <= Rank.COMMON).groupby(sid).sum()
        for i in prim:
            k = int(sid[i])
            en, de = name_en[i], name_de[i]
            if en and name_rank[i] <= Rank.COMMON and named_members.get(k, 0) <= 1 and not _COMP_RE.search(en):
                sys_en[i], sys_de[i] = en, de
            elif k in bayer_sys:
                sys_en[i], sys_de[i] = bayer_sys[k]
            elif en:
                sys_en[i] = _COMP_RE.sub("", en)
                sys_de[i] = _COMP_RE.sub("", de) if de else None
            else:
                d = primary_designation(row_of(i))
                sys_en[i] = d[3] if d[3] else None
        s["system_name_en"] = sys_en
        s["system_name_de"] = sys_de

    # primary designations
    dc = np.zeros(n, np.int64)
    dlo = np.zeros(n, np.int64)
    dhi = np.zeros(n, np.int64)
    dstr = np.full(n, None, dtype=object)
    hr = s["hr"].to_numpy(dtype=object) if "hr" in s else np.full(n, pd.NA)
    hip = s["hip"].to_numpy(dtype=object)
    hd = s["hd"].to_numpy(dtype=object) if "hd" in s else np.full(n, pd.NA)
    tyc = s["tyc"].to_numpy(dtype=object) if "tyc" in s else np.full(n, None)
    gaia = s["gaia"].to_numpy(dtype=object)
    simple = np.ones(n, bool)
    for i in range(n):
        if pd.notna(hr[i]):
            dc[i], dlo[i] = Desig.HR, int(hr[i])
        elif pd.notna(hip[i]):
            dc[i], dlo[i] = Desig.HIP, int(hip[i])
        elif pd.notna(hd[i]):
            dc[i], dlo[i] = Desig.HD, int(hd[i])
        elif isinstance(tyc[i], str) and re.fullmatch(r"\d+-\d+-\d+", tyc[i]):
            t1, t2, t3 = (int(v) for v in tyc[i].split("-"))
            dc[i], dlo[i], dhi[i] = Desig.TYC, t1 | (t2 << 16), t3
        elif pd.notna(gaia[i]):
            g = int(gaia[i])
            dc[i], dlo[i], dhi[i] = Desig.GAIA_DR3, g & 0xFFFFFFFF, g >> 32
        else:
            simple[i] = False
    for i in np.nonzero(~simple)[0]:
        c, lo, hi, st = primary_designation(row_of(i))
        dc[i], dlo[i], dhi[i], dstr[i] = c, lo, hi, st
    # Stars known only by a Gaia number get their SIMBAD main identifier (e.g. "LP 816-60") instead.
    if "simbad_main_id" in s:
        mid = s["simbad_main_id"].to_numpy(dtype=object)
        swapped = 0
        for i in np.nonzero((dc == Desig.GAIA_DR3) & pd.notna(mid))[0]:
            m = str(mid[i]).strip()
            if m and not m.startswith("Gaia") and classify_name(m) <= Rank.SURVEY:
                dc[i], dlo[i], dhi[i], dstr[i] = Desig.STRING, 0, 0, m
                swapped += 1
        log.info("naming: %d Gaia-only stars designated by their SIMBAD identifier", swapped)
    s["desig_cat"] = dc
    s["desig_lo"] = dlo
    s["desig_hi"] = dhi
    s["desig_str"] = dstr
    log.info(
        "naming: %d stars named; %d IAU names, %d common, %d Bayer, %d Flamsteed",
        int((name_rank <= Rank.NAMED_MAX).sum()),
        int((name_rank == Rank.IAU).sum()),
        int((name_rank == Rank.COMMON).sum()),
        int((name_rank == Rank.BAYER).sum()),
        int((name_rank == Rank.FLAMSTEED).sum()),
    )
    return s
