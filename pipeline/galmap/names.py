"""Star name formatting and ranking (English and German)."""

from __future__ import annotations

import re
import unicodedata

from .flags import Rank

# IAU constellation abbreviations -> Latin genitive
CONSTELLATIONS: dict[str, str] = {
    "And": "Andromedae", "Ant": "Antliae", "Aps": "Apodis", "Aqr": "Aquarii", "Aql": "Aquilae",
    "Ara": "Arae", "Ari": "Arietis", "Aur": "Aurigae", "Boo": "Boötis", "Cae": "Caeli",
    "Cam": "Camelopardalis", "Cnc": "Cancri", "CVn": "Canum Venaticorum", "CMa": "Canis Majoris",
    "CMi": "Canis Minoris", "Cap": "Capricorni", "Car": "Carinae", "Cas": "Cassiopeiae",
    "Cen": "Centauri", "Cep": "Cephei", "Cet": "Ceti", "Cha": "Chamaeleontis", "Cir": "Circini",
    "Col": "Columbae", "Com": "Comae Berenices", "CrA": "Coronae Australis", "CrB": "Coronae Borealis",
    "Crv": "Corvi", "Crt": "Crateris", "Cru": "Crucis", "Cyg": "Cygni", "Del": "Delphini",
    "Dor": "Doradus", "Dra": "Draconis", "Equ": "Equulei", "Eri": "Eridani", "For": "Fornacis",
    "Gem": "Geminorum", "Gru": "Gruis", "Her": "Herculis", "Hor": "Horologii", "Hya": "Hydrae",
    "Hyi": "Hydri", "Ind": "Indi", "Lac": "Lacertae", "Leo": "Leonis", "LMi": "Leonis Minoris",
    "Lep": "Leporis", "Lib": "Librae", "Lup": "Lupi", "Lyn": "Lyncis", "Lyr": "Lyrae",
    "Men": "Mensae", "Mic": "Microscopii", "Mon": "Monocerotis", "Mus": "Muscae", "Nor": "Normae",
    "Oct": "Octantis", "Oph": "Ophiuchi", "Ori": "Orionis", "Pav": "Pavonis", "Peg": "Pegasi",
    "Per": "Persei", "Phe": "Phoenicis", "Pic": "Pictoris", "Psc": "Piscium", "PsA": "Piscis Austrini",
    "Pup": "Puppis", "Pyx": "Pyxidis", "Ret": "Reticuli", "Sge": "Sagittae", "Sgr": "Sagittarii",
    "Sco": "Scorpii", "Scl": "Sculptoris", "Sct": "Scuti", "Ser": "Serpentis", "Sex": "Sextantis",
    "Tau": "Tauri", "Tel": "Telescopii", "Tri": "Trianguli", "TrA": "Trianguli Australis",
    "Tuc": "Tucanae", "UMa": "Ursae Majoris", "UMi": "Ursae Minoris", "Vel": "Velorum",
    "Vir": "Virginis", "Vol": "Volantis", "Vul": "Vulpeculae",
}
_CON_LOWER = {k.lower(): k for k in CONSTELLATIONS}
GENITIVES = set(CONSTELLATIONS.values()) | {"Bootis"}

# Greek letter abbreviations (HYG style "Alp", SIMBAD style "alf") -> (English, German)
_GREEK = [
    (("alp", "alf", "alpha"), "Alpha", "Alpha"),
    (("bet", "beta"), "Beta", "Beta"),
    (("gam", "gamma"), "Gamma", "Gamma"),
    (("del", "delta"), "Delta", "Delta"),
    (("eps", "epsilon"), "Epsilon", "Epsilon"),
    (("zet", "zeta"), "Zeta", "Zeta"),
    (("eta",), "Eta", "Eta"),
    (("the", "tet", "theta"), "Theta", "Theta"),
    (("iot", "iota"), "Iota", "Iota"),
    (("kap", "kappa"), "Kappa", "Kappa"),
    (("lam", "lambda"), "Lambda", "Lambda"),
    (("mu", "mu."), "Mu", "My"),
    (("nu", "nu."), "Nu", "Ny"),
    (("xi", "ksi", "xi."), "Xi", "Xi"),
    (("omi", "omicron"), "Omicron", "Omikron"),
    (("pi", "pi."), "Pi", "Pi"),
    (("rho",), "Rho", "Rho"),
    (("sig", "sigma"), "Sigma", "Sigma"),
    (("tau",), "Tau", "Tau"),
    (("ups", "upsilon"), "Upsilon", "Ypsilon"),
    (("phi",), "Phi", "Phi"),
    (("chi",), "Chi", "Chi"),
    (("psi",), "Psi", "Psi"),
    (("ome", "omega"), "Omega", "Omega"),
]
GREEK: dict[str, tuple[str, str]] = {}
for keys, en, de in _GREEK:
    for k in keys:
        GREEK[k] = (en, de)
