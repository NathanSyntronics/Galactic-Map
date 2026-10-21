"""LOD octree builder and writer for the web app (see docs/DATA_FORMAT.md).

Input is the merged star table with these columns (one row per star):

==============  =======  ==========================================================
column          dtype    meaning
==============  =======  ==========================================================
x, y, z         float    heliocentric galactic Cartesian position in light years
absmag          float    absolute visual magnitude M_V (NaN = unknown)
logl            float    log10(L / Lsun), bolometric (NaN = unknown)
teff            float    effective temperature in K (NaN = unknown)
flags           int      bit field (galmap.flags)
dist_err        float    relative distance uncertainty as a fraction (NaN = unknown)
spec_code       int      spectral class code (0..255, 255 = unknown)
spect           object   spectral type string or None
desig_cat       int      catalogue code of the primary designation (galmap.flags.Desig)
desig_lo        int      designation payload, low 32 bits
desig_hi        int      designation payload, high 32 bits
desig_str       object   designation string (used when desig_cat == 0)
name_rank       int      rank of the best name (0..12), 99 = no name
name_en         object   English display name (rank <= 6) or None
name_de         object   German display name if different from English, else None
alt             object   list of alternative designations or None
system_id       int      id of the multiple system (>= 0) or -1
==============  =======  ==========================================================
"""

from __future__ import annotations

import json
import math
import struct
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from .flags import Flag
from .naming import designation_text

MAGIC = 0x4D4C4147
VERSION = 1
HEADER_BYTES = 64
MAX_DEPTH = 24
NAMED_MAX_RANK = 7

# Offset of the root cube centre relative to the Sun, as a fraction of the root half size.
# Keeps the Sun (and the dense, well-surveyed region around it) away from the split planes
# of the top levels, so a small visibility sphere around the Sun touches few nodes.
ROOT_OFFSET = (-0.0739, 0.0517, -0.0311)


@dataclass
class Node:
    path: str
    center: np.ndarray
    half: float
    idx: np.ndarray
    children: dict[int, "Node"] = field(default_factory=dict)

    @property
    def child_mask(self) -> int:
        m = 0
        for o in self.children:
            m |= 1 << o
        return m


def importance(stars: pd.DataFrame) -> np.ndarray:
    """Luminosity used for LOD ordering (bright first); the Sun always first."""
    logl = stars["logl"].to_numpy(dtype=float).copy()
    fallback = (4.74 - stars["absmag"].to_numpy(dtype=float)) / 2.5
    logl = np.where(np.isnan(logl), fallback, logl)
    logl = np.where(np.isnan(logl), -3.0, logl)
    sun = (stars["flags"].to_numpy() & Flag.SUN) != 0
    logl[sun] = np.inf
    return logl


def build_octree(stars: pd.DataFrame, capacity: int) -> Node:
    xyz = stars[["x", "y", "z"]].to_numpy(dtype=float)
    extent = float(np.max(np.abs(xyz))) if len(xyz) else 1.0
    # root half size: power of two that contains every star even with the centre offset
    half = 2.0 ** math.ceil(math.log2(extent * 1.2 + 1.0))
    center = np.array(ROOT_OFFSET) * half
    imp = importance(stars)
    # deterministic tie-break so equal luminosities do not create spatial patterns
    rng = np.random.default_rng(12345)
    jitter = rng.random(len(imp)) * 1e-6
    order = np.lexsort((jitter, -imp))

    def build(idx: np.ndarray, c: np.ndarray, h: float, path: str, depth: int) -> Node:
        node = Node(path=path, center=c, half=h, idx=idx)
        if len(idx) <= capacity or depth >= MAX_DEPTH:
            return node
        node.idx = idx[:capacity]
        rest = idx[capacity:]
        p = xyz[rest]
        octant = (p[:, 0] >= c[0]).astype(np.int8) | ((p[:, 1] >= c[1]).astype(np.int8) << 1) | (
            (p[:, 2] >= c[2]).astype(np.int8) << 2
        )
        hh = h / 2
        for o in range(8):
            sel = rest[octant == o]
            if len(sel) == 0:
                continue
            cc = c + np.array([hh if o & 1 else -hh, hh if o & 2 else -hh, hh if o & 4 else -hh])
            node.children[o] = build(sel, cc, hh, path + str(o), depth + 1)
        return node

    return build(order, center, half, "r", 0)


def iter_nodes(root: Node):
    """Depth-first pre-order traversal."""
    stack = [root]
    while stack:
        n = stack.pop()
        yield n
        for o in sorted(n.children, reverse=True):
            stack.append(n.children[o])


def _pad8(b: bytearray) -> None:
    while len(b) % 8:
        b.append(0)


