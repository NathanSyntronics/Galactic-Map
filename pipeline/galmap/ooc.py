"""Out-of-core octree writer: the LOD octree for any number of stars with bounded memory.

See docs/SCALING.md. The octree keeps its definition (galmap.octree): every node holds the
`capacity` most important stars of its cube that no ancestor holds, in the order importance
(descending), then a hash of the star's designation, then the order of arrival. Built here in
four steps:

1. **Spool.** Stars arrive in chunks (the core catalogue, then any number of bulk chunks) and are
   written to disk as fixed-width records; their few text fields (designation strings, names,
   spectral types) go to a side file per chunk.
2. **Buckets.** The root cube is split adaptively until every cube holds at most `max_bucket`
   stars; these cubes are the buckets, and every star is appended to its bucket's file.
3. **Upper levels.** A node above a bucket of depth d takes at most `capacity` stars from it per
   level, so all stars the nodes above can take from a bucket are among its `capacity * d` most
   important ones. These candidates of all buckets build the upper levels exactly as the
   in-memory builder would.
4. **Subtrees.** Each bucket is loaded on its own, the stars taken above are dropped, and its
   subtree is built and written; nodes go to the pack files as they are finished.

Memory is bounded by one bucket plus the candidates. The node list goes to a hierarchical
manifest: a subtree of more than `subtree_nodes` nodes gets a manifest of its own (m/<path>.json).
"""

from __future__ import annotations

import json
import logging
import math
import pickle
import shutil
import tempfile
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

import numpy as np
import pandas as pd

from .naming import designation_text
from .octree import MAX_DEPTH, NAMED_MAX_RANK, ROOT_OFFSET, Node, columns_of, encode_node, importance_of, iter_nodes, octree_order, tie_keys

log = logging.getLogger(__name__)

MANIFEST_VERSION = 2
#: a node whose subtree has more nodes than this gets a manifest of its own
SUBTREE_NODES = 4096
#: stars per bucket (one bucket is built in memory: about 1 kB per star)
MAX_BUCKET = 8_000_000
#: levels the bucket split looks ahead per pass over the spool
SPLIT_STEP = 4
#: buckets are not split below this depth (the octree's own limit is MAX_DEPTH)
MAX_SPLIT_DEPTH = 20
#: rows per spool chunk
CHUNK_ROWS = 1_000_000

RECORD = np.dtype(
    [
        ("x", "<f8"),
        ("y", "<f8"),
        ("z", "<f8"),
        ("absmag", "<f8"),
        ("logl", "<f8"),
        ("teff", "<f8"),
        ("dist_err", "<f8"),
        ("imp", "<f8"),
        ("tie", "<u8"),
        ("uid", "<i8"),
        ("system_id", "<i8"),
        ("desig_lo", "<u4"),
        ("desig_hi", "<u4"),
        ("flags", "<i4"),
        ("planets", "<i4"),
        ("spec_code", "<i2"),
        ("desig_cat", "<i2"),
        ("name_rank", "<i2"),
    ]
)
TEXT_COLUMNS = ("desig_str", "name_en", "name_de", "alt", "spect")
def to_records(cols: dict[str, np.ndarray], uid0: int) -> tuple[np.ndarray, dict[int, tuple]]:
    """Fixed-width records of a chunk and its text fields ({uid: (desig_str, name_en, ...)})."""
    n = len(cols["xyz"])
    rec = np.empty(n, RECORD)
    rec["x"], rec["y"], rec["z"] = cols["xyz"][:, 0], cols["xyz"][:, 1], cols["xyz"][:, 2]
    for c in ("absmag", "logl", "teff", "dist_err", "system_id", "flags", "planets", "spec_code", "desig_cat", "name_rank"):
        rec[c] = cols[c]
    rec["desig_lo"] = cols["desig_lo"].astype(np.int64) & 0xFFFFFFFF
    rec["desig_hi"] = cols["desig_hi"].astype(np.int64) & 0xFFFFFFFF
    rec["imp"] = importance_of(cols["logl"], cols["absmag"], cols["flags"])
    rec["tie"] = tie_keys(cols)
    rec["uid"] = np.arange(uid0, uid0 + n, dtype=np.int64)
    texts: dict[int, tuple] = {}
    has = np.zeros(n, bool)
    for c in TEXT_COLUMNS:
        has |= pd.notna(np.asarray(cols[c], dtype=object))
    for i in np.nonzero(has)[0]:
        texts[uid0 + int(i)] = tuple(_clean(cols[c][i]) for c in TEXT_COLUMNS)
    return rec, texts