GREEK_EN = {en for _, en, _ in _GREEK}
GREEK_DE = {de for _, _, de in _GREEK}

_SUPERSCRIPT = str.maketrans("0123456789", "⁰¹²³⁴⁵⁶⁷⁸⁹")


def superscript(n: int | str) -> str:
    return str(int(n)).translate(_SUPERSCRIPT)


def constellation(abbr: str | None) -> str | None:
    if not isinstance(abbr, str):
        return None
    a = abbr.strip()
    if a in CONSTELLATIONS:
        return a
    return _CON_LOWER.get(a.lower())


def bayer_name(letter: str, con: str, index: int | str | None = None, component: str | None = None, lang: str = "en") -> str | None:
    """Bayer designation in words, e.g. bayer_name('alf', 'Cen', component='A') -> 'Alpha Centauri A'."""
    c = constellation(con)
    g = GREEK.get(letter.strip().lower().rstrip("."), None) if isinstance(letter, str) else None
    if not c or not g:
        return None
    word = g[1] if lang == "de" else g[0]
    sup = superscript(index) if index not in (None, "", 0, "0") else ""
    s = f"{word}{sup} {CONSTELLATIONS[c]}"
    if component:
        s += f" {component}"
    return s


def flamsteed_name(number: int | str, con: str, component: str | None = None) -> str | None:
    c = constellation(con)
    if not c:
        return None
    s = f"{int(number)} {CONSTELLATIONS[c]}"
    if component:
        s += f" {component}"
    return s


_HYG_BAYER = re.compile(r"^([A-Za-z]+)\.?(?:-?(\d+))?$")


def parse_hyg_bayer(bayer: str | None) -> tuple[str, str | None] | None:
    """HYG 'bayer' field ('Alp', 'Alp-1', 'Alp1') -> ('Alp', '1')."""
    if not isinstance(bayer, str) or not bayer.strip():
        return None
    m = _HYG_BAYER.match(bayer.strip())
    if not m:
        return None
    return m.group(1), m.group(2)



# --- component designations -------------------------------------------------------------------

# A, B, Aa, Ab, Bab and unresolved pairs / triples (AB, BC, ABC)
COMPONENT = r"[A-H](?:[a-e]{1,2}|[A-H]{1,2})?"
_COMP_TAIL = re.compile(rf"\s({COMPONENT})$")


def split_component(name: str) -> tuple[str, str | None]:
    """'Sirius B' -> ('Sirius', 'B'), 'Alpha Centauri AB' -> ('Alpha Centauri', 'AB'), 'Vega' -> ('Vega', None)."""
    m = _COMP_TAIL.search(name)
    if not m:
        return name, None
    return name[: m.start()], m.group(1)


# a component letter written directly after a catalogue number ("HD 73752A", "BD-22 2345A",
# "G 237-64A"); not the E/W/N/S suffixes of coordinate designations ("LSPM J0016+1951E")
_COMP_ATTACHED = re.compile(r"^(.*\d)([A-H][a-c]?)$")


