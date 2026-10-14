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


# --- SIMBAD identifier prettification ---------------------------------------------------------

_SIMBAD_STAR = re.compile(r"^\*\s+([a-z]{2,3}\.?)(\d{0,2})\s+([A-Za-z]{3})(?:\s+([A-Z][a-z]?))?$")
_SIMBAD_FLAM = re.compile(r"^\*\s+(\d+)\s+([A-Za-z]{3})(?:\s+([A-Z][a-z]?))?$")
_SIMBAD_VAR = re.compile(r"^V\*\s+(V\d+|[A-Z]{1,2})\s+([A-Za-z]{3})(?:\s+([A-Z][a-z]?))?$")


def prettify_simbad(ident: str, lang: str = "en") -> str | None:
    """Turn a SIMBAD identifier into a readable name; None if it is not a name-like identifier.

    '* alf Cen A' -> 'Alpha Centauri A', '* 61 Cyg A' -> '61 Cygni A', 'V* EZ Aqr' -> 'EZ Aquarii',
    'NAME Barnard's Star' -> "Barnard's Star".
    """
    s = ident.strip()
    if s.startswith("NAME "):
        return s[5:].strip()
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
    return None


# --- ranking of arbitrary name strings ---------------------------------------------------------

# historical discovery / catalogue names that are used as the common name of nearby stars
_TRADITIONAL = re.compile(
    r"^(Wolf|Ross|Lalande|Lacaille|Groombridge|Kruger|Krüger|Struve|Luyten|Kapteyn|van Maanen|Van Maanen|Stein|"
    r"Luhman|Scholz|Teegarden|Gould|Innes|Stephenson|Kuiper|Przybylski|Plaskett|Babcock|Campbell|Barnard)\s+\d",
)
# proper-motion and survey catalogues (LHS 292, LP 816-60, G 99-49, BD+05 1668, WISE 0855-0714, ...)
_SURVEY = re.compile(
    r"^(LHS|LP|LTT|NLTT|LFT|LSPM|PM|L|G|GD|EG|LAWD|EGGR|WD|BD|CD|CPD|SCR|DEN|DENIS|UGPS|WISE|WISEA|WISEP|WISEU|"
    r"CWISE|CWISER|2MASS|2MASSW|2MASSI|SDSS|SDSSp|ULAS|VHS|PSO|SIPS|APMPM|LEHPM|WT|UPM|Karmn|Ton|Feige|TVLM|LSR|"
    r"TRAPPIST|K2|Kepler|KOI|TOI|TIC|HAT-P|WASP|XO|TrES|KELT|CoRoT|LHS|GJ)\b[\s\-+]?"
)
_GJ = re.compile(r"^(GJ|Gliese|Gl|Wo)\s*\d", re.IGNORECASE)
_CATALOG = [
    (re.compile(r"^HR\s*\d+"), Rank.HR),
    (re.compile(r"^HIP\s*\d+"), Rank.HIP),
    (re.compile(r"^HD\s*\d+"), Rank.HD),
    (re.compile(r"^TYC\s*\d+"), Rank.TYC),
    (re.compile(r"^Gaia\s+(DR\d|EDR3)\s+\d+"), Rank.GAIA),
]

_GREEK_WORDS = {en.lower(): k for keys, en, _ in _GREEK for k in keys[:1]}
_ABBR_BAYER = re.compile(r"^([A-Za-z]{2,7})\.?(\d{0,2})\s+([A-Za-z]{3})(?:\s+([A-H][a-c]?))?$")
_ABBR_FLAM = re.compile(r"^(\d{1,3})\s+([A-Za-z]{3})(?:\s+([A-H][a-c]?))?$")
_ABBR_VAR = re.compile(r"^(V\d{3,4}|[A-Z]{1,2})\s+([A-Za-z]{3})(?:\s+([A-H][a-c]?))?$")


def expand_abbreviated(name: str, lang: str = "en") -> str | None:
    """'tau Cet' -> 'Tau Ceti', 'epsilon Eri' -> 'Epsilon Eridani', '61 Cyg A' -> '61 Cygni A',
    'rho01 Cnc A' -> 'Rho¹ Cancri A'. None if the name is not an abbreviated designation."""
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
    m = re.match(r"^([a-zA-Z])\s+([A-Za-z]{3})(?:\s+([A-H][a-c]?))?$", s)
    if m and constellation(m.group(2)):  # Latin-letter Bayer designation: "e Eri" -> "e Eridani"
        out = f"{m.group(1)} {CONSTELLATIONS[constellation(m.group(2))]}"
        return out + (f" {m.group(3)}" if m.group(3) else "")
    m = _ABBR_VAR.match(s)
    if m and constellation(m.group(2)) and m.group(1) not in ("NAME",):
        out = f"{m.group(1)} {CONSTELLATIONS[constellation(m.group(2))]}"
        return out + (f" {m.group(3)}" if m.group(3) else "")
    return None


def classify_name(name: str) -> int:
    """Rank of a name string (see flags.Rank); assumes it is not an IAU proper name."""
    s = name.strip()
    words = s.split()
    if len(words) >= 2:
        first = words[0]
        rest = " ".join(words[1:])
        base = first.rstrip("⁰¹²³⁴⁵⁶⁷⁸⁹0123456789")
        gen = _strip_component(rest)
        if gen in GENITIVES:
            if base in GREEK_EN or base in GREEK_DE:
                return Rank.BAYER
            if first.isdigit():
                return Rank.FLAMSTEED
            if re.fullmatch(r"V\d+|[A-Z]{1,2}", first):
                return Rank.VARIABLE
            if re.fullmatch(r"[a-zA-Z]", first):  # Latin Bayer letters: "p Eridani"
                return Rank.BAYER
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
    if re.search(r"\d{5,}", s) or re.match(r"^[A-Z0-9]{2,}[\s+\-]?[A-Z]?\d", s):
        return Rank.OTHER
    # common names practically never contain numbers ("vMA 2", "Steph 1") – treat as catalogue names
    if re.search(r"\d", s):
        return Rank.SURVEY
    return Rank.COMMON


def _strip_component(s: str) -> str:
    return re.sub(r"\s+[A-Z][a-z]?$", "", s)


def strip_disambiguation(title: str) -> str:
    """'Vega (star)' -> 'Vega', 'Wega (Stern)' -> 'Wega'."""
    return re.sub(r"\s*\((?:star|stern|star system|sternsystem|brown dwarf|brauner zwerg|stellar system)\)\s*$", "", title, flags=re.IGNORECASE).strip()


def german_variant(name_en: str) -> str | None:
    """German form of a generated English designation (Greek letter names); None if unchanged."""
    words = name_en.split(" ", 1)
    if len(words) == 2:
        base = words[0].rstrip("⁰¹²³⁴⁵⁶⁷⁸⁹")
        sup = words[0][len(base):]
        for _, en, de in _GREEK:
            if base == en and en != de:
                return f"{de}{sup} {words[1]}"
    return None


def normalize_key(s: str) -> str:
    """Loose key for matching names across sources."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.translate(str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹", "0123456789"))
    return re.sub(r"[\s'’\-_.]", "", s).lower()