def _clean(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    if isinstance(v, np.ndarray):
        return list(v)
    return v


def columns_from_records(rec: np.ndarray, texts: dict[int, tuple]) -> dict[str, np.ndarray]:
    """The column arrays encode_node reads, for records and their text fields."""
    n = len(rec)
    cols: dict[str, np.ndarray] = {"xyz": np.stack([rec["x"], rec["y"], rec["z"]], axis=1)}
    for c in ("absmag", "logl", "teff", "dist_err"):
        cols[c] = rec[c].astype(float)
    for c in ("flags", "spec_code", "desig_cat", "name_rank", "system_id", "planets"):
        cols[c] = rec[c].astype(np.int64)
    cols["desig_lo"] = rec["desig_lo"].astype(np.int64)
    cols["desig_hi"] = rec["desig_hi"].astype(np.int64)
    for c in TEXT_COLUMNS:
        cols[c] = np.full(n, None, dtype=object)
    if texts:
        uids = rec["uid"]
        for i in np.nonzero(np.isin(uids, np.fromiter(texts.keys(), np.int64, len(texts))))[0]:
            t = texts[int(uids[i])]
            for k, c in enumerate(TEXT_COLUMNS):
                cols[c][i] = t[k]
    return cols


def order_of(rec: np.ndarray) -> np.ndarray:
    """Indices of the records in the octree's order: importance, then tie hash, then arrival."""
    return np.lexsort((rec["uid"], rec["tie"], -rec["imp"]))


assert octree_order  # the same order as the reference builder (arrival = uid)


# ------------------------------------------------------------------ cube geometry


def root_cube(extent: float) -> tuple[np.ndarray, float]:
    """Centre and half size of the root cube (as galmap.octree.build_octree chooses them)."""
    half = 2.0 ** math.ceil(math.log2(extent * 1.2 + 1.0))
    return np.array(ROOT_OFFSET) * half, half


def child_cube(c: np.ndarray, h: float, o: int) -> tuple[np.ndarray, float]:
    hh = h / 2
    return c + np.array([hh if o & 1 else -hh, hh if o & 2 else -hh, hh if o & 4 else -hh]), hh


def cube_of(code: int, c0: np.ndarray, h0: float) -> tuple[np.ndarray, float, str]:
    """Centre, half size and path of the cube with this code (1, then 3 bits per level)."""
    digits = []
    while code > 1:
        digits.append(code & 7)
        code >>= 3
    c, h = c0, h0
    for o in reversed(digits):
        c, h = child_cube(c, h, o)
    return c, h, "r" + "".join(str(o) for o in reversed(digits))


def descend(rec: np.ndarray, c0: np.ndarray, h0: float, depth: int) -> list[np.ndarray]:
    """Cube codes of every record at depths 0..depth, with the same float operations as the
    recursive builder (so stars on a split plane fall the same way)."""
    n = len(rec)
    x, y, z = rec["x"], rec["y"], rec["z"]
    cx, cy, cz = np.full(n, c0[0]), np.full(n, c0[1]), np.full(n, c0[2])
    code = np.ones(n, np.int64)
    out = [code]
    h = h0
    for _ in range(depth):
        hh = h / 2
        ox, oy, oz = x >= cx, y >= cy, z >= cz
        cx = cx + np.where(ox, hh, -hh)
        cy = cy + np.where(oy, hh, -hh)
        cz = cz + np.where(oz, hh, -hh)
        code = code * 8 + (ox.astype(np.int64) | (oy.astype(np.int64) << 1) | (oz.astype(np.int64) << 2))
        out.append(code)
        h = hh
    return out


def depth_of(code: int) -> int:
    return (int(code).bit_length() - 1) // 3


# ------------------------------------------------------------------ spool


class Spool:
    """Stars on disk in chunks of fixed-width records, plus their text fields."""

    def __init__(self, work: Path):
        self.dir = work / "spool"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.chunks: list[int] = []
        self.count = 0
        self.extent = 0.0

    def add(self, cols: dict[str, np.ndarray]) -> None:
        n = len(cols["xyz"])
        for a in range(0, n, CHUNK_ROWS):
            part = {k: v[a : a + CHUNK_ROWS] for k, v in cols.items()}
            rec, texts = to_records(part, self.count)
            k = len(self.chunks)
            rec.tofile(self.dir / f"{k:06d}.rec")
            with open(self.dir / f"{k:06d}.txt.pkl", "wb") as fh:
                pickle.dump(texts, fh, protocol=pickle.HIGHEST_PROTOCOL)
            self.chunks.append(len(rec))
            self.count += len(rec)
            if len(rec):
                self.extent = max(self.extent, float(np.max(np.abs(part["xyz"]))))

    def read(self, texts: bool = False) -> Iterator[tuple[np.ndarray, dict[int, tuple]]]:
        for k in range(len(self.chunks)):
            rec = np.fromfile(self.dir / f"{k:06d}.rec", RECORD)
            t: dict[int, tuple] = {}
            if texts:
                with open(self.dir / f"{k:06d}.txt.pkl", "rb") as fh:
                    t = pickle.load(fh)
            yield rec, t


# ------------------------------------------------------------------ buckets


@dataclass
class Buckets:
    """Bucket cubes (code -> star count) and the cubes above them (code -> star count)."""

    buckets: dict[int, int] = field(default_factory=dict)
    upper: dict[int, int] = field(default_factory=dict)

    @property
    def max_depth(self) -> int:
        return max((depth_of(c) for c in self.buckets), default=0)


def choose_buckets(spool: Spool, c0: np.ndarray, h0: float, max_bucket: int) -> Buckets:
    """Splits the root cube until every cube holds at most max_bucket stars (counted in passes
    over the spool, SPLIT_STEP levels at a time)."""
    out = Buckets()
    if spool.count <= max_bucket:
        out.buckets[1] = spool.count
        return out
    split = {1: spool.count}
    d = 0
    while split:
        out.upper.update(split)
        step = min(SPLIT_STEP, MAX_SPLIT_DEPTH - d)
        counts: dict[int, int] = defaultdict(int)
        keys = np.fromiter(split.keys(), np.int64, len(split))
        for rec, _ in spool.read():
            codes = descend(rec, c0, h0, d + step)
            m = np.isin(codes[d], keys)
            u, c = np.unique(codes[d + step][m], return_counts=True)
            for a, b in zip(u.tolist(), c.tolist()):
                counts[a] += b
        # counts of the levels in between
        level: dict[int, dict[int, int]] = {d + step: counts}
        for j in range(step - 1, 0, -1):
            agg: dict[int, int] = defaultdict(int)
            for code, n in level[d + j + 1].items():
                agg[code >> 3] += n
            level[d + j] = agg
        frontier = set(split)
        split = {}
        for lv in range(d + 1, d + step + 1):
            nxt = set()
            for code, n in level[lv].items():
                if (code >> 3) not in frontier:
                    continue
                if n <= max_bucket or lv >= MAX_SPLIT_DEPTH:
                    if n > max_bucket:
                        log.warning("bucket %s holds %d stars (split depth limit)", code, n)
                    out.buckets[code] = n
                elif lv == d + step:
                    split[code] = n
                else:
                    out.upper[code] = n
                    nxt.add(code)
            frontier = nxt
        d += step
    return out


def bucket_of(codes: list[np.ndarray], buckets: Buckets) -> np.ndarray:
    """The bucket code of every record (codes at depths 0..max bucket depth)."""
    out = np.zeros(len(codes[0]), np.int64)
    by_depth: dict[int, list[int]] = defaultdict(list)
    for k in buckets.buckets:
        by_depth[depth_of(k)].append(k)
    for d, c in enumerate(codes):
        if d not in by_depth:
            continue
        free = out == 0
        if not free.any():
            break
        hit = free & np.isin(c, np.array(by_depth[d], np.int64))
        out[hit] = c[hit]
    if (out == 0).any():
        raise RuntimeError("a star fell into no bucket")
    return out


def bucket_files(work: Path, path: str) -> tuple[Path, Path]:
    return work / "b" / f"{path}.rec", work / "b" / f"{path}.txt.pkl"


def partition(spool: Spool, buckets: Buckets, c0: np.ndarray, h0: float, work: Path) -> dict[int, str]:
    """Appends every star to its bucket's record file and text file; returns code -> path."""
    (work / "b").mkdir(parents=True, exist_ok=True)
    paths = {code: cube_of(code, c0, h0)[2] for code in buckets.buckets}
    depth = buckets.max_depth
    for rec, texts in spool.read(texts=True):
        text_uids = np.fromiter(texts.keys(), np.int64, len(texts))
        b = bucket_of(descend(rec, c0, h0, depth), buckets)
        order = np.argsort(b, kind="stable")
        bs = b[order]
        starts = np.flatnonzero(np.r_[True, bs[1:] != bs[:-1]])
        ends = np.r_[starts[1:], len(bs)]
        for s, e in zip(starts, ends):
            code = int(bs[s])
            part = rec[order[s:e]]
            rf, tf = bucket_files(work, paths[code])
            with open(rf, "ab") as fh:
                part.tofile(fh)
            if texts:
                hit = part["uid"][np.isin(part["uid"], text_uids)]
                own = {int(u): texts[int(u)] for u in hit}
                if own:
                    with open(tf, "ab") as fh:
                        pickle.dump(own, fh, protocol=pickle.HIGHEST_PROTOCOL)
    return paths


def load_bucket(work: Path, path: str) -> tuple[np.ndarray, dict[int, tuple]]:
    rf, tf = bucket_files(work, path)
    rec = np.fromfile(rf, RECORD) if rf.exists() else np.empty(0, RECORD)
    texts: dict[int, tuple] = {}
    if tf.exists():
        with open(tf, "rb") as fh:
            while True:
                try:
                    texts.update(pickle.load(fh))
                except EOFError:
                    break
    return rec, texts


# ------------------------------------------------------------------ tree building


def build_subtree(order: np.ndarray, xyz: np.ndarray, c: np.ndarray, h: float, path: str, depth: int, capacity: int) -> Node:
    """The octree below (and including) one cube, from stars in octree order (galmap.octree)."""
    node = Node(path=path, center=c, half=h, idx=order)
    if len(order) <= capacity or depth >= MAX_DEPTH:
        return node
    node.idx = order[:capacity]
    rest = order[capacity:]
    p = xyz[rest]
    octant = (p[:, 0] >= c[0]).astype(np.int8) | ((p[:, 1] >= c[1]).astype(np.int8) << 1) | ((p[:, 2] >= c[2]).astype(np.int8) << 2)
    for o in range(8):
        sel = rest[octant == o]
        if len(sel):
            cc, hh = child_cube(c, h, o)
            node.children[o] = build_subtree(sel, xyz, cc, hh, path + str(o), depth + 1, capacity)
    return node


# ------------------------------------------------------------------ writer


class OctreeWriter:
    """Builds the octree of all stars added (core table and bulk chunks) and writes the dataset."""

    def __init__(
        self,
        out_dir: Path,
        capacity: int = 4096,
        pack_bytes: int = 4 << 20,
        work_dir: Path | None = None,
        max_bucket: int = MAX_BUCKET,
        subtree_nodes: int = SUBTREE_NODES,
    ):
        self.out = Path(out_dir)
        self.capacity = capacity
        self.pack_bytes = pack_bytes
        self.max_bucket = max(max_bucket, capacity * (MAX_SPLIT_DEPTH + 2))
        self.subtree_nodes = subtree_nodes
        self._tmp = None if work_dir else tempfile.TemporaryDirectory(prefix="galmap-octree-")
        self.work = Path(work_dir) if work_dir else Path(self._tmp.name)
        self.work.mkdir(parents=True, exist_ok=True)
        self.spool = Spool(self.work)
        self.search: list[list] = []
        self.rows: list[list] = []
        self.packs: list[str] = []
        self._pack = bytearray()
        self.stats = {"buckets": 0, "upperNodes": 0, "candidates": 0}

    def add(self, stars: pd.DataFrame | dict[str, np.ndarray]) -> None:
        """Adds stars (a table with the columns described in galmap.octree, or its column arrays)."""
        cols = stars if isinstance(stars, dict) else columns_of(stars.reset_index(drop=True))
        self.spool.add(cols)

    # -- packs

    def _emit(self, node: Node, cols: dict[str, np.ndarray], sys_info: dict[int, list], mask: int) -> None:
        blob = encode_node(node, cols, sys_info)
        if self._pack and len(self._pack) + len(blob) > self.pack_bytes:
            self._flush()
        offset = len(self._pack)
        self._pack += blob
        self.rows.append([node.path, int(len(node.idx)), len(blob), mask, len(self.packs), offset])
        rank = cols["name_rank"]
        for local in np.nonzero(rank[node.idx] <= NAMED_MAX_RANK)[0].tolist():
            gi = node.idx[local]
            en = cols["name_en"][gi]
            if not isinstance(en, str) or not en:
                continue
            de = cols["name_de"][gi]
            a = cols["alt"][gi]
            x, y, z = (round(float(v), 3) for v in cols["xyz"][gi])
            self.search.append(
                [
                    en,
                    de if isinstance(de, str) and de and de != en else None,
                    node.path,
                    local,
                    x,
                    y,
                    z,
                    int(rank[gi]),
                    list(a) if isinstance(a, (list, tuple)) and len(a) else None,
                    designation_text(int(cols["desig_cat"][gi]), int(cols["desig_lo"][gi]), int(cols["desig_hi"][gi]), cols["desig_str"][gi]),
                    int(cols["system_id"][gi]),
                ]
            )

    def _flush(self) -> None:
        if not self._pack:
            return
        name = f"n/p{len(self.packs):03d}.bin"
        (self.out / name).write_bytes(self._pack)
        self.packs.append(name)
        self._pack = bytearray()

    # -- build

    def finish(self, systems: pd.DataFrame | None, sources: list[dict], params: dict, stats: dict | None = None) -> dict:
        try:
            return self._finish(systems, sources, params, stats)
        finally:
            if self._tmp is not None:
                self._tmp.cleanup()
            else:
                shutil.rmtree(self.work / "spool", ignore_errors=True)
                shutil.rmtree(self.work / "b", ignore_errors=True)

    def _finish(self, systems, sources, params, stats) -> dict:
        out = self.out
        pack_dir = out / "n"
        pack_dir.mkdir(parents=True, exist_ok=True)
        for old in pack_dir.glob("*.bin"):
            old.unlink()
        shutil.rmtree(out / "m", ignore_errors=True)
        sys_info = system_info(systems)
        c0, h0 = root_cube(self.spool.extent)

        buckets = choose_buckets(self.spool, c0, h0, self.max_bucket)
        paths = partition(self.spool, buckets, c0, h0, self.work)
        shutil.rmtree(self.spool.dir, ignore_errors=True)
        self.stats["buckets"] = len(buckets.buckets)
        log.info("octree: %d stars in %d buckets (largest %d), %d cubes above them", self.spool.count, len(buckets.buckets), max(buckets.buckets.values(), default=0), len(buckets.upper))

        taken: dict[int, set[int]] = defaultdict(set)
        if buckets.upper:
            taken = self._upper(buckets, paths, c0, h0, sys_info)
        for code in sorted(buckets.buckets, key=lambda k: paths[k]):
            self._bucket(code, paths[code], taken.get(code, set()), c0, h0, sys_info)
        self._flush()
        return self._manifest(c0, h0, systems, sources, params, stats)

    def _upper(self, buckets: Buckets, paths: dict[int, str], c0, h0, sys_info) -> dict[int, set[int]]:
        """Builds and writes the nodes above the buckets; returns the uids they took per bucket."""
        parts, texts, owner = [], {}, []
        for code in buckets.buckets:
            rec, t = load_bucket(self.work, paths[code])
            k = self.capacity * depth_of(code)
            top = rec[order_of(rec)[:k]]
            parts.append(top)
            owner.append(np.full(len(top), code, np.int64))
            if t:
                hit = top["uid"][np.isin(top["uid"], np.fromiter(t.keys(), np.int64, len(t)))]
                texts.update({int(u): t[int(u)] for u in hit})
        cand = np.concatenate(parts) if parts else np.empty(0, RECORD)
        owner_of = np.concatenate(owner) if owner else np.empty(0, np.int64)
        self.stats["candidates"] = len(cand)
        cols = columns_from_records(cand, texts)
        xyz = cols["xyz"]
        order = order_of(cand)
        cand_codes = descend(cand, c0, h0, max(depth_of(c) for c in buckets.upper) + 1)
        taken_idx: list[np.ndarray] = []
        nodes: list[tuple[Node, int]] = []

        def build(idx: np.ndarray, c, h, code: int) -> None:
            path = cube_of(code, c0, h0)[2]
            depth = depth_of(code)
            # stars of the cube that reach this node: all of the cube minus those taken above
            in_cube = int(np.count_nonzero(cand_codes[depth] == code))
            reaching = buckets.upper[code] - (in_cube - len(idx))
            if reaching <= self.capacity:
                raise RuntimeError(f"cube {path} above the buckets would be a leaf ({reaching} stars)")
            node = Node(path=path, center=c, half=h, idx=idx[: self.capacity])
            taken_idx.append(node.idx)
            rest = idx[self.capacity :]
            p = xyz[rest]
            octant = (p[:, 0] >= c[0]).astype(np.int8) | ((p[:, 1] >= c[1]).astype(np.int8) << 1) | ((p[:, 2] >= c[2]).astype(np.int8) << 2)
            mask_children = []
            entry = (node, len(nodes))
            nodes.append(entry)
            for o in range(8):
                child = code * 8 + o
                sel = rest[octant == o]
                if child in buckets.upper:
                    cc, hh = child_cube(c, h, o)
                    mask_children.append(o)
                    build(sel, cc, hh, child)
                elif child in buckets.buckets:
                    mask_children.append(o)  # checked below: the bucket may have lost all its stars
            node.children = {o: None for o in mask_children}  # type: ignore[misc]

        build(order, c0, h0, 1)
        taken_all = np.concatenate(taken_idx) if taken_idx else np.empty(0, np.int64)
        taken: dict[int, set[int]] = defaultdict(set)
        for i in taken_all:
            taken[int(owner_of[i])].add(int(cand["uid"][i]))
        # a bucket child exists only if stars are left for it
        left = {code: n - len(taken.get(code, ())) for code, n in buckets.buckets.items()}
        for node, _ in nodes:
            code = code_of(node.path)
            mask = 0
            for o in node.children:
                child = code * 8 + o
                if child in buckets.upper or left.get(child, 0) > 0:
                    mask |= 1 << o
            self._emit(node, cols, sys_info, mask)
        self.stats["upperNodes"] = len(nodes)
        return taken

    def _bucket(self, code: int, path: str, taken: set[int], c0, h0, sys_info) -> None:
        rec, texts = load_bucket(self.work, path)
        if taken:
            rec = rec[~np.isin(rec["uid"], np.fromiter(taken, np.int64, len(taken)))]
        if not len(rec):
            return
        cols = columns_from_records(rec, texts)
        c, h, _ = cube_of(code, c0, h0)
        root = build_subtree(order_of(rec), cols["xyz"], c, h, path, depth_of(code), self.capacity)
        for node in iter_nodes(root):
            self._emit(node, cols, sys_info, node.child_mask)

    # -- manifest

    def _manifest(self, c0, h0, systems, sources, params, stats) -> dict:
        out = self.out
        main_rows, subs = split_manifest(self.rows, self.subtree_nodes)
        (out / "m").mkdir(exist_ok=True)
        for path, rows in subs.items():
            (out / "m" / f"{path}.json").write_text(
                json.dumps({"format": "galmap-octree-nodes", "version": MANIFEST_VERSION, "path": path, "nodes": rows}, separators=(",", ":")),
                "utf-8",
            )
        if not subs:
            (out / "m").rmdir()
        search = sorted(self.search, key=lambda e: (e[7], e[0], e[9] or ""))
        (out / "search.json").write_text(json.dumps(search, ensure_ascii=False, separators=(",", ":"), allow_nan=False), "utf-8")
        (out / "systems.json").write_text(json.dumps(systems_json(systems), ensure_ascii=False, separators=(",", ":"), allow_nan=False), "utf-8")
        manifest = {
            "format": "galmap-octree",
            "version": MANIFEST_VERSION,
            "generated": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "units": "ly",
            "frame": "galactic-heliocentric",
            "root": {"center": [float(v) for v in c0], "halfSize": float(h0)},
            "capacity": self.capacity,
            "starCount": int(self.spool.count),
            "nodeCount": len(self.rows),
            "packs": self.packs,
            "nodes": main_rows,
            "sources": sources,
            "params": params,
            "stats": stats or {},
        }
        (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), "utf-8")
        log.info("octree: %d nodes, %d packs, %d sub-manifests; %s", len(self.rows), len(self.packs), len(subs), self.stats)
        return manifest