def split_component_loose(name: str) -> tuple[str, str | None]:
    """Like split_component, but also 'HD 73752A' -> ('HD 73752', 'A')."""
    base, letter = split_component(name)
    if letter:
        return base, letter
    m = _COMP_ATTACHED.match(name)
    if m and not re.search(r"J\d{4}", name) and re.search(r"\s", name):
        return m.group(1), m.group(2)
    return name, None


def letters_conflict(a: str | None, b: str | None) -> bool:
    """True if two component designations name different components: 'A' / 'B', but not
    'A' / 'Aa' or 'B' / 'BC'."""
    if not a or not b:
        return False
    return not ({c for c in a if c.isupper()} & {c for c in b if c.isupper()})


# --- Bayer designations written in free text --------------------------------------------------

GENITIVE_ABBR: dict[str, str] = {v: k for k, v in CONSTELLATIONS.items()}
GENITIVE_ABBR["Bootis"] = "Boo"
_SUP_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹"
_DESUPERSCRIPT = str.maketrans(_SUP_DIGITS, "0123456789")
_LATIN_IDENT = re.compile(r"^V?\*\s+([A-Za-z])(\d{0,2})\s+([A-Za-z]{3})\b")


def latin_bayer_letters(idents) -> set[tuple[str, str]]:
    """(letter, constellation) of the Latin-letter Bayer designations among SIMBAD-style
    identifiers: '* f Eri' -> ('f', 'Eri'), '* b01 Hya A' -> ('b', 'Hya'), '* P Cyg' -> ('P', 'Cyg')."""
    out: set[tuple[str, str]] = set()
    for ident in idents:
        if isinstance(ident, str):
            m = _LATIN_IDENT.match(re.sub(r"\s+", " ", ident.strip()))
            if m and constellation(m.group(3)):
                out.add((m.group(1), constellation(m.group(3))))
    return out


def normalize_bayer(name: str, latin: set[tuple[str, str]] | frozenset = frozenset()) -> str:
    """A Bayer designation written as free text (Wikipedia titles, census names) in the generated
    form: 'Nu1 Columbae' -> 'Nu¹ Columbae', 'Theta1 Orionis C' -> 'Theta¹ Orionis C'.

    Wikipedia capitalises the first letter of every title, but a capital Latin Bayer letter is a
    different designation ('P Cygni' vs. 'p Velorum'): 'F Eridani' -> 'f Eridani' and
    'B1 Hydrae' -> 'b¹ Hydrae' when `latin` (see latin_bayer_letters) says the star is a
    lowercase-letter star. Other names are returned unchanged."""
    words = name.split()
    if len(words) < 2:
        return name
    m = re.fullmatch(rf"([A-Za-z]+)(\d{{1,2}}|[{_SUP_DIGITS}]{{1,2}})?", words[0])
    if not m:
        return name
    letter, idx = m.group(1), m.group(2) or ""
    rest = words[1:]
    comp = None
    if len(rest) >= 2 and re.fullmatch(COMPONENT, rest[-1]):
        comp, rest = rest[-1], rest[:-1]
    gen = " ".join(rest)
    if gen not in GENITIVES:
        return name
    if letter not in GREEK_EN and letter not in GREEK_DE:
        if len(letter) != 1:
            return name  # variable-star names ("AB Doradus") stay as they are
        abbr = GENITIVE_ABBR.get(gen)
        if letter.isupper() and (letter.lower(), abbr) in latin and (letter, abbr) not in latin:
            letter = letter.lower()
    sup = superscript(idx.translate(_DESUPERSCRIPT)) if idx else ""
    return f"{letter}{sup} {gen}" + (f" {comp}" if comp else "")


# --- SIMBAD identifier prettification ---------------------------------------------------------

# component suffixes are A-H with sub-components ("Aa", "Bb"); SIMBAD's other suffixes ("* gam Vir S",
# "* alf Cen P") are not component letters and give no name
_SIMBAD_STAR = re.compile(rf"^\*\s+([a-z]{{2,3}}\.?)(\d{{0,2}})\s+([A-Za-z]{{3}})(?:\s+({COMPONENT}))?$")
_SIMBAD_FLAM = re.compile(rf"^\*\s+(\d+)\s+([A-Za-z]{{3}})(?:\s+({COMPONENT}))?$")
_SIMBAD_VAR = re.compile(rf"^V\*\s+(V\d+|[A-Z]{{1,2}})\s+([A-Za-z]{{3}})(?:\s+({COMPONENT}))?$")
_NAME_PREFIX = re.compile(r"^(?:NAME(?:-IAU)?|HIDDEN NAME)\s+(.+)$")


