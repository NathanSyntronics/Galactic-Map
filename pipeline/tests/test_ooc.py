"""The out-of-core octree writer builds exactly the tree of the in-memory reference builder."""

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from galmap.flags import Desig, Flag, Rank
from galmap.ooc import OctreeWriter, all_rows, split_manifest
from galmap.octree import build_octree, columns_of, encode_node, iter_nodes, write_dataset


def clustered_stars(n=60000, seed=5):
    """Dense core, sparse halo, clusters, many equal luminosities (ties), text fields."""
    rng = np.random.default_rng(seed)
    parts = [rng.normal(size=(n // 2, 3)) * 40, rng.normal(size=(n // 4, 3)) * 400]
    for c in rng.normal(size=(5, 3)) * 300:
        parts.append(c + rng.normal(size=(n // 20, 3)) * 8)
    xyz = np.concatenate(parts)[:n]
    n = len(xyz)
    df = pd.DataFrame({"x": xyz[:, 0], "y": xyz[:, 1], "z": xyz[:, 2]})
    # a quarter without luminosity or magnitude: all tie at the fallback importance
    absmag = np.round(rng.uniform(-3, 16, n), 1)
    logl = (4.74 - absmag) / 2.5
    unknown = rng.random(n) < 0.25
    absmag[unknown] = np.nan
    logl[unknown] = np.nan
    df["absmag"], df["logl"] = absmag, logl
    df["teff"] = rng.uniform(2500, 30000, n)
    df["flags"] = Flag.SRC_GAIA
    df["dist_err"] = rng.uniform(0, 0.3, n)
    df["spec_code"] = 255
    df["spect"] = [("M3V" if k % 7 == 0 else None) for k in range(n)]
    gaia = rng.choice(2**60, size=n, replace=False).astype(np.int64)
    df["desig_cat"] = Desig.GAIA_DR3
    df["desig_lo"] = gaia & 0xFFFFFFFF
    df["desig_hi"] = gaia >> 32
    df["desig_str"] = None
    df["name_rank"] = Rank.NONE
    df["name_en"] = None
    df["name_de"] = None
    df["alt"] = None
    df["system_id"] = -1
    df["planets"] = 0
    for k in range(0, n, 997):
        df.loc[k, ["desig_cat", "desig_str"]] = [Desig.STRING, f"STAR {k}"]
        df.at[k, "name_rank"] = Rank.BAYER
        df.at[k, "name_en"] = f"Star {k}"
        df.at[k, "name_de"] = f"Stern {k}"
        df.at[k, "alt"] = [f"ALT {k}"]
    df.loc[3, ["x", "y", "z", "absmag", "logl", "flags"]] = [0.0, 0.0, 0.0, 4.83, 0.0, Flag.SUN]
    df.loc[10:40, "system_id"] = 7
    return df


def reference(stars, capacity):
    """{path: (blob, child mask)} of the in-memory reference builder."""
    cols = columns_of(stars)
    sys_info = {7: ["Test system", None, 31, "STAR 0"]}
    return {node.path: (encode_node(node, cols, sys_info), node.child_mask) for node in iter_nodes(build_octree(stars, capacity))}


def written(out: Path):
    manifest = json.loads((out / "manifest.json").read_text())
    packs = {name: (out / name).read_bytes() for name in manifest["packs"]}
    nodes = {}
    for row in all_rows(out, manifest):
        path, count, nbytes, mask, pack, offset = row[:6]
        nodes[path] = (packs[manifest["packs"][pack]][offset : offset + nbytes], mask)
    return manifest, nodes


SYSTEMS = pd.DataFrame([{"system_id": 7, "name_en": "Test system", "name_de": None, "members": 31, "cx": 1.0, "cy": 2.0, "cz": 3.0, "designation": "STAR 0"}])


@pytest.mark.parametrize("max_bucket,chunks", [(10**9, 1), (9000, 1), (9000, 4), (3000, 7)])
def test_same_tree_as_in_memory(tmp_path: Path, max_bucket, chunks):
    stars = clustered_stars()
    capacity = 200
    ref = reference(stars, capacity)
    w = OctreeWriter(tmp_path, capacity=capacity, pack_bytes=150_000, max_bucket=max_bucket, subtree_nodes=10**9)
    # minimum bucket size is capacity * (split depth limit + 2)
    w.max_bucket = max_bucket
    for part in np.array_split(np.arange(len(stars)), chunks):
        w.add(stars.iloc[part])
    manifest = w.finish(SYSTEMS, [], {})
    if max_bucket < len(stars):
        assert w.stats["buckets"] > 8 and w.stats["upperNodes"] >= 1
    _, nodes = written(tmp_path)
    assert manifest["starCount"] == len(stars)
    assert set(nodes) == set(ref)
    for path, (blob, mask) in ref.items():
        assert nodes[path][1] == mask, path
        assert nodes[path][0] == blob, path
    search = json.loads((tmp_path / "search.json").read_text())
    assert len(search) == (stars["name_rank"] <= Rank.BAYER).sum()


def test_order_does_not_depend_on_arrival(tmp_path: Path):
    stars = clustered_stars(20000)
    a = reference(stars, 150)
    shuffled = stars.sample(frac=1.0, random_state=3).reset_index(drop=True)
    b = reference(shuffled, 150)
    assert set(a) == set(b)
    # the same stars in every node (local order may differ only among identical designations: none here)
    assert all(a[p][0] == b[p][0] for p in a)


def test_sub_manifests(tmp_path: Path):
    stars = clustered_stars()
    m = write_dataset(stars, SYSTEMS, tmp_path, sources=[], params={}, capacity=100, max_bucket=5000, subtree_nodes=60)
    assert m["version"] == 2
    files = sorted((tmp_path / "m").glob("*.json"))
    assert len(files) > 3
    manifest, nodes = written(tmp_path)
    assert len(nodes) == m["nodeCount"] == len(reference(stars, 100))
    assert len(manifest["nodes"]) <= 60
    for f in files:
        sub = json.loads(f.read_text())
        assert sub["version"] == 2 and len(sub["nodes"]) <= 60
        # a sub-manifest lists the descendants of its node
        assert all(r[0].startswith(sub["path"]) and r[0] != sub["path"] for r in sub["nodes"])
    # every node's parent is listed in the same file, or the parent names the file
    seen = {}
    stack = [("manifest.json", manifest["nodes"])]
    while stack:
        name, rows = stack.pop()
        for r in rows:
            seen[r[0]] = name
            if len(r) > 6:
                stack.append((r[6], json.loads((tmp_path / r[6]).read_text())["nodes"]))
    for path, name in seen.items():
        if path == "r":
            continue
        parent = path[:-1]
        assert seen[parent] == name or name == f"m/{parent}.json"


def test_split_manifest_small_tree():
    rows = [["r", 1, 1, 0b11, 0, 0], ["r0", 1, 1, 0, 0, 8], ["r1", 1, 1, 0, 0, 16]]
    main, subs = split_manifest(rows, 4096)
    assert main == rows and subs == {}