def code_of(path: str) -> int:
    code = 1
    for ch in path[1:]:
        code = code * 8 + int(ch)
    return code


def split_manifest(rows: list[list], limit: int) -> tuple[list[list], dict[str, list[list]]]:
    """Main manifest rows and sub-manifests ({path: rows}). A node whose listing would exceed
    `limit` rows hands its largest child subtrees to sub-manifests of their own (the child's row
    stays with the parent and names its file in a 7th field); applied bottom-up, every file lists
    at most about `limit` nodes."""
    by_path = {r[0]: r for r in rows}
    children: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        if r[0] != "r":
            children[r[0][:-1]].append(r[0])
    size: dict[str, int] = {}
    cut: set[str] = set()
    # post-order: longer paths first
    for path in sorted(by_path, key=len, reverse=True):
        kids = sorted(children.get(path, []), key=lambda p: size[p], reverse=True)
        total = 1 + sum(size[k] for k in kids)
        for k in kids:
            if total <= limit:
                break
            cut.add(k)
            total -= size[k] - 1
        size[path] = total
    subs: dict[str, list[list]] = {}
    main: list[list] = []

    def listed(top: str, into: list[list]) -> None:
        stack = list(reversed(sorted(children.get(top, []))))
        while stack:
            p = stack.pop()
            row = list(by_path[p])
            into.append(row)
            if p in cut:
                row.append(f"m/{p}.json")
                own: list[list] = []
                listed(p, own)
                subs[p] = own
            else:
                stack.extend(reversed(sorted(children.get(p, []))))

    main.append(list(by_path["r"]))
    listed("r", main)
    return main, subs