def prettify_simbad(ident: str, lang: str = "en") -> str | None:
    """Turn a SIMBAD identifier into a readable name; None if it is not a name-like identifier.

    '* alf Cen A' -> 'Alpha Centauri A', '* 61 Cyg A' -> '61 Cygni A', 'V* EZ Aqr' -> 'EZ Aquarii',
    'NAME Barnard's Star' -> "Barnard's Star", 'HIDDEN NAME 17 Com B' -> '17 Comae Berenices B'.
    Survey numbers ('L 668-21', 'LHS 288') are not names and give None.
    """
    s = re.sub(r"\s+", " ", ident.strip())
    m = _NAME_PREFIX.match(s)
    if m:
        name = re.sub(r"\s*\*+$", "", m.group(1)).strip()
        # planets ("NAME Barnard's Star b") and catalogue-like names are not star names
        if re.search(r"\s[b-i]$", name) or re.search(r"\d{3,}|[+-]\d{2}", name) or re.match(r"^[A-Z0-9]{2,}[ -]?J?\d", name):
            return None
        # abbreviated designations: "NAME iot Cas AB" -> "Iota Cassiopeiae AB"
        full = expand_abbreviated(name, lang)
        if full:
            return full
        return re.sub(r"'s star\b", "'s Star", name)
    # double-star discoverer codes that carry the traditional names of nearby systems; not the
    # WDS pairs found by Luhman ("** LUH 4" is HN Pegasi, Luhman 16 has its own NAME)
    m = re.match(r"^\*\* (KR|STF|GRB) (\d+)\s*([A-H][a-c]?)?$", s)
    if m:
        who = {"KR": "Kruger", "STF": "Struve", "GRB": "Groombridge"}[m.group(1)]
        return f"{who} {m.group(2)}" + (f" {m.group(3)}" if m.group(3) else "")
    if s.startswith("** "):
        return None
    m = re.match(r"^(LAL|Gmb) (\d+)\s*([A-H])?$", s)
    if m:
        who = {"LAL": "Lalande", "Gmb": "Groombridge"}[m.group(1)]
        return f"{who} {m.group(2)}" + (f" {m.group(3)}" if m.group(3) else "")
    m = _SIMBAD_STAR.match(s)
    if m:
        return bayer_name(m.group(1), m.group(3), m.group(2) or None, m.group(4), lang)
    m = _SIMBAD_FLAM.match(s)
    if m:
        return flamsteed_name(m.group(1), m.group(2), m.group(3))
    m = _SIMBAD_VAR.match(s)
    if m:
        c = constellation(m.group(2))
        if c:
            return f"{m.group(1)} {CONSTELLATIONS[c]}" + (f" {m.group(3)}" if m.group(3) else "")
    # "* w Her" (Latin-letter Bayer), "V* kap Cet" (Bayer star listed as variable), "* 61 Cyg AB" ...
    m = re.match(r"^V?\*\s+(.+)$", s)
    if m:
        return expand_abbreviated(m.group(1), lang)
    return None


# --- ranking of arbitrary name strings ---------------------------------------------------------

