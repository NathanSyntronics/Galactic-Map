"""Synthetic scale test of the out-of-core octree writer (docs/SCALING.md): streams N random stars
in chunks through write_dataset and reports time, peak memory and the shape of the result.

    python -m galmap.scale_test --stars 10000000 --out /tmp/scale --work-dir /tmp/scale-work

The stars are random (a dense neighbourhood and a disk out to 20,000 ly) and never meant to be
shown; the manifest marks the source as synthetic.
"""

from __future__ import annotations

import argparse
import json
import logging
import resource
import shutil
import time
from pathlib import Path
from typing import Iterator

import numpy as np

from .flags import Desig, Flag, Rank
from .octree import write_dataset

log = logging.getLogger("galmap.scale_test")


def synthetic_chunks(n: int, chunk: int = 500_000, seed: int = 1) -> Iterator[dict[str, np.ndarray]]:
    """Column arrays (galmap.octree.columns_of) of n random stars, chunk by chunk."""
    rng = np.random.default_rng(seed)
    done = 0
    while done < n:
        m = min(chunk, n - done)
        near = rng.random(m) < 0.6
        xyz = np.empty((m, 3))
        k = int(near.sum())
        xyz[near] = rng.normal(size=(k, 3)) * 700
        r = rng.exponential(8000, m - k).clip(0, 20000)
        phi = rng.random(m - k) * 2 * np.pi
        xyz[~near] = np.stack([r * np.cos(phi), r * np.sin(phi), rng.laplace(0, 900, m - k)], axis=1)
        absmag = rng.normal(8.0, 3.5, m)
        ids = (np.arange(done, done + m, dtype=np.int64) * 2654435761 + 12345) % (2**62)
        none = np.full(m, None, dtype=object)
        yield {
            "xyz": xyz,
            "absmag": absmag,
            "logl": (4.74 - absmag) / 2.5,
            "teff": rng.uniform(2500, 30000, m),
            "flags": np.full(m, Flag.SRC_GAIA, np.int64),
            "dist_err": rng.uniform(0, 0.1, m),
            "spec_code": np.full(m, 255, np.int64),
            "desig_cat": np.full(m, Desig.GAIA_DR3, np.int64),
            "desig_lo": ids & 0xFFFFFFFF,
            "desig_hi": ids >> 32,
            "desig_str": none,
            "name_rank": np.full(m, Rank.NONE, np.int64),
            "name_en": none,
            "name_de": none,
            "alt": none,
            "system_id": np.full(m, -1, np.int64),
            "spect": none,
            "planets": np.zeros(m, np.int64),
        }
        done += m


def run(
    stars: int,
    out: Path,
    work_dir: Path | None = None,
    max_bucket: int = 1_000_000,
    chunk: int = 500_000,
    subtree_nodes: int = 4096,
    capacity: int = 4096,
) -> dict:
    t0 = time.time()
    gen = synthetic_chunks(stars, chunk)
    first = next(gen)
    import pandas as pd

    core = pd.DataFrame({"x": first["xyz"][:, 0], "y": first["xyz"][:, 1], "z": first["xyz"][:, 2]})
    for c, v in first.items():
        if c != "xyz":
            core[c] = v
    m = write_dataset(
        core, None, out, sources=[{"key": "synthetic", "title": "synthetic scale test (random stars)"}], params={},
        bulk=gen, work_dir=work_dir, max_bucket=max_bucket, subtree_nodes=subtree_nodes, capacity=capacity,
    )
    out = Path(out)
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    result = {
        "stars": m["starCount"],
        "nodes": m["nodeCount"],
        "mainManifestNodes": len(m["nodes"]),
        "subManifests": len(list((out / "m").glob("*.json"))) if (out / "m").exists() else 0,
        "packs": len(m["packs"]),
        "bytes": size,
        "seconds": round(time.time() - t0, 1),
        "peakRssMB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        "maxBucket": max_bucket,
        "capacity": capacity,
    }
    log.info("scale test: %s", result)
    return result


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stars", type=int, default=2_000_000)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--work-dir", type=Path, default=None)
    ap.add_argument("--max-bucket", type=int, default=1_000_000)
    ap.add_argument("--chunk", type=int, default=500_000)
    ap.add_argument("--capacity", type=int, default=4096, help="stars per node")
    ap.add_argument("--subtree-nodes", type=int, default=4096, help="nodes per sub-manifest")
    ap.add_argument("--keep", action="store_true", help="keep the output (default: removed after the run)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    try:
        result = run(args.stars, args.out, args.work_dir, args.max_bucket, args.chunk, args.subtree_nodes, args.capacity)
        print(json.dumps(result))
    finally:
        if not args.keep:
            shutil.rmtree(args.out, ignore_errors=True)


if __name__ == "__main__":
    main()