def all_rows(out: Path, manifest: dict) -> Iterator[list]:
    """Every node row of a dataset, including those in sub-manifests."""
    stack = [manifest["nodes"]]
    while stack:
        for row in stack.pop():
            yield row
            if len(row) > 6 and row[6]:
                stack.append(json.loads((Path(out) / row[6]).read_text("utf-8"))["nodes"])


def system_info(systems: pd.DataFrame | None) -> dict[int, list]:
    info: dict[int, list] = {}
    if systems is not None and len(systems):
        for row in systems.itertuples(index=False):
            de = row.name_de if isinstance(row.name_de, str) and row.name_de != row.name_en else None
            en = row.name_en if isinstance(row.name_en, str) else None
            d = getattr(row, "designation", None)
            info[int(row.system_id)] = [en, de, int(row.members), d if isinstance(d, str) and d else None]
    return info


def systems_json(systems: pd.DataFrame | None) -> dict[str, list]:
    out: dict[str, list] = {}
    if systems is not None and len(systems):
        for row in systems.itertuples(index=False):
            de = row.name_de if isinstance(row.name_de, str) and row.name_de != row.name_en else None
            d = getattr(row, "designation", None)
            out[str(int(row.system_id))] = [
                row.name_en if isinstance(row.name_en, str) else None,
                de,
                int(row.members),
                round(float(row.cx), 3),
                round(float(row.cy), 3),
                round(float(row.cz), 3),
                d if isinstance(d, str) and d else None,
            ]
    return out