# historical discovery / catalogue names that are used as the common name of nearby stars
_TRADITIONAL = re.compile(
    r"^(Wolf|Ross|Lalande|Lacaille|Groombridge|Kruger|Krüger|Struve|Kapteyn|van Maanen|Van Maanen|Stein|"
    r"Luhman|Scholz|Teegarden|Gould|Innes|Stephenson|Kuiper|Przybylski|Plaskett|Babcock|Campbell|Barnard|"
    r"van Biesbroeck|Van Biesbroeck)\s+\d",
)
# proper-motion and survey catalogues (LHS 292, LP 816-60, L 668-21, G 99-49, BD+05 1668, WISE 0855-0714, ...)
_SURVEY = re.compile(
    r"^(LHS|LP|LTT|NLTT|LFT|LSPM|PM|L|Luyten|G|GD|EG|LAWD|EGGR|WD|BD|CD|CPD|SCR|DEN|DENIS|UGPS|WISE|WISEA|WISEP|WISEU|"
    r"CWISE|CWISER|2MASS|2MASSW|2MASSI|SDSS|SDSSp|ULAS|VHS|PSO|SIPS|APMPM|LEHPM|WT|UPM|Karmn|Ton|Feige|TVLM|LSR|"
    r"VB|vB|HZ|TRAPPIST|K2|Kepler|KOI|TOI|TIC|HAT-P|HATS|WASP|XO|TrES|KELT|CoRoT|GJ)"
    r"(?:-P)?[\s\-+]?J?[\d+\-]"
)
_GJ = re.compile(r"^(GJ|Gliese|Gl|Wo)\s*\d", re.IGNORECASE)
_CATALOG = [
    (re.compile(r"^HR\s*\d+"), Rank.HR),
    (re.compile(r"^HIP\s*\d+"), Rank.HIP),
    (re.compile(r"^HD\s*\d+"), Rank.HD),
    (re.compile(r"^TYC\s*\d+"), Rank.TYC),
    (re.compile(r"^Gaia\s+(DR\d|EDR3)\s+\d+"), Rank.GAIA),
]
# raw SIMBAD identifiers and catalogue codes that are never display names: "* alf Cen", "V* EZ Aqr",
# "** STF 2398", "NAME ...", "HIDDEN NAME ...", cluster members ("Cl* Melotte 25 S 6", "Cl Melotte 111 132"),
# other star catalogues ("GR* 195", "EM* StHA 67", "SV* ZI 2047"), "[MFL2000] J2101...", "8pc 128.93"
_RAW = re.compile(r"^(?:\*|NAME\b|HIDDEN NAME\b|[A-Za-z]{1,4}\?*\*|Cl\s|\[|\d+[a-z])")

_GREEK_WORDS = {en.lower(): k for keys, en, _ in _GREEK for k in keys[:1]}
_ABBR_BAYER = re.compile(rf"^([A-Za-z]{{2,7}})\.?(\d{{0,2}})\s+([A-Za-z]{{3}})(?:\s+({COMPONENT}))?$")
_ABBR_FLAM = re.compile(rf"^(\d{{1,3}})\s+([A-Za-z]{{3}})(?:\s+({COMPONENT}))?$")
_ABBR_VAR = re.compile(rf"^(V\d{{3,4}}|[A-Z]{{1,2}})\s+([A-Za-z]{{3}})(?:\s+({COMPONENT}))?$")
_ABBR_LATIN = re.compile(rf"^([a-zA-Z])(\d{{0,2}})\s+([A-Za-z]{{3}})(?:\s+({COMPONENT}))?$")


def expand_abbreviated(name: str, lang: str = "en") -> str | None:
    """'tau Cet' -> 'Tau Ceti', 'epsilon Eri' -> 'Epsilon Eridani', '61 Cyg A' -> '61 Cygni A',
    'rho01 Cnc A' -> 'Rho¹ Cancri A', 'b01 Hya' -> 'b¹ Hydrae'. None if the name is not an
    abbreviated designation."""
    s = name.strip()
    m = _ABBR_BAYER.match(s)
    if m and constellation(m.group(3)):
        word = m.group(1).lower()
        key = _GREEK_WORDS.get(word, word)
        if key in GREEK:
            return bayer_name(key, m.group(3), m.group(2) or None, m.group(4), lang)
    m = _ABBR_FLAM.match(s)
    if m and constellation(m.group(2)):
        return flamsteed_name(m.group(1), m.group(2), m.group(3))
    m = _ABBR_LATIN.match(s)
    if m and constellation(m.group(3)) and (m.group(1).islower() or m.group(2)):
        # Latin-letter Bayer designation: "e Eri" -> "e Eridani", "b01 Hya" -> "b¹ Hydrae"
        sup = superscript(m.group(2)) if m.group(2) else ""
        out = f"{m.group(1)}{sup} {CONSTELLATIONS[constellation(m.group(3))]}"
        return out + (f" {m.group(4)}" if m.group(4) else "")
    m = _ABBR_VAR.match(s)
    if m and constellation(m.group(2)) and m.group(1) not in ("NAME",):
        out = f"{m.group(1)} {CONSTELLATIONS[constellation(m.group(2))]}"
        return out + (f" {m.group(3)}" if m.group(3) else "")
    return None


