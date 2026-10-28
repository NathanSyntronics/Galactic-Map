"""Bulk field stars (docs/SCALING.md): Gaia DR3 sources outside the core catalogue, derived chunk
by chunk with bounded memory and streamed into the out-of-core octree writer (galmap.ooc).

A bulk star needs no cross-matching: its designation is its Gaia DR3 number, and what can be
looked up by that number alone is added per chunk (SIMBAD identifiers, object and spectral type,
known planets). Each chunk goes through the same functions as the core catalogue's rows
(merge.field_rows, derive.positions, derive.physics, naming.assign_names), so a star gets the
same position, physical values and designation either way. Only what needs the neighbourhood of
every star is missing: wide-binary systems and SIMBAD matches by position.

Sources yield pandas tables with the Gaia columns in GAIA_COLUMNS (plus parallax_zp, computed
here when missing):

* parquet_source: a table on disk (the archive queries cached by galmap.sources.gaia);
* files_source: the ESA bulk files GaiaSource_*.csv.gz (galmap.fetch_gaia_bulk downloads them).
"""

from __future__ import annotations

import contextlib
import gzip
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Iterator

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from . import derive, merge, naming
from .coords import unit_vectors
from .flags import Rank
from .photometry import Photometry
from .sources import gaia

log = logging.getLogger(__name__)

GAIA_COLUMNS = [
    "source_id",
    "ra",
    "dec",
    "parallax",
    "parallax_error",
    "pmra",
    "pmdec",
    "ruwe",
    "phot_g_mean_mag",
    "bp_rp",
    "nu_eff_used_in_astrometry",
    "pseudocolour",
    "ecl_lat",
    "astrometric_params_solved",
]
#: rows per chunk read from a source
CHUNK_ROWS = 500_000


