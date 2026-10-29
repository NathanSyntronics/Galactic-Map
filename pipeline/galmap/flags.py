"""Bit flags, designation catalogue codes and spectral class codes shared with the web app.

Keep in sync with docs/DATA_FORMAT.md and src/data/format.ts.
"""

from __future__ import annotations

import re


class Flag:
    BROWN_DWARF = 1 << 0
    WHITE_DWARF = 1 << 1
    IN_SYSTEM = 1 << 2
    SYSTEM_PRIMARY = 1 << 3
    NAMED = 1 << 4
    SRC_CENSUS20 = 1 << 5
    SRC_GCNS = 1 << 6
    SRC_ATHYG = 1 << 7
    SRC_HYG = 1 << 8
    DIST_NO_PARALLAX = 1 << 9
    SUN = 1 << 10
    GIANT = 1 << 11
    VARIABLE = 1 << 12
    SRC_GAIA = 1 << 13  # Gaia DR3 field star (100-200 pc), not in any other catalogue
    SRC_EXOPLANET = 1 << 14  # a planet host from the NASA Exoplanet Archive, not in any other catalogue


class Desig:
    STRING = 0
    HIP = 1
    HD = 2
    TYC = 3
    GAIA_DR3 = 4
    HR = 5


class Rank:
    """Name ranks (lower = more common / preferred)."""

    IAU = 0
    COMMON = 1
    BAYER = 2
    FLAMSTEED = 3
    TRADITIONAL = 4
    VARIABLE = 5
    GJ = 6
    SURVEY = 7
    HR = 8
    HIP = 9
    HD = 10
    TYC = 11
    GAIA = 12
    OTHER = 13
    NONE = 99

    # stars with a name of this rank or better get an entry in the name table / search index
    NAMED_MAX = 7


SPEC_CLASSES = "OBAFGKMLTY"
SPEC_WD = 10
SPEC_OTHER = 11
SPEC_UNKNOWN = 255

# luminosity-class prefixes are lower case (d = dwarf, sd = subdwarf, g = giant), the class letter upper case
_SPEC_RE = re.compile(r"^\s*(?:d/sd|sd|esd|usd|d|g|sg)?\s*([OBAFGKMLTY])\s*(\d+(?:\.\d+)?)?")
# white dwarfs: an upper-case D, alone or followed by its class letters or a temperature index
# ('DA2', 'DC', 'DQ9', 'D', 'D?', 'Dpec'); 'dC' is a dwarf carbon star, not a white dwarf
_WD_RE = re.compile(r"^\s*(?:w?D[ABOQZCXHP]|D\d|Dpec|D(?![a-z])|[Ww][Dd]\b)")
# Am stars written with Ca II K line, hydrogen and metal types ('kA5hF1mF5'): the hydrogen type counts
_AM_RE = re.compile(r"^\s*k[OBAFGKM]\d*(?:\.\d+)?\s*h([OBAFGKM])\s*(\d+(?:\.\d+)?)?")


def spectral_code(spect: str | None) -> int:
    """Encode a spectral type string as class*10+subclass (see DATA_FORMAT.md)."""
    if not isinstance(spect, str) or not spect.strip():
        return SPEC_UNKNOWN
    s = spect.strip()
    if _WD_RE.match(s):
        m = re.search(r"(\d+(?:\.\d+)?)", s)
        sub = int(float(m.group(1))) if m else 0
        return SPEC_WD * 10 + min(sub, 9)
    m = _AM_RE.match(s) or _SPEC_RE.match(s)
    if not m:
        core = re.sub(r"^(?:sd|d)(?=[CSN])", "", s)  # dwarf carbon stars 'dC'
        if core[0] in "CSWNRcswnr":
            return SPEC_OTHER * 10
        return SPEC_UNKNOWN
    cls = SPEC_CLASSES.index(m.group(1).upper())
    sub = int(float(m.group(2))) if m.group(2) else 0
    return cls * 10 + min(sub, 9)


def is_giant_spect(spect: str | None) -> bool:
    """True for luminosity classes 0, I, II, III (giants and supergiants)."""
    if not isinstance(spect, str):
        return False
    s = spect.strip()
    # luminosity class follows the subclass: e.g. "K0III", "M2Iab", "B8Ia", "G8III-IV"
    m = re.match(
        r"^[OBAFGKM]\s*(?:\d+(?:\.\d+)?)?(?:\s*[-/]\s*[OBAFGKM]?\d+(?:\.\d+)?)?\s*:?\s*"
        r"(?:0-?Ia|Ia\+|Iab|Ia|Ib|III|II(?![IV])|I(?![IV]))",
        s,
    )
    return bool(m)