def classify_name(name: str) -> int:
    """Rank of a name string (see flags.Rank); assumes it is not an IAU proper name.

    Designations from catalogues that are not known name or survey catalogues ('Ruiz 207-86',
    'vMA 2', '47 Tuc TO Star') rank as OTHER, i.e. below HR / HIP / HD."""
    s = name.strip()
    if not s or _RAW.match(s) or re.search(r"[()\[\]\"*]", s):
        return Rank.OTHER  # raw SIMBAD identifiers, notes and odd catalogue codes
    if re.search(r"\d\s[a-z]$", s):
        return Rank.OTHER  # a lower-case letter after a number: SIMBAD's "GJ 810 a", planets ("Gliese 876 b")
    words = s.split()
    if len(words) >= 2:
        first = words[0]
        rest = " ".join(words[1:])
        base = first.rstrip(_SUP_DIGITS + "0123456789")
        gen = _strip_component(rest)
        # abbreviated designations ("BO Mus", "iot Cas AB", "zet01 Ant A") are not display forms
        if constellation(gen) and gen not in GENITIVES and not gen.isdigit():
            return Rank.OTHER
        # a constellation followed by something that is not a component letter: planets
        # ("Mu Arae b") and SIMBAD position suffixes ("Gamma Virginis S")
        if gen not in GENITIVES and any(rest.startswith(g + " ") for g in GENITIVES):
            return Rank.OTHER
        if gen in GENITIVES:
            if base in GREEK_EN or base in GREEK_DE:
                return Rank.BAYER
            if first.isdigit():
                return Rank.FLAMSTEED
        # Gould numbers of the southern stars are used like Flamsteed numbers ("82 G. Eridani")
        if first.isdigit() and len(words) >= 3 and words[1] == "G." and _strip_component(" ".join(words[2:])) in GENITIVES:
            return Rank.FLAMSTEED
        if gen in GENITIVES:
            # Latin Bayer letters: "p Eridani", "b¹ Hydrae", capital A-Q: "P Cygni", "G Scorpii"
            if re.fullmatch(r"[a-z]|[A-Q]", base):
                return Rank.BAYER
            if re.fullmatch(r"V\d+|[R-Z]|[A-Z]{2}", first):
                return Rank.VARIABLE
    if _GJ.match(s):
        return Rank.GJ
    for rx, r in _CATALOG:
        if rx.match(s):
            return r
    if _TRADITIONAL.match(s):
        return Rank.TRADITIONAL
    if _SURVEY.match(s):
        # full-precision survey designations (2MASS J00044144-2058298) are not names
        if re.search(r"J\d{4,}", s) and len(s) > 18:
            return Rank.OTHER
        return Rank.SURVEY
    # common names practically never contain numbers ("vMA 2", "Steph 1", "Ruiz 207-86")
    if re.search(r"\d", s):
        return Rank.OTHER
    return Rank.COMMON


def classify_title(title: str) -> int:
    """Rank of a Wikipedia article title. Like classify_name, but a designation from any catalogue
    ('Gaia BH1', 'PSR B1257+12', 'Cygnus X-1') counts as a survey designation, because the title
    shows that it is the name the star is known by ("HN Pegasi b", a brown dwarf). Full-precision
    coordinate designations and long running numbers stay OTHER."""
    r = classify_name(title)
    if r == Rank.OTHER and not _RAW.match(title) and not re.search(r"[()\[\]\"*]", title):
        if not re.search(r"J\d{4,}", title) and not re.search(r"\d{6,}", title):
            return Rank.SURVEY
    return r