@dataclass
class Selection:
    """Which Gaia sources become bulk stars (parallaxes in mas, zero-point corrected)."""

    min_plx: float = merge.FIELD_MIN_PLX
    max_plx: float = 10.0
    max_rel_err: float = merge.FIELD_MAX_REL_ERR
    solutions: tuple[int, ...] = (31, 95)
    max_ruwe: float | None = None

    def keep(self, df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        return merge.field_selection(df, **self.kwargs())

    def kwargs(self) -> dict:
        return dict(min_plx=self.min_plx, max_plx=self.max_plx, max_rel_err=self.max_rel_err, solutions=self.solutions, max_ruwe=self.max_ruwe)

    def describe(self) -> dict:
        return {
            "minParallaxMas": self.min_plx,
            "maxParallaxMas": self.max_plx,
            "maxRelativeError": self.max_rel_err,
            "solutions": list(self.solutions),
            "maxRuwe": self.max_ruwe,
        }


#: the Gaia field stars between 100 and 200 pc of today's build (merge.add_gaia_field)
FIELD = Selection()


# ------------------------------------------------------------------ sources


def _typed(df: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame({"source_id": pd.to_numeric(df["source_id"], errors="coerce").astype("int64")})
    for c in GAIA_COLUMNS[1:]:
        out[c] = pd.to_numeric(df[c], errors="coerce") if c in df else np.nan
    if "parallax_zp" in df:
        out["parallax_zp"] = pd.to_numeric(df["parallax_zp"], errors="coerce")
    return out


def parquet_source(path: Path, rows: int = CHUNK_ROWS) -> Iterator[pd.DataFrame]:
    """Chunks of a Parquet table with the Gaia columns (e.g. a cached archive query)."""
    import pyarrow.parquet as pq

    f = pq.ParquetFile(path)
    names = set(f.schema_arrow.names)
    cols = [c for c in GAIA_COLUMNS + ["parallax_zp"] if c in names]
    for batch in f.iter_batches(batch_size=rows, columns=cols):
        yield _typed(batch.to_pandas())


def field_source(refresh: bool = False, rows: int = CHUNK_ROWS) -> Iterator[pd.DataFrame]:
    """The Gaia field query of today's build (100-200 pc), through the archive cache."""
    path = gaia.CACHE_DIR / "gaia" / "gaia_dr3_field200.parquet"
    if refresh or not path.exists():
        gaia.fetch_xmatch("field200", chunks=128, refresh=refresh)  # downloads once, then cached
    yield from parquet_source(path, rows)


def files_source(directory: Path, rows: int = CHUNK_ROWS, pattern: str = "GaiaSource_*.csv.gz") -> Iterator[pd.DataFrame]:
    """Chunks of the ESA bulk files (gzipped CSV with '#' header lines and 'null' for missing
    values), file by file, with only the needed columns."""
    files = sorted(Path(directory).glob(pattern))
    if not files:
        raise FileNotFoundError(f"no {pattern} in {directory}")
    for k, f in enumerate(files):
        with gzip.open(f, "rt", encoding="utf-8") as fh:
            reader = pd.read_csv(fh, comment="#", usecols=lambda c: c in GAIA_COLUMNS, na_values=["null", ""], chunksize=rows, low_memory=False, float_precision="round_trip")
            for chunk in reader:
                yield _typed(chunk)
        log.info("bulk files: %d/%d read (%s)", k + 1, len(files), f.name)


# ------------------------------------------------------------------ lookups


class SortedIds:
    """A set of Gaia DR3 ids as a sorted array (about 8 bytes per id)."""

    def __init__(self, ids: Iterable[int] | np.ndarray):
        self.ids = np.unique(np.asarray(list(ids) if not isinstance(ids, np.ndarray) else ids, dtype=np.int64))

    def contains(self, q: np.ndarray) -> np.ndarray:
        q = np.asarray(q, dtype=np.int64)
        if not len(self.ids):
            return np.zeros(len(q), bool)
        i = np.searchsorted(self.ids, q)
        i[i == len(self.ids)] = 0
        return self.ids[i] == q


@dataclass
class Lookups:
    """What a bulk chunk is looked up in (all optional)."""

    simbad: object | None = None  # sources.simbad.SimbadByGaia
    planets: pd.Series | None = None  # planets per Gaia id (sources.exoplanets.by_gaia)


@contextlib.contextmanager
def quiet(*names: str):
    """Silences the per-call log lines of the core functions while chunks are processed."""
    loggers = [logging.getLogger(n) for n in names]
    levels = [lg.level for lg in loggers]
    for lg in loggers:
        lg.setLevel(logging.WARNING)
    try:
        yield
    finally:
        for lg, lv in zip(loggers, levels):
            lg.setLevel(lv)


# ------------------------------------------------------------------ derivation


def with_zero_point(raw: pd.DataFrame) -> pd.DataFrame:
    """The chunk with the parallax zero point (Lindegren et al. 2021) in 'parallax_zp'."""
    if "parallax_zp" in raw and raw["parallax_zp"].notna().any():
        return raw
    return raw.assign(parallax_zp=gaia.parallax_zero_point(raw))


def derive_chunk(raw: pd.DataFrame, selection: Selection, phot: Photometry, skip: SortedIds, lookups: Lookups) -> pd.DataFrame:
    """The octree rows (galmap.octree columns) of one chunk of Gaia sources."""
    raw = with_zero_point(raw)
    keep, plx, err = selection.keep(raw)
    keep &= ~skip.contains(raw["source_id"].to_numpy())
    new = raw[keep].reset_index(drop=True)
    s = merge.field_rows(new, plx[keep], err[keep])
    for c in ("brown_dwarf", "white_dwarf"):
        s[c] = False
    s["src"] = s["src"].astype(np.int64)
    with quiet("galmap.derive", "galmap.naming", "galmap.systems"):
        s = derive.positions(s)
        ext: dict[int, dict] = {}
        if lookups.simbad is not None and len(s):
            idents, info = lookups.simbad.lookup(s["gaia"].to_numpy(dtype=np.int64))
            s = pd.concat([s, info], axis=1)
            no_spt = s["spect"].isna() & s["simbad_sp_type"].notna()
            s.loc[no_spt, "spect"] = s.loc[no_spt, "simbad_sp_type"]
            otype = s["simbad_otype"].astype(object)
            s["brown_dwarf"] = s["brown_dwarf"] | otype.isin(["BD*"]).to_numpy()
            s["white_dwarf"] = s["white_dwarf"] | otype.isin(["WD*"]).to_numpy()
            ext = {i: {"simbad": lst} for i, lst in idents.items()}
        else:
            s["simbad_main_id"] = None
        s = derive.physics(s, phot)
        s["system_id"] = -1
        # no other catalogue numbers (naming.unique_designations reads these columns)
        s["hip"] = pd.array([pd.NA] * len(s), dtype="Int64")
        s["hd"] = pd.array([pd.NA] * len(s), dtype="Int64")
        s["tyc"] = None
        s = naming.assign_names(s, ext)
    planets = lookups.planets
    if planets is not None and len(planets) and len(s):
        g = s["gaia"].to_numpy(dtype=np.int64)
        s["planets"] = pd.Series(g).map(planets).fillna(0).astype(np.int64).to_numpy()
    else:
        s["planets"] = 0
    return s


@dataclass
class BulkStats:
    read: int = 0
    kept: int = 0
    named: int = 0
    planets: int = 0
    chunks: int = 0
    extra: dict = field(default_factory=dict)


def chunks(
    source: Iterable[pd.DataFrame],
    selection: Selection,
    phot: Photometry,
    skip: SortedIds,
    lookups: Lookups,
    stats: BulkStats | None = None,
    on_chunk: Callable[[pd.DataFrame], None] | None = None,
) -> Iterator[pd.DataFrame]:
    """Derived chunks of a source, for write_dataset(bulk=...)."""
    stats = stats if stats is not None else BulkStats()
    for raw in source:
        rows = derive_chunk(raw, selection, phot, skip, lookups)
        stats.read += len(raw)
        stats.kept += len(rows)
        stats.chunks += 1
        if len(rows):
            stats.named += int((rows["name_rank"] <= Rank.NAMED_MAX).sum())
            stats.planets += int(rows["planets"].sum())
        if on_chunk:
            on_chunk(rows)
        if stats.chunks % 20 == 0:
            log.info("bulk: %d chunks, %d of %d sources kept", stats.chunks, stats.kept, stats.read)
        yield rows
    log.info("bulk: %d of %d sources kept (%d named, %d planets)", stats.kept, stats.read, stats.named, stats.planets)


def prepass(source: Iterable[pd.DataFrame], selection: Selection, core: pd.DataFrame) -> pd.DataFrame:
    """The raw Gaia rows a core catalogue row without Gaia astrometry may be the same star as (within
    merge.dedupe_against_gaia's search radius). They join the core catalogue, so that the dedupe
    merges them exactly as when all field stars are in the core; the rest stays bulk."""
    cands = merge.dedupe_candidates(core)
    if not len(cands):
        return pd.DataFrame(columns=GAIA_COLUMNS + ["parallax_zp"])
    tree = cKDTree(unit_vectors(cands["ra"].to_numpy(), cands["dec"].to_numpy()))
    rmax = float(cands["radius"].max())
    radius = cands["radius"].to_numpy()
    out = []
    for raw in source:
        raw = with_zero_point(raw)
        keep, _, _ = selection.keep(raw)
        sub = raw[keep]
        if not len(sub):
            continue
        u = unit_vectors(sub["ra"].to_numpy(float), sub["dec"].to_numpy(float))
        hits = tree.query_ball_point(u, r=rmax)
        near = np.zeros(len(sub), bool)
        for k, lst in enumerate(hits):
            for j in lst:
                if np.linalg.norm(u[k] - tree.data[j]) <= radius[j]:
                    near[k] = True
                    break
        if near.any():
            out.append(sub[near])
    rows = pd.concat(out, ignore_index=True) if out else pd.DataFrame(columns=raw.columns)
    log.info("bulk prepass: %d sources near %d catalogue rows without Gaia astrometry join the core", len(rows), len(cands))
    return rows