def _i16(values: np.ndarray, scale: float) -> np.ndarray:
    v = np.where(np.isnan(values), -32768, np.clip(np.rint(values * scale), -32767, 32767))
    return v.astype("<i2")


def encode_node(node: Node, cols: dict[str, np.ndarray], sys_info: dict[int, list] | None = None) -> bytes:
    idx = node.idx
    n = len(idx)
    pos = cols["xyz"][idx].astype("<f4")

    absmag = _i16(cols["absmag"][idx], 100)
    logl = _i16(cols["logl"][idx], 1000)
    teff_f = cols["teff"][idx]
    teff = np.where(np.isnan(teff_f), 0, np.clip(np.rint(teff_f), 0, 65535)).astype("<u2")
    flags = cols["flags"][idx].astype("<u2")
    de = cols["dist_err"][idx]
    dist_err = np.where(np.isnan(de), 255, np.clip(np.rint(de * 200), 0, 254)).astype("u1")
    spec = cols["spec_code"][idx].astype("u1")
    desig_cat = cols["desig_cat"][idx].astype("u1")
    desig_id = np.empty(2 * n, dtype="<u4")
    desig_id[0::2] = cols["desig_lo"][idx].astype(np.uint64) & 0xFFFFFFFF
    desig_id[1::2] = cols["desig_hi"][idx].astype(np.uint64) & 0xFFFFFFFF

    extra: dict = {}
    d: dict[str, str] = {}
    names: list = []
    systems: dict[str, int] = {}
    spect: dict[str, str] = {}
    planets: dict[str, int] = {}
    planet_col = cols["planets"]
    desig_str = cols["desig_str"]
    name_rank = cols["name_rank"]
    name_en = cols["name_en"]
    name_de = cols["name_de"]
    alt = cols["alt"]
    system_id = cols["system_id"]
    spect_col = cols["spect"]
    for local, gi in enumerate(idx):
        if desig_cat[local] == 0:
            s = desig_str[gi]
            if isinstance(s, str) and s:
                d[str(local)] = s
        r = int(name_rank[gi])
        en = name_en[gi]
        if r <= NAMED_MAX_RANK and isinstance(en, str) and en:
            ger = name_de[gi]
            a = alt[gi]
            entry = [local, r, en, ger if isinstance(ger, str) and ger and ger != en else None]
            if isinstance(a, (list, tuple)) and len(a):
                entry.append(list(a))
            names.append(entry)
        sid = int(system_id[gi])
        if sid >= 0:
            systems[str(local)] = sid
        st = spect_col[gi]
        if isinstance(st, str) and st:
            spect[str(local)] = st
        if planet_col[gi] > 0:
            planets[str(local)] = int(planet_col[gi])
    if d:
        extra["d"] = d
    if names:
        extra["n"] = names
    if systems:
        extra["s"] = systems
        if sys_info:
            table = {str(k): sys_info[k] for k in sorted(set(systems.values())) if k in sys_info}
            if table:
                extra["S"] = table
    if spect:
        extra["t"] = spect
    if planets:
        extra["p"] = planets
    extra_bytes = json.dumps(extra, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8") if extra else b""

    body = bytearray(HEADER_BYTES)
    offsets = []
    for arr in (pos, absmag, logl, teff, flags, dist_err, spec, desig_cat, desig_id):
        _pad8(body)
        offsets.append(len(body))
        body += arr.tobytes()
    _pad8(body)
    off_extra = len(body)
    body += extra_bytes
    _pad8(body)
    header = struct.pack(
        "<IHHI" + "I" * 13,
        MAGIC,
        VERSION,
        0,
        n,
        *offsets,
        off_extra,
        len(extra_bytes),
        0,
        0,
    )
    assert len(header) == HEADER_BYTES
    body[:HEADER_BYTES] = header
    return bytes(body)


def _columns(stars: pd.DataFrame) -> dict[str, np.ndarray]:
    def obj(name: str) -> np.ndarray:
        if name in stars:
            return stars[name].to_numpy(dtype=object)
        return np.full(len(stars), None, dtype=object)

    def num(name: str, default: float, dtype=float) -> np.ndarray:
        if name in stars:
            return stars[name].to_numpy(dtype=dtype, na_value=default)
        return np.full(len(stars), default, dtype=dtype)

    return {
        "xyz": stars[["x", "y", "z"]].to_numpy(dtype=float),
        "absmag": num("absmag", np.nan),
        "logl": num("logl", np.nan),
        "teff": num("teff", np.nan),
        "flags": num("flags", 0, np.int64),
        "dist_err": num("dist_err", np.nan),
        "spec_code": num("spec_code", 255, np.int64),
        "desig_cat": num("desig_cat", 0, np.int64),
        "desig_lo": num("desig_lo", 0, np.int64),
        "desig_hi": num("desig_hi", 0, np.int64),
        "desig_str": obj("desig_str"),
        "name_rank": num("name_rank", 99, np.int64),
        "name_en": obj("name_en"),
        "name_de": obj("name_de"),
        "alt": obj("alt"),
        "system_id": num("system_id", -1, np.int64),
        "spect": obj("spect"),
        "planets": num("planets", 0, np.int64),
    }


def write_dataset(
    stars: pd.DataFrame,
    systems: pd.DataFrame | None,
    out_dir: Path,
    sources: list[dict],
    params: dict,
    stats: dict | None = None,
    capacity: int = 4096,
    pack_bytes: int = 4 << 20,
) -> dict:
    """Build the octree and write manifest.json, search.json, systems.json and the pack files."""
    out_dir = Path(out_dir)
    stars = stars.reset_index(drop=True)
    root = build_octree(stars, capacity)
    cols = _columns(stars)

    pack_dir = out_dir / "n"
    pack_dir.mkdir(parents=True, exist_ok=True)
    for old in pack_dir.glob("*.bin"):
        old.unlink()

    packs: list[str] = []
    node_entries: list[list] = []
    node_of_star = np.empty(len(stars), dtype=object)
    local_of_star = np.full(len(stars), -1, dtype=np.int64)
    current = bytearray()

    def flush() -> None:
        nonlocal current
        if not current:
            return
        name = f"n/p{len(packs):03d}.bin"
        (out_dir / name).write_bytes(current)
        packs.append(name)
        current = bytearray()

    sys_info: dict[int, list] = {}
    if systems is not None and len(systems):
        for row in systems.itertuples(index=False):
            de = row.name_de if isinstance(row.name_de, str) and row.name_de != row.name_en else None
            en = row.name_en if isinstance(row.name_en, str) else None
            sys_info[int(row.system_id)] = [en, de, int(row.members)]
    for node in iter_nodes(root):
        blob = encode_node(node, cols, sys_info)
        if current and len(current) + len(blob) > pack_bytes:
            flush()
        offset = len(current)
        current += blob
        node_entries.append([node.path, int(len(node.idx)), len(blob), node.child_mask, len(packs), offset])
        node_of_star[node.idx] = node.path
        local_of_star[node.idx] = np.arange(len(node.idx))
    flush()

    # search index: named stars
    search = []
    rank = cols["name_rank"]
    for gi in np.nonzero(rank <= NAMED_MAX_RANK)[0]:
        en = cols["name_en"][gi]
        if not isinstance(en, str) or not en:
            continue
        de = cols["name_de"][gi]
        a = cols["alt"][gi]
        x, y, z = (round(float(v), 3) for v in cols["xyz"][gi])
        entry = [
            en,
            de if isinstance(de, str) and de and de != en else None,
            node_of_star[gi],
            int(local_of_star[gi]),
            x,
            y,
            z,
            int(rank[gi]),
            list(a) if isinstance(a, (list, tuple)) and len(a) else None,
            designation_text(int(cols["desig_cat"][gi]), int(cols["desig_lo"][gi]), int(cols["desig_hi"][gi]), cols["desig_str"][gi]),
            int(cols["system_id"][gi]),
        ]
        search.append(entry)
    search.sort(key=lambda e: (e[7], e[0]))
    (out_dir / "search.json").write_text(json.dumps(search, ensure_ascii=False, separators=(",", ":"), allow_nan=False), "utf-8")

    sys_out: dict[str, list] = {}
    if systems is not None and len(systems):
        for row in systems.itertuples(index=False):
            de = row.name_de if isinstance(row.name_de, str) and row.name_de != row.name_en else None
            sys_out[str(int(row.system_id))] = [
                row.name_en if isinstance(row.name_en, str) else None,
                de,
                int(row.members),
                round(float(row.cx), 3),
                round(float(row.cy), 3),
                round(float(row.cz), 3),
            ]
    (out_dir / "systems.json").write_text(json.dumps(sys_out, ensure_ascii=False, separators=(",", ":"), allow_nan=False), "utf-8")

    manifest = {
        "format": "galmap-octree",
        "version": VERSION,
        "generated": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "units": "ly",
        "frame": "galactic-heliocentric",
        "root": {"center": [float(v) for v in root.center], "halfSize": float(root.half)},
        "capacity": capacity,
        "starCount": int(len(stars)),
        "nodeCount": len(node_entries),
        "packs": packs,
        "nodes": node_entries,
        "sources": sources,
        "params": params,
        "stats": stats or {},
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), "utf-8")
    return manifest