_COMP_STRIP = re.compile(rf"\s+{COMPONENT}$")


def _strip_component(s: str) -> str:
    return _COMP_STRIP.sub("", s)


def strip_disambiguation(title: str) -> str:
    """'Vega (star)' -> 'Vega', 'Wega (Stern)' -> 'Wega'."""
    return re.sub(r"\s*\((?:star|stern|star system|sternsystem|brown dwarf|brauner zwerg|stellar system)\)\s*$", "", title, flags=re.IGNORECASE).strip()


def clean_title(title: str) -> str:
    """A Wikipedia title as a star name: without disambiguation, with plain hyphens
    ('WD 0806−661' -> 'WD 0806-661')."""
    t = strip_disambiguation(re.sub(r"\s+", " ", title.strip()))
    t = t.replace("−", "-")
    return re.sub(r"(?<=\d)–(?=\d)", "-", t)


def german_variant(name_en: str) -> str | None:
    """German form of an English Bayer designation (Greek letter names), with superscript indices;
    None if unchanged. 'Mu Cephei' -> 'My Cephei', 'Nu1 Columbae' -> 'Ny¹ Columbae'."""
    words = name_en.split(" ", 1)
    if len(words) == 2:
        m = re.fullmatch(rf"([A-Za-z]+)([0-9{_SUP_DIGITS}]*)", words[0])
        if m:
            base, idx = m.group(1), m.group(2)
            sup = superscript(idx.translate(_DESUPERSCRIPT)) if idx else ""
            for _, en, de in _GREEK:
                if base == en and en != de:
                    return f"{de}{sup} {words[1]}"
    return None


def english_greek(name: str) -> str:
    """German Greek-letter words in English: 'Ny¹ Columbae' -> 'Nu¹ Columbae'."""
    words = name.split(" ", 1)
    m = re.fullmatch(rf"([A-Za-z]+)([0-9{_SUP_DIGITS}]*)", words[0]) if words else None
    if m:
        for _, en, de in _GREEK:
            if m.group(1) == de and en != de:
                return f"{en}{m.group(2)}" + (f" {words[1]}" if len(words) > 1 else "")
    return name


def normalize_key(s: str) -> str:
    """Loose key for matching names across sources."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.translate(str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹", "0123456789"))
    return re.sub(r"[\s'’\-_.]", "", s).lower()


def designation_key(s: str) -> str | None:
    """Key for comparing catalogue designations across sources (IAU WGSN, SIMBAD, census,
    Wikidata): 'WASP-17' == 'WASP 17', '* gam Vir A' == 'gam Vir A' == 'Gamma Virginis A',
    'GJ 436' == 'Gliese 436' == 'Gl 436', 'WD 0806−661' == 'WD 0806-661'; signs and hyphens
    between numbers are kept ('BD+17 63' != 'BD-17 63', '0806-661')."""
    if not isinstance(s, str):
        return None
    t = re.sub(r"\s+", " ", s.strip().replace("−", "-").replace("–", "-"))
    t = re.sub(r"\s+Parent Star$", "", t, flags=re.IGNORECASE)
    if not t or t.startswith(("NAME", "HIDDEN NAME", "**")):
        return None
    full = prettify_simbad(t) if t.startswith(("*", "V*")) else None
    if not full:
        t = re.sub(r"^V?\*\s*", "", t)
        full = expand_abbreviated(t) or t
    k = unicodedata.normalize("NFKD", full)
    k = "".join(c for c in k if not unicodedata.combining(c)).translate(_DESUPERSCRIPT).lower()
    k = re.sub(r"^(?:gliese|gl)(?=\s*\d)", "gj", k)
    k = re.sub(r"\s+", "", k)
    k = re.sub(r"(?<=[a-z])-|-(?=[a-z])", "", k)
    # "GJ 105.5" is not "GJ 1055"
    return re.sub(r"(?<!\d)\.|\.(?!\d)", "", k) or None
