"""Photometric helpers: effective temperature, bolometric correction and luminosity.

Colour/temperature/BC relations are interpolated from E. Mamajek's
"A Modern Mean Dwarf Stellar Color and Effective Temperature Sequence"
(Pecaut & Mamajek 2013, ApJS 208, 9; table version 2022.04.16).
They are calibrated for dwarfs; for giants they are an approximation that is
good enough for colouring and sizing star symbols.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

MAMAJEK_URL = "https://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt"
MBOL_SUN = 4.74

_SPT_RE = re.compile(r"^\s*(?:sd|esd|usd|d)?\s*([OBAFGKMLTY])\s*(\d+(?:\.\d+)?)?", re.IGNORECASE)
_CLASSES = "OBAFGKMLTY"


def spt_number(spt: str | None) -> float:
    """Numeric spectral type: O0 = 0, B0 = 10, ..., M0 = 60, L0 = 70, T0 = 80, Y0 = 90. NaN if unparsable."""
    if not isinstance(spt, str):
        return np.nan
    m = _SPT_RE.match(spt)
    if not m:
        return np.nan
    # a bare class letter ("M", "K:") is taken as the middle of the class
    sub = float(m.group(2)) if m.group(2) else 5.0
    return _CLASSES.index(m.group(1).upper()) * 10 + sub


def load_mamajek(path: Path) -> pd.DataFrame:
    rows = []
    header = None
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("#SpT"):
                if header is not None:
                    break  # second header marks the end of the table
                header = line[1:].split()
                continue
            if header is None or not line.strip() or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) < len(header) - 1:
                continue
            rows.append(parts[: len(header)])
    df = pd.DataFrame(rows, columns=header[: len(rows[0])])
    for c in df.columns:
        if c != "SpT":
            df[c] = pd.to_numeric(df[c].str.replace(r"^\.+$", "", regex=True), errors="coerce")
    df["spt_num"] = df["SpT"].map(spt_number)
    return df


class Photometry:
    def __init__(self, table: pd.DataFrame):
        self.t = table
        # Teff as a function of colour; colours increase monotonically with decreasing Teff
        self._bprp = self._mono(table, "Bp-Rp")
        self._bv = self._mono(table, "B-V")
        st = table.dropna(subset=["spt_num", "Teff"]).sort_values("spt_num")
        self._spt_x = st["spt_num"].to_numpy()
        self._spt_teff = st["Teff"].to_numpy(dtype=float)
        sl = table.dropna(subset=["spt_num", "logL"]).sort_values("spt_num")
        self._spt_logl_x = sl["spt_num"].to_numpy()
        self._spt_logl = sl["logL"].to_numpy(dtype=float)
        bc = table.dropna(subset=["Teff", "BCv"]).sort_values("Teff")
        self._bc_logt = np.log10(bc["Teff"].to_numpy(dtype=float))
        self._bc = bc["BCv"].to_numpy(dtype=float)

    @staticmethod
    def _mono(table: pd.DataFrame, col: str) -> tuple[np.ndarray, np.ndarray]:
        d = table.dropna(subset=[col, "Teff"]).sort_values("Teff", ascending=False)
        x = d[col].to_numpy(dtype=float)
        y = d["Teff"].to_numpy(dtype=float)
        # enforce monotonic increase of the colour (drop the few non-monotonic rows)
        keep = [0]
        for i in range(1, len(x)):
            if x[i] > x[keep[-1]]:
                keep.append(i)
        return x[keep], y[keep]

    def teff_from_bprp(self, c) -> np.ndarray:
        x, y = self._bprp
        c = np.asarray(c, dtype=float)
        t = np.interp(c, x, y, left=np.nan, right=np.nan)
        # hotter than A1V: extend linearly in log T towards B stars (BP-RP ~ -0.3 at ~25,000 K)
        hot = c < x[0]
        t = np.where(hot & (c > -0.6), 10 ** np.interp(c, [-0.35, x[0]], [np.log10(25000), np.log10(y[0])]), t)
        # redder than the table (late M): clamp
        t = np.where(c > x[-1], y[-1], t)
        return t

    def teff_from_bv(self, c) -> np.ndarray:
        x, y = self._bv
        c = np.asarray(c, dtype=float)
        t = np.interp(c, x, y, left=np.nan, right=np.nan)
        t = np.where(c < x[0], y[0], t)
        t = np.where(c > x[-1], y[-1], t)
        return t

    def teff_from_spt(self, spt_num) -> np.ndarray:
        s = np.asarray(spt_num, dtype=float)
        return np.interp(s, self._spt_x, self._spt_teff, left=np.nan, right=np.nan)

    def logl_from_spt(self, spt_num) -> np.ndarray:
        """Dwarf luminosity for a spectral type (used for brown dwarfs without V photometry)."""
        s = np.asarray(spt_num, dtype=float)
        out = np.interp(s, self._spt_logl_x, self._spt_logl, left=np.nan, right=np.nan)
        # the table stops at T7.5 (logL -5.54); extend for late T and Y dwarfs
        last_x, last_y = self._spt_logl_x[-1], self._spt_logl[-1]
        late = s > last_x
        out = np.where(late, last_y - (s - last_x) * 0.12, out)
        return out

    def bcv(self, teff) -> np.ndarray:
        lt = np.log10(np.asarray(teff, dtype=float))
        return np.interp(lt, self._bc_logt, self._bc, left=np.nan, right=np.nan)

    def logl_from_mv(self, mv, teff) -> np.ndarray:
        bc = self.bcv(teff)
        mbol = np.asarray(mv, dtype=float) + bc
        return (MBOL_SUN - mbol) / 2.5


def g_minus_v(bp_rp) -> np.ndarray:
    """Gaia G - Johnson V as a function of BP-RP (Riello et al. 2021, A&A 649, A3, Table C.2)."""
    c = np.asarray(bp_rp, dtype=float)
    gv = -0.02704 + 0.01424 * c - 0.2156 * c**2 + 0.01426 * c**3
    return np.where((c > -0.5) & (c < 5.0), gv, np.nan)


@lru_cache(maxsize=1)
def default_photometry(path: str) -> Photometry:
    return Photometry(load_mamajek(Path(path)))
