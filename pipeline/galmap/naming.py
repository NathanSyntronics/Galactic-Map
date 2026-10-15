"""Choosing display names (English and German), alternative designations and the primary designation.

English display name (see choose()):
  1. the English Wikipedia article title, when it is a name or a designation up to the survey
     rank ("Epsilon Eridani", "Gliese 436", "Luyten 726-8"); the IAU name only wins when the title
     is the IAU name itself or the IAU name plus a component letter ("Sirius A");
  2. otherwise the IAU name;
  3. otherwise the best-ranked candidate (flags.Rank: Bayer, Flamsteed, historical catalogue
     names, variable-star names, Gliese, survey numbers), ties broken by source and order.
German display name (see german_name()): the German article title when it is not a worse kind of
name than the English one or is the same designation in German; otherwise the German form of the
English name ("My Cephei", "Barnards Pfeilstern").
Components of multiple systems are named after the primary ("Sirius B") unless they have a name of
their own (Wikipedia, IAU, SIMBAD common name), and no name is given twice within a system.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .flags import Desig, Flag, Rank
from .names import (
    COMPONENT,
    CONSTELLATIONS,
    bayer_name,
    classify_name,
    classify_title,
    clean_title,
    constellation,
    designation_key,
    english_greek,
    expand_abbreviated,
    flamsteed_name,
    german_variant,
    latin_bayer_letters,
    letters_conflict,
    normalize_bayer,
    parse_hyg_bayer,
    prettify_simbad,
    split_component,
    split_component_loose,
    superscript,
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
P_IAU, P_WIKI, P_CENSUS, P_SIMBAD, P_LABEL, P_ATHYG, P_GENERATED, P_ID = range(8)

# names that are a star's own and are never replaced by "<primary> <letter>": Wikipedia titles,
# IAU names and SIMBAD common names ("NAME ...")
PROTECTED_SOURCES = {"iau", "wiki", "simbad_name"}

_COMP_RE = re.compile(rf"\s({COMPONENT})$")
_SUP_RE = re.compile(r"[⁰¹²³⁴⁵⁶⁷⁸⁹]+")


@dataclass
class Cand:
    en: str
    de: str | None
    rank: int
    prio: int
    seq: int = 0
    # where the name comes from: iau, wiki, simbad_name, simbad, census, label, athyg, generated
    src: str = ""


def german_of(en: str) -> str | None:
    """German form of an English name, if it differs (generic rules)."""
    base, comp = split_component(en)
    if base in GERMAN_NAMES:
        return GERMAN_NAMES[base] + (f" {comp}" if comp else "")
    g = german_variant(en)
    if g:
        return g
    m = re.fullmatch(r"(.+?)'s Star( [A-H])?", en)
    if m:
        owner = m.group(1)
        sep = "' " if owner[-1] in "sxzß" else "s "
        return f"{owner}{sep}Stern" + (m.group(2) or "")
    return None


def _fold(name: str) -> str:
    """Accent- and case-insensitive form of a name ("Krüger" == "Kruger", "Tau¹" == "Tau1")."""
    return "".join(ch for ch in unicodedata.normalize("NFKD", name) if not unicodedata.combining(ch)).lower()


def gliese_display(gj: str | None) -> str | None:
    """SIMBAD-form 'GJ 551 A' -> 'Gliese 551 A'; numbers >= 1000 stay 'GJ 1061'."""
    if not isinstance(gj, str):
        return None
    m = re.fullmatch(r"\s*(?:GJ|Gl|Gliese)\s*(\d+)(\.\d+)?\s*([A-D][a-c]?)?\s*", gj)
    if not m:
        return gj.strip() or None
    num, frac, comp = m.group(1), m.group(2) or "", m.group(3)
    if frac == ".0":  # "GJ 721.0" is the same object as "GJ 721"
        frac = ""
    prefix = "Gliese" if int(num) < 1000 else "GJ"
    return f"{prefix} {num}{frac}" + (f" {comp}" if comp else "")


def _gj_number(g) -> tuple[str, str | None] | None:
    """'GJ 765.4 A' -> ('765.4', 'A'), 'Gl 721.0' -> ('721', None)."""
    if not isinstance(g, str):
        return None
    m = re.fullmatch(r"\s*(?:GJ|Gl|Gliese)\s*(\d+(?:\.\d+)?)\s*([A-D][a-c]?)?\s*", g)
    if not m:
        return None
    return re.sub(r"\.0$", "", m.group(1)), m.group(2)


def component_letter(row) -> str | None:
    """Component letter of a star that is a member of a multiple system (A, B, Ba, ...)."""
    fam = letter_family(row)
    return fam[2] if fam else None


def letter_family(row) -> tuple[str, object, str] | None:
    """(source, key, letter) of a star's component letter: the census designation it belongs to,
    its Gliese number or its HYG system. Letters of different families are unrelated: "GJ 765.4 A"
    and "GJ 767.1 A" are both "A", and the census "G 96-29 A" is Capella H, not Capella A."""
    name = _census_core(row.get("census_name"))
    size = row.get("system_size")
    if name and pd.notna(size) and float(size) > 1:
        m = re.search(r"\s([A-H][a-c]?)$", name)
        if m:
            return ("census", (_int_or_none(row.get("system_row")), designation_key(name[: m.start()])), m.group(1))
    for key in ("census_gj", "gj"):
        g = row.get(key)
        if isinstance(g, str):
            m = re.search(r"\d\s*([A-D])$", g.strip())
            if m:
                num = _gj_number(g)
                return ("gj", num[0] if num else g.strip()[: -1].strip(), m.group(1))
    if pd.notna(row.get("hyg_base")) and pd.notna(row.get("hyg_comp")):
        c = {1: "A", 2: "B", 3: "C", 4: "D"}.get(int(row["hyg_comp"]))
        if c:
            return ("hyg", row.get("hyg_base"), c)
    return None


def _families(row) -> dict[str, object]:
    """All designation families of a star (see letter_family)."""
    out: dict[str, object] = {}
    name = _census_core(row.get("census_name"))
    if name and pd.notna(row.get("system_row")):
        out["census"] = (_int_or_none(row.get("system_row")), designation_key(split_component(name)[0]))
    for key in ("census_gj", "gj"):
        num = _gj_number(row.get(key))
        if num:
            out["gj"] = num[0]
            break
    if pd.notna(row.get("hyg_base")):
        out["hyg"] = row.get("hyg_base")
    return out


def _census_core(name) -> str | None:
    """A census designation without nickname and notes: 'YY Gem A (alpha Gem C)' -> 'YY Gem A',
    'G 96-29 A "Capella H"' -> 'G 96-29 A', '2MASS J0700+3157 [C]' -> '2MASS J0700+3157 C'."""
    if not isinstance(name, str):
        return None
    return _clean_text(re.sub(r'\s*"[^"]*"', "", name))


def _int_or_none(v):
    try:
        return int(v) if pd.notna(v) else None
    except (TypeError, ValueError):
        return None


def lettered_designations(row, census_only: bool = False) -> dict[str, str]:
    """The star's own designations with a component letter, as designation_key(base) -> letter:
    census name and catalogue names, the Gliese number ('Wolf 1130 C' -> {'wolf1130': 'C'}).
    A SIMBAD alias with the same base and another letter belongs to another component."""
    names = []
    for key in ("census_name", "census_gj") + (() if census_only else ("gj",)):
        if isinstance(row.get(key), str):
            names.append(row.get(key))
    cat = row.get("catalog_names")
    if isinstance(cat, (list, tuple, np.ndarray)):
        names.extend(x for x in cat if isinstance(x, str))
    out: dict[str, str] = {}
    for nm in names:
        t = _clean_text(re.sub(r'\s*"[^"]*"', "", nm))
        if not t:
            continue
        base, letter = split_component_loose(gliese_display(t) if re.match(r"(GJ|Gl)\s*\d", t) else t)
        k = designation_key(base) if letter else None
        if k:
            out.setdefault(k, letter)
    return out


def contradicts(ident: str, own: dict[str, str]) -> bool:
    """True if a (SIMBAD) designation names another component of one of the star's own lettered
    designations ('GJ 1001 C' for the star 'GJ 1001 B')."""
    if not own:
        return False
    base, letter = _ident_letter(ident)
    if not letter:
        return False
    k = designation_key(base)
    return k in own and letters_conflict(letter, own[k])


def confirms(ident: str, own: dict[str, str]) -> bool:
    """True if a (SIMBAD) designation is one of the star's own lettered designations with a
    compatible letter ('GJ 1001 BC' for the star 'GJ 1001 B')."""
    if not own:
        return False
    base, letter = _ident_letter(ident)
    if not letter:
        return False
    k = designation_key(base)
    return k in own and not letters_conflict(letter, own[k])


def _ident_letter(ident: str) -> tuple[str, str | None]:
    """Base and component letter of a SIMBAD identifier: '* alf Com A' -> ('Alpha Comae Berenices', 'A'),
    'HD 73752A' -> ('HD 73752', 'A'), 'NAME Castor C' -> ('Castor', 'C')."""
    s = ident.strip()
    if s.startswith("**"):  # double-star catalogue codes: "** STF 1110C"
        s = re.sub(r"^\*\*\s*", "", s)
    p = prettify_simbad(s) or re.sub(r"^(?:NAME|HIDDEN NAME)\s+", "", s)
    return split_component_loose(p)


def _with_comp(name: str | None, comp: str | None) -> str | None:
    if not name or not comp:
        return name
    if _COMP_RE.search(name):
        return name
    return f"{name} {comp}"


def _spaced_letter(name: str) -> str:
    """'BD-22 2345A' -> 'BD-22 2345 A', 'Ross 614B' -> 'Ross 614 B' (the usual spacing, and needed to
    recognise the letter)."""
    base, letter = split_component_loose(name)
    if letter and not name.endswith(f" {letter}"):
        return f"{base} {letter}"
    return name


def _clean_text(text: str) -> str | None:
    """A free-text name from the census or a label without notes: 'Mothallah (A?)' -> 'Mothallah',
    'YY Gem A (alpha Gem C)' -> 'YY Gem A', '2MASS J0700+3157 [C]' -> '2MASS J0700+3157 C',
    'NAME I Boo*' -> 'NAME I Boo'."""
    t = re.sub(r"\s+", " ", text.strip())
    m = re.fullmatch(rf"(.+?)\s*\[({COMPONENT})\]", t)
    if m:
        t = f"{m.group(1)} {m.group(2)}"
    t = re.sub(r"\s*\([^()]*\)$", "", t).strip()
    return re.sub(r"\s*\*+$", "", t).strip() or None


def census_display(cname: str) -> str:
    """The census designation of an object without a name, readable: 'YY Gem A (alpha Gem C)' ->
    'YY Geminorum A', 'DENIS-P J0205.4-1159 [C]' -> 'DENIS-P J0205.4-1159 C', '** WJG 5C' -> 'WJG 5C'."""
    t = re.sub(r'\s*"[^"]*"', "", cname).strip()
    t = _clean_text(t) or t
    t = re.sub(r"^\*\*\s+", "", t)
    return prettify_simbad(t) or expand_abbreviated(t) or t


def latin_letters(row, ext: dict) -> set[tuple[str, str]]:
    """Latin-letter Bayer designations of a star (lowercase 'f Eridani' vs. capital 'P Cygni')."""
    idents = list(ext.get("simbad") or [])
    mid = row.get("simbad_main_id")
    if isinstance(mid, str):
        idents.append(mid)
    bf = row.get("bayer_flamsteed")
    if isinstance(bf, str):
        idents.extend(bf.split("|"))
    out = latin_bayer_letters(idents)
    b = parse_hyg_bayer(row.get("bayer"))
    con = constellation(row.get("con"))
    if b and con and len(b[0]) == 1:
        out.add((b[0], con))
    return out


def candidates(row, ext: dict) -> list[Cand]:
    """All name candidates of one star.

    ext: external names for this star: {"iau": str, "wiki_en": str, "wiki_de": str,
    "label_en": str, "label_de": str, "simbad": [ident, ...]}.
    """
    out: list[Cand] = []
    comp = component_letter(row)
    in_system = (int(row.get("flags", 0)) & Flag.IN_SYSTEM) != 0 or comp is not None
    latin = latin_letters(row, ext)

    def add(en, prio, de=None, src="", rank=None, title=False, max_rank=Rank.OTHER):
        if not isinstance(en, str) or not en.strip():
            return
        en = _spaced_letter(normalize_bayer(re.sub(r"\s+", " ", en.strip()), latin))
        de = _spaced_letter(normalize_bayer(de.strip(), latin)) if isinstance(de, str) and de.strip() else None
        r = rank if rank is not None else (classify_title(en) if title else classify_name(en))
        if r > max_rank:
            return
        if r == Rank.GJ:  # "GJ 1" -> "Gliese 1" (the usual form for the original Gliese numbers)
            en = gliese_display(en) or en
            de = None
        out.append(Cand(en, de if de and de != en else german_of(en), r, prio, len(out), src))

    def add_text(text, prio, src, max_rank=Rank.SURVEY):
        """Add a free-text name (expanding abbreviated Bayer/Flamsteed forms like 'tau Cet')."""
        if not isinstance(text, str) or not text.strip():
            return
        t = re.sub(r"\s+", " ", text.strip())
        if t.startswith("("):  # census notes: "(this is not V* W Her)"
            return
        m = re.fullmatch(r'(.*?)\s*"([^"]+)"', t)  # 'G 96-29 A "Capella H"': a nickname
        if m:
            add_text(m.group(2), prio, src, max_rank)
            t = m.group(1).strip()
        t = _clean_text(t) if t else None
        if not t:
            return
        if t.startswith(("*", "V*", "NAME", "HIDDEN NAME", "LAL ", "Gmb ")):
            p = prettify_simbad(t)
            if p:
                s2 = "simbad_name" if src == "simbad" and t.startswith(("NAME", "HIDDEN NAME")) else src
                add(p, prio, prettify_simbad(t, "de"), s2, max_rank=max_rank)
                return
            if not t.startswith(("LAL ", "Gmb ")):
                return
        full = expand_abbreviated(t)
        if full:
            add(full, prio, expand_abbreviated(t, "de"), src, max_rank=max_rank)
            return
        add(t, prio, None, src, max_rank=max_rank)

    if ext.get("iau"):
        add(ext["iau"], P_IAU, src="iau", rank=Rank.IAU)
    if isinstance(ext.get("wiki_en"), str):
        add(clean_title(ext["wiki_en"]), P_WIKI, src="wiki", title=True)
    cn = row.get("common_name")
    if isinstance(cn, str):
        for part in cn.split("|"):
            add_text(part, P_CENSUS, "census")
    proper = row.get("proper")
    if isinstance(proper, str) and proper != "Sol":
        add_text(proper, P_ATHYG, "athyg")

    # SIMBAD identifiers: aliases with the star's own component letter (or none) first; an alias
    # of another component of one of the star's own designations is dropped (census designations,
    # and HYG's Gliese number too if the SIMBAD object was matched only by position)
    mid = row.get("simbad_main_id")
    mid = mid.strip() if isinstance(mid, str) and mid.strip() not in ("", "None", "nan") else None
    expect = split_component(prettify_simbad(mid) or mid)[1] if mid else None
    expect = expect or comp
    own_letters = lettered_designations(row, census_only=row.get("simbad_match") != "pos")

    def letter_of(ident: str) -> str | None:
        return _ident_letter(ident)[1]

    def simbad_order(ident: str) -> tuple:
        is_name = ident.startswith(("NAME", "HIDDEN NAME"))
        lt = letter_of(ident)
        if lt == expect:
            pen = 0
        elif lt is None or expect is None or not letters_conflict(lt, expect):
            pen = 1
        else:
            pen = 2
        # among several NAMEs prefer "X's Star", then the longest ("Proxima Centauri" over "Proxima Cen")
        return (pen, 0 if is_name else 1, 0 if ident == mid else 1, 0 if "'s star" in ident.lower() else 1, -len(ident) if is_name else 0)

    sb = list(ext.get("simbad", []) or [])
    if mid:
        sb.append(mid)
    if any(contradicts(x, own_letters) for x in sb) and not any(confirms(x, own_letters) for x in sb):
        sb = []  # the SIMBAD object is another component ("GJ 1006 A" for the census star GJ 1006 B)
    for ident in sorted(dict.fromkeys(ext.get("simbad", []) or []), key=simbad_order):
        if not sb or contradicts(ident, own_letters):
            continue
        add_text(ident, P_SIMBAD, "simbad")
    if isinstance(ext.get("label_en"), str):
        add_text(clean_title(ext["label_en"]), P_LABEL, "label")
    bf = row.get("bayer_flamsteed")
    if isinstance(bf, str):
        for ident in bf.split("|"):
            p = prettify_simbad(ident.strip())
            if p:
                pde = prettify_simbad(ident.strip(), "de")
                c = comp if in_system else None
                add(_with_comp(p, c), P_CENSUS, _with_comp(pde, c), "census")
    con = row.get("con")
    b = parse_hyg_bayer(row.get("bayer"))
    if b and constellation(con):
        letter, idx = b
        if len(letter) == 1:  # Latin Bayer letter, e.g. "p Eridani", "b¹ Hydrae", "P Cygni"
            sup = superscript(idx) if idx else ""
            en = f"{letter}{sup} {CONSTELLATIONS[constellation(con)]}"
            de = en
        else:
            en = bayer_name(letter, con, idx, None, "en")
            de = bayer_name(letter, con, idx, None, "de")
        if en:
            c = comp if (in_system and not idx) else None
            add(_with_comp(en, c), P_GENERATED, _with_comp(de, c), "generated", rank=Rank.BAYER)
    flam = row.get("flam")
    if pd.notna(flam) and constellation(con):
        en = flamsteed_name(int(flam), con)
        add(_with_comp(en, comp if in_system else None), P_GENERATED, src="generated", rank=Rank.FLAMSTEED)
    var = row.get("hyg_var")
    # within 20 pc the census variable-star names are authoritative (HYG sometimes puts the
    # variable name of a companion on the primary)
    if pd.notna(row.get("census_row")):
        var = None
    if isinstance(var, str) and constellation(con) and not var.startswith("("):
        b2 = parse_hyg_bayer(var)
        if not (b2 and b2[0].lower() in ("alp", "bet", "gam", "del", "eps", "zet", "eta", "the", "iot", "kap", "lam", "mu", "nu", "xi", "omi", "pi", "rho", "sig", "tau", "ups", "phi", "chi", "psi", "ome")):
            add(f"{var} {CONSTELLATIONS[constellation(con)]}", P_GENERATED, src="generated", max_rank=Rank.SURVEY)
    vn = row.get("var_name")
    if isinstance(vn, str) and not vn.strip().startswith("("):
        p = prettify_simbad(vn if vn.startswith("V*") else f"V* {vn}")
        if p:
            add(p, P_CENSUS, src="census", max_rank=Rank.SURVEY)
    cat_names = row.get("catalog_names")
    for nm in cat_names if isinstance(cat_names, (list, tuple, np.ndarray)) else []:
        add_text(nm, P_CENSUS, "census")
    cname = row.get("census_name")
    if isinstance(cname, str):
        add_text(cname, P_CENSUS, "census")
    # the census Gliese number (with its component letter) before HYG's
    if isinstance(row.get("census_gj"), str):
        add(gliese_display(row.get("census_gj")), P_CENSUS, src="census", rank=Rank.GJ)
    elif isinstance(row.get("gj"), str):
        add(gliese_display(row.get("gj")), P_GENERATED, src="generated", rank=Rank.GJ)
    return out


def choose(cands: list[Cand]) -> tuple[Cand | None, list[str]]:
    """The English Wikipedia title is taken as the most commonly used name if it is a name or a
    designation up to the survey rank; the IAU name wins over a title that is the IAU name plus a
    component letter ("Sirius A" -> "Sirius"). Otherwise the IAU name, otherwise the best-ranked
    candidate. Alternatives: the other names, best first (so the IAU name comes first)."""
    if not cands:
        return None, []
    wiki = [c for c in cands if c.prio == P_WIKI and c.rank <= Rank.SURVEY]
    iau = [c for c in cands if c.prio == P_IAU]
    if wiki:
        best = wiki[0]
        if iau and _fold(split_component(best.en)[0]) == _fold(iau[0].en):
            best = iau[0]
    else:
        best = min(cands, key=lambda c: (c.rank, c.prio, c.seq))
    seen = {best.en.lower()}
    alts = []
    for c in sorted(cands, key=lambda c: (c.rank, c.prio, c.seq)):
        k = c.en.lower()
        if k not in seen:
            seen.add(k)
            alts.append(c.en)
    return best, alts


def _same_designation(a: str, b: str) -> bool:
    """'Ny¹ Columbae' / 'Nu¹ Columbae', 'Krüger 60' / 'Kruger 60': the same designation in another
    language or spelling."""
    return _fold(english_greek(a)) == _fold(english_greek(b))


def german_name(best: Cand, ext: dict, latin: set | frozenset = frozenset()) -> str | None:
    """German display name: the German Wikipedia title if it is not a worse kind of name than the
    English one ("Lacaille 9352" for "Gliese 887") or is the same designation in German ("Ny Scorpii"
    for "Nu Scorpii"); otherwise the German form of the English name. The component letter
    follows the English name."""
    title = ext.get("wiki_de")
    if isinstance(title, str) and title.strip():
        t = normalize_bayer(clean_title(title), latin)
        t_base, _ = split_component(t)
        en_base, en_comp = split_component(best.en)
        r_en = max(int(best.rank), int(Rank.COMMON))  # an IAU name counts as a common name here
        if classify_title(t_base) <= r_en or _same_designation(t_base, en_base):
            out = t_base + (f" {en_comp}" if en_comp else "")
            return out if out != best.en else None
    return best.de if best.de and best.de != best.en else None


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


def simbad_letter(row, ext: dict) -> str | None:
    """The component letter that a star's SIMBAD identifiers agree on ('HD 6956B', '** HJ 2023B'
    -> 'B'), None if they have none or disagree."""
    idents = list(ext.get("simbad") or [])
    mid = row.get("simbad_main_id")
    if isinstance(mid, str):
        idents.append(mid)
    letters = {lt for lt in (_ident_letter(x)[1] for x in idents if not x.startswith(("NAME", "HIDDEN NAME"))) if lt}
    return letters.pop() if len(letters) == 1 else None


# how much a name source says about which star of several carries the name (lower = more)
def _source_strength(src: str, row) -> int:
    if src in ("wiki", "iau"):
        return 0
    if src == "census":
        return 1
    if src in ("simbad", "simbad_name"):
        return 4 if row.get("simbad_match") == "pos" else 2
    if src in ("athyg", "label"):
        return 3
    return 4  # generated from HYG fields, or "<primary> <letter>"


def _angle_deg(ra1, dec1, ra2, dec2) -> float:
    r1, d1, r2, d2 = (np.radians(float(v)) for v in (ra1, dec1, ra2, dec2))
    c = np.sin(d1) * np.sin(d2) + np.cos(d1) * np.cos(d2) * np.cos(r1 - r2)
    return float(np.degrees(np.arccos(np.clip(c, -1.0, 1.0))))


def _strip_index(name: str) -> str:
    """'Zeta¹ Coronae Borealis' -> 'Zeta Coronae Borealis'."""
    words = name.split(" ", 1)
    return " ".join([_SUP_RE.sub("", words[0])] + words[1:])


def assign_names(s: pd.DataFrame, external: dict[int, dict]) -> pd.DataFrame:
    """Adds name_rank, name_en, name_de, alt, desig_* and system_name_* columns.

    external: row index -> {"iau": ..., "wiki_en": ..., "wiki_de": ..., "simbad": [...]}.
    """
    s = s.copy()
    n = len(s)
    name_rank = np.full(n, Rank.NONE, dtype=np.int64)
    name_en = np.full(n, None, dtype=object)
    name_de = np.full(n, None, dtype=object)
    name_src = np.full(n, "", dtype=object)
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
        ext = external.get(int(s.index[i]), {})
        cands = candidates(r, ext)
        best, alts = choose(cands)
        desigs = [d for _, d in catalogue_designations(r)]
        cname = r.get("census_name")
        if (best is None or best.rank > Rank.NAMED_MAX) and isinstance(cname, str) and cname != "Sun":
            # objects of the 20 pc census are listed (and searchable) under their census designation
            best = Cand(census_display(cname), None, Rank.SURVEY, P_CENSUS, src="census")
        if best is not None and best.rank <= Rank.NAMED_MAX:
            name_rank[i] = best.rank
            name_en[i] = best.en
            name_de[i] = german_name(best, ext, latin_letters(r, ext))
            name_src[i] = best.src
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
                    base_en = _SUP_RE.sub("", split_component(c.en)[0])
                    base_de = _SUP_RE.sub("", split_component(c.de)[0]) if c.de else None
                    prev = bayer_sys.get(sid)
                    if prev is None or (c.rank == Rank.BAYER and classify_name(prev[0]) != Rank.BAYER):
                        bayer_sys[sid] = (base_en, base_de)

    # Components of a named system: "Sirius B", "Procyon B", "Groombridge 34 B".
    members: dict[int, list[int]] = {}
    if "system_id" in s:
        sid_arr = s["system_id"].to_numpy()
        flags0 = s["flags"].to_numpy(np.int64)
        for i in rows:
            if sid_arr[i] >= 0:
                members.setdefault(int(sid_arr[i]), []).append(int(i))
        comp_of = {}
        for i in rows:
            if sid_arr[i] >= 0:
                c = component_letter(row_of(i))
                if c:
                    comp_of[int(i)] = c
        # "Ross 614B" -> "Ross 614 B": the usual spacing, and needed to recognise the letter
        for i, c in comp_of.items():
            for arr in (name_en, name_de):
                if arr[i] and re.search(rf"\d{c}$", arr[i]):
                    arr[i] = f"{arr[i][:-len(c)]} {c}"
        taken = {k: Counter(name_en[j] for j in m if name_en[j]) for k, m in members.items()}

        def rename(i: int, k: int, new_en: str, new_de: str | None, rank: int) -> None:
            old = name_en[i]
            taken[k][new_en] += 1
            if old:
                taken[k][old] -= 1
            name_en[i] = new_en
            name_de[i] = new_de
            name_rank[i] = rank
            name_src[i] = "system"
            if old and old != new_en:
                alt[i] = [old] + [a for a in (alt[i] or []) if a != old and a != new_en][:9]

        def distinguish_shared_names() -> int:
            """No two stars with the same display name. Of several stars that got the same name
            (a resolved pair under the name of the pair, a HYG designation repeated on two rows) the
            one whose source identifies it best keeps it; the others get their component letter
            ("CT Ceti A" / "CT Ceti B", "57 Aquilae A" / "57 Aquilae B" by brightness) or their next
            name or designation."""
            used = Counter(name_en[j] for j in rows if name_en[j])
            ra = s["ra"].to_numpy(float) if "ra" in s else None
            dec = s["dec"].to_numpy(float) if "dec" in s else None
            vmag = s["vmag"].to_numpy(float) if "vmag" in s else np.full(n, np.nan)
            changed = 0

            def put(i: int, new_en: str | None, new_de: str | None, rank: int, src: str) -> None:
                old = name_en[i]
                k = int(sid_arr[i])
                if old:
                    used[old] -= 1
                    if k >= 0:
                        taken[k][old] -= 1
                if new_en:
                    used[new_en] += 1
                    if k >= 0:
                        taken[k][new_en] += 1
                name_en[i], name_de[i], name_src[i] = new_en, new_de, src
                name_rank[i] = rank if new_en else Rank.NONE
                rest = [a for a in (alt[i] or []) if a != new_en]
                if old and old != new_en and new_en and _COMP_RE.search(new_en) and split_component(new_en)[0] == old:
                    rest = [old] + rest  # "CT Ceti" stays an alternative of "CT Ceti B"
                alt[i] = rest[:10] or None

            def with_letter(i: int, name: str, letter: str) -> None:
                de = name_de[i]
                put(i, f"{name} {letter}", f"{de} {letter}" if de and not _COMP_RE.search(de) else de, int(name_rank[i]), name_src[i])

            holders: dict[str, list[int]] = {}
            for j in rows:
                if name_en[j] and used[name_en[j]] > 1:
                    holders.setdefault(name_en[j], []).append(int(j))
            for nm, idx in holders.items():
                info = {}
                for i in idx:
                    r = row_of(i)
                    e = external.get(int(s.index[i]), {})
                    cs = candidates(r, e)
                    strength = min((_source_strength(c.src, r) for c in cs if c.en == nm), default=_source_strength(name_src[i], r))
                    letter = component_letter(r) or simbad_letter(r, e)
                    info[i] = (r, e, cs, strength, letter)
                base, comp = split_component(nm)
                letters = [info[i][4] for i in idx]
                close = ra is not None and all(
                    _angle_deg(ra[idx[0]], dec[idx[0]], ra[j], dec[j]) < 0.2 for j in idx[1:]
                )
                same_sys = len({int(sid_arr[i]) for i in idx}) == 1 and int(sid_arr[idx[0]]) >= 0
                if comp is None and all(letters) and (same_sys or close) and all(
                    letters_conflict(a, b) for x, a in enumerate(letters) for b in letters[x + 1:]
                ):
                    # every star has its own letter: "CM Draconis Aa" / "CM Draconis Ab"
                    if all(used[f"{nm} {lt}"] == 0 for lt in letters):
                        for i, lt in zip(idx, letters):
                            with_letter(i, nm, lt)
                            changed += 1
                        continue
                rk = classify_name(nm)
                strengths = {info[i][3] for i in idx}
                if (
                    comp is None and not any(letters) and close and len(strengths) == 1
                    and rk in (Rank.BAYER, Rank.FLAMSTEED) and np.isfinite(vmag[idx]).all()
                ):
                    # a double star whose components share a Bayer / Flamsteed designation and have
                    # no letters in our sources: A is the brighter one
                    order = sorted(idx, key=lambda j: vmag[j])
                    new = [f"{nm} {chr(ord('A') + x)}" for x in range(len(order))]
                    if all(used[v] == 0 for v in new):
                        for i, v in zip(order, new):
                            with_letter(i, nm, v.rsplit(" ", 1)[1])
                            changed += 1
                        continue
                owner = min(idx, key=lambda j: (
                    info[j][3], 0 if flags0[j] & Flag.SYSTEM_PRIMARY else 1, vmag[j] if np.isfinite(vmag[j]) else 99.0, j,
                ))
                own_letter = info[owner][4]
                owner_lettered = False
                for i in idx:
                    if i == owner:
                        continue
                    r, e, cs, _, letter = info[i]
                    if comp is None and letter and own_letter and letters_conflict(letter, own_letter) and (same_sys or close):
                        if used[f"{nm} {letter}"] == 0 and (owner_lettered or used[f"{nm} {own_letter}"] == 0):
                            with_letter(i, nm, letter)
                            if not owner_lettered:
                                with_letter(owner, nm, own_letter)
                                owner_lettered = True
                            changed += 1
                            continue
                    # the next name of its own, or its census designation, or none
                    nxt = None
                    for c in sorted(cs, key=lambda c: (c.rank, c.prio, c.seq)):
                        if c.rank > Rank.NAMED_MAX or c.en == nm or used[c.en] > 0:
                            continue
                        cl = split_component(c.en)[1]
                        if cl and letter and letters_conflict(cl, letter):
                            continue
                        if cl and not letter and comp and not letters_conflict(cl, comp):
                            continue  # "Struve 1110 C" next to the shared "Castor C": the same component
                        nxt = c
                        break
                    if nxt is None:
                        cname = r.get("census_name")
                        disp = census_display(cname) if isinstance(cname, str) else None
                        if disp and used[disp] == 0 and classify_name(disp) != Rank.OTHER:
                            nxt = Cand(disp, None, Rank.SURVEY, P_CENSUS, src="census")
                    if nxt is not None:
                        put(i, nxt.en, nxt.de if nxt.de and nxt.de != nxt.en else None, int(nxt.rank), nxt.src)
                    else:
                        put(i, None, None, Rank.NONE, "")
                    if info[i][3] <= 2:  # a name the census or SIMBAD gives this star stays searchable
                        alt[i] = ((alt[i] or []) + [nm])[:10]
                    changed += 1
            return changed

        prim_name: dict[int, tuple] = {}
        for i in np.nonzero((flags0 & Flag.SYSTEM_PRIMARY) != 0)[0]:
            if name_en[i] and name_rank[i] <= Rank.TRADITIONAL:
                k = int(sid_arr[i])
                ext = external.get(int(s.index[i]), {})
                aliases = {_fold(split_component(a)[0]) for a in (alt[i] or [])}
                iau_name = _fold(ext["iau"]) if ext.get("iau") else None
                if iau_name:
                    aliases.add(iau_name)
                prim_name[k] = (
                    split_component(name_en[i])[0],
                    split_component(name_de[i])[0] if name_de[i] else None,
                    int(name_rank[i]),
                    int(i),
                    aliases,
                    iau_name,
                )
        renamed = 0
        for i in [j for m in members.values() for j in m]:
            c = comp_of.get(i)
            k = int(sid_arr[i])
            if k not in prim_name:
                continue
            base_en, base_de, base_rank, p, aliases, iau_name = prim_name[k]
            cur = name_en[i]
            if i == p:
                continue
            cur_base, cur_comp = split_component(cur) if cur else (None, None)
            new_comp = None
            if cur is not None and cur_comp and _fold(cur_base) != _fold(base_en) and name_src[i] != "wiki" and (
                _fold(cur_base) == iau_name or (name_src[i] == "athyg" and _fold(cur_base) in aliases)
            ):
                # the IAU name belongs to the primary only: AT-HYG / SIMBAD "Tianji B" next to
                # "Zeta Herculis" is "Zeta Herculis B"
                new_comp = cur_comp
            elif cur is not None and name_src[i] in PROTECTED_SOURCES:
                continue  # Wikipedia, IAU and SIMBAD common names are a star's own
            elif cur is not None and cur_base != base_en and _fold(cur_base) == _fold(base_en):
                new_comp = cur_comp or c  # another spelling: "Kruger 60 B" next to "Krüger 60 A"
            else:
                # companions with a name of their own keep it ("Proxima Centauri", "Capella H")
                own_name = cur is not None and (
                    name_rank[i] <= Rank.COMMON or _fold(cur).startswith(_fold(base_en) + " ")
                )
                if cur is None or (name_rank[i] > base_rank and not own_name):
                    # only letters of the primary's own system / Gliese number: in a wide system that
                    # joins two pairs, "Struve 2576 A/B" must not become a second "17 Cygni A/B"
                    fam = letter_family(row_of(i))
                    pf = _families(row_of(p))
                    if fam is None or fam[0] not in pf or pf[fam[0]] == fam[1]:
                        new_comp = c
            if not new_comp:
                continue
            new_en = f"{base_en} {new_comp}"
            if new_en == cur or taken[k][new_en] > 0:
                continue  # never two stars of one system with the same name
            rank = min(base_rank, Rank.COMMON) if base_rank <= Rank.COMMON else base_rank
            rename(i, k, new_en, f"{base_de} {new_comp}" if base_de else None, rank)
            renamed += 1
        distinguished = distinguish_shared_names()
        # give a component its letter too once another one is called "<its name> B"
        bases: dict[int, set[str]] = {}
        for i in comp_of:
            if name_en[i]:
                b_, c_ = split_component(name_en[i])
                if c_:
                    bases.setdefault(int(sid_arr[i]), set()).add(b_)
        for i, c in comp_of.items():
            k = int(sid_arr[i])
            if name_en[i] and name_en[i] in bases.get(k, ()):
                new_en = f"{name_en[i]} {c}"
                if taken[k][new_en] > 0:
                    continue
                new_de = f"{name_de[i]} {c}" if name_de[i] and not _COMP_RE.search(name_de[i]) else name_de[i]
                src = name_src[i]
                rename(i, k, new_en, new_de, int(name_rank[i]))
                name_src[i] = src
        log.info("naming: %d system components named after their primary; %d stars renamed that shared a name", renamed, distinguished)
        for i in comp_of:
            if alt[i] and name_en[i] in alt[i]:
                alt[i] = [a for a in alt[i] if a != name_en[i]] or None

    s["name_rank"] = name_rank
    s["name_en"] = name_en
    s["name_de"] = name_de
    s["alt"] = alt
    flags = s["flags"].to_numpy(np.int64).copy()
    flags |= np.where(name_rank <= Rank.VARIABLE, Flag.NAMED, 0)
    s["flags"] = flags

    # system names: the primary's name without its component letter, if it is a name or a
    # classical designation ("Sirius", "Alpha Centauri", "59 Virginis", "Wolf 359"); otherwise a
    # Bayer / Flamsteed designation of any member; otherwise the primary's name or designation
    if "system_id" in s:
        sid = s["system_id"].to_numpy()
        prim = np.nonzero((flags & Flag.SYSTEM_PRIMARY) != 0)[0]
        for i in prim:
            k = int(sid[i])
            en, de = name_en[i], name_de[i]
            if en and name_rank[i] <= Rank.TRADITIONAL:
                b_en = split_component(en)[0]
                b_de = split_component(de)[0] if de else None
                # "Zeta¹ Coronae Borealis" with "Zeta² Coronae Borealis": the system is "Zeta Coronae Borealis"
                plain = _strip_index(b_en)
                if plain != b_en:
                    others = {split_component(name_en[j])[0] for j in members.get(k, []) if j != i and name_en[j]}
                    if any(o != b_en and _strip_index(o) == plain for o in others):
                        b_en, b_de = plain, (_strip_index(b_de) if b_de else None)
                sys_en[i], sys_de[i] = b_en, b_de
            elif k in bayer_sys:
                sys_en[i], sys_de[i] = bayer_sys[k]
            elif en:
                sys_en[i] = split_component(en)[0]
                sys_de[i] = split_component(de)[0] if de else None
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
            m = prettify_simbad(m) or re.sub(r"\s+", " ", m)
            if m and not m.startswith("Gaia") and classify_title(m) <= Rank.SURVEY:
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
