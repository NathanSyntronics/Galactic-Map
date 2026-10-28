"""Compares two built datasets star by star (keyed by the primary designation).

    python -m galmap.compare ../public/data /tmp/other-build [--json report.json]

Reports the stars only in one of them and, for the stars in both, how many differ in each
field (position, magnitudes, temperature, flags, distance error, spectral class and type,
names, system, planets), with examples. Which node holds a star does not count: the octree
may place stars of equal importance differently.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from .naming import designation_text
from .ooc import all_rows

FIELDS = ("x", "y", "z", "absmag", "logl", "teff", "flags", "dist_err", "spec", "spect", "name_en", "name_de", "rank", "system", "planets")


def read_stars(out: Path) -> pd.DataFrame:
    """Every star of a dataset as a table (one row per star, key = designation text)."""
    out = Path(out)
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    frames = []
    handles: dict[int, object] = {}
    try:
        for row in all_rows(out, manifest):
            path, count, nbytes, _mask, pack, offset = row[:6]
            fh = handles.get(pack)
            if fh is None:
                fh = handles[pack] = open(out / manifest["packs"][pack], "rb")
            fh.seek(offset)
            blob = fh.read(nbytes)
            frames.append(decode(blob, path))
    finally:
        for fh in handles.values():
            fh.close()
    df = pd.concat(frames, ignore_index=True)
    return df


def decode(blob: bytes, path: str) -> pd.DataFrame:
    _magic, _version, _r, n = struct.unpack_from("<IHHI", blob, 0)
    offs = struct.unpack_from("<" + "I" * 11, blob, 12)
    pos = np.frombuffer(blob, "<f4", n * 3, offs[0]).reshape(n, 3)
    did = np.frombuffer(blob, "<u4", 2 * n, offs[8]).astype(np.int64)
    dcat = np.frombuffer(blob, "u1", n, offs[7]).astype(np.int64)
    extra = json.loads(blob[offs[9] : offs[9] + offs[10]].decode("utf-8")) if offs[10] else {}
    strings = extra.get("d", {})
    keys = [
        designation_text(int(dcat[i]), int(did[2 * i]), int(did[2 * i + 1]), strings.get(str(i))) or f"?{path}:{i}"
        for i in range(n)
    ]
    df = pd.DataFrame(
        {
            "key": keys,
            "path": path,
            "x": pos[:, 0],
            "y": pos[:, 1],
            "z": pos[:, 2],
            "absmag": np.frombuffer(blob, "<i2", n, offs[1]),
            "logl": np.frombuffer(blob, "<i2", n, offs[2]),
            "teff": np.frombuffer(blob, "<u2", n, offs[3]),
            "flags": np.frombuffer(blob, "<u2", n, offs[4]),
            "dist_err": np.frombuffer(blob, "u1", n, offs[5]),
            "spec": np.frombuffer(blob, "u1", n, offs[6]),
        }
    )
    obj = lambda: np.full(n, None, dtype=object)  # noqa: E731
    spect, en, de, system = obj(), obj(), obj(), np.full(n, -1, np.int64)
    rank = np.full(n, 99, np.int64)
    planets = np.zeros(n, np.int64)
    for k, v in extra.get("t", {}).items():
        spect[int(k)] = v
    for e in extra.get("n", []):
        rank[e[0]], en[e[0]], de[e[0]] = e[1], e[2], e[3]
    for k, v in extra.get("s", {}).items():
        system[int(k)] = v
    for k, v in extra.get("p", {}).items():
        planets[int(k)] = v
    df["spect"], df["name_en"], df["name_de"], df["rank"], df["system"], df["planets"] = spect, en, de, rank, system, planets
    return df


def compare(a_dir: Path, b_dir: Path, examples: int = 5) -> dict:
    a, b = read_stars(a_dir), read_stars(b_dir)
    report: dict = {"a": str(a_dir), "b": str(b_dir), "starsA": len(a), "starsB": len(b)}
    for name, df in (("A", a), ("B", b)):
        dup = df["key"].duplicated(keep=False)
        report[f"duplicateKeys{name}"] = int(dup.sum())
    m = a.merge(b, on="key", how="outer", suffixes=("_a", "_b"), indicator=True)
    only_a = m[m["_merge"] == "left_only"]
    only_b = m[m["_merge"] == "right_only"]
    both = m[m["_merge"] == "both"]
    report["onlyA"] = int(len(only_a))
    report["onlyB"] = int(len(only_b))
    report["onlyAExamples"] = only_a["key"].head(examples).tolist()
    report["onlyBExamples"] = only_b["key"].head(examples).tolist()
    report["both"] = int(len(both))
    diffs: dict[str, dict] = {}
    for f in FIELDS:
        va, vb = both[f"{f}_a"].to_numpy(), both[f"{f}_b"].to_numpy()
        if va.dtype == object or vb.dtype == object:
            na_a, na_b = pd.isna(va), pd.isna(vb)
            differ = np.array([not ((x is y) or (na_x and na_y) or (not na_x and not na_y and x == y)) for x, y, na_x, na_y in zip(va, vb, na_a, na_b)], bool)
        else:
            differ = ~((va == vb) | (pd.isna(va) & pd.isna(vb)))
        if differ.any():
            idx = np.nonzero(differ)[0][:examples]
            diffs[f] = {
                "count": int(differ.sum()),
                "examples": [[both["key"].iloc[i], _plain(va[i]), _plain(vb[i])] for i in idx],
            }
    report["differences"] = diffs
    report["sameNode"] = int((both["path_a"] == both["path_b"]).sum())
    report["search"] = compare_search(Path(a_dir), Path(b_dir))
    report["systemsIdentical"] = (Path(a_dir) / "systems.json").read_bytes() == (Path(b_dir) / "systems.json").read_bytes()
    return report


def compare_search(a_dir: Path, b_dir: Path) -> dict:
    """The name index without the node path and index of each star (those may differ)."""
    def entries(d: Path) -> list[str]:
        return sorted(json.dumps(e[:2] + e[4:], ensure_ascii=False) for e in json.loads((d / "search.json").read_text("utf-8")))

    a, b = entries(a_dir), entries(b_dir)
    sa, sb = set(a), set(b)
    return {"entriesA": len(a), "entriesB": len(b), "onlyA": len(sa - sb), "onlyB": len(sb - sa), "examplesOnlyA": sorted(sa - sb)[:3], "examplesOnlyB": sorted(sb - sa)[:3]}


def _plain(v):
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return float(v)
    return v


def summary(r: dict) -> str:
    lines = [
        f"A: {r['a']} ({r['starsA']} stars), B: {r['b']} ({r['starsB']} stars)",
        f"in both: {r['both']}; only in A: {r['onlyA']} {r['onlyAExamples']}; only in B: {r['onlyB']} {r['onlyBExamples']}",
        f"duplicate designations: A {r['duplicateKeysA']}, B {r['duplicateKeysB']}; in the same node: {r['sameNode']}",
    ]
    sr = r["search"]
    lines.append(f"name index: {sr['entriesA']} / {sr['entriesB']} entries, {sr['onlyA']} only in A, {sr['onlyB']} only in B (node and index not compared)")
    lines.append(f"systems.json identical: {r['systemsIdentical']}")
    if not r["differences"]:
        lines.append("no differences in any field")
    for f, d in r["differences"].items():
        lines.append(f"{f}: {d['count']} differ, e.g. {d['examples'][:3]}")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("a", type=Path)
    ap.add_argument("b", type=Path)
    ap.add_argument("--json", type=Path, default=None, help="write the full report here")
    args = ap.parse_args()
    r = compare(args.a, args.b)
    print(summary(r))
    if args.json:
        args.json.write_text(json.dumps(r, ensure_ascii=False, indent=1), "utf-8")
    sys.exit(0)


if __name__ == "__main__":
    main()
