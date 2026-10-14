import json
import struct
from pathlib import Path

import numpy as np
import pandas as pd

from galmap.flags import Desig, Flag, Rank
from galmap.octree import HEADER_BYTES, MAGIC, write_dataset


def decode_blob(blob: bytes, center, half):
    """Reference decoder mirroring src/data/format.ts."""
    magic, version, _r, n = struct.unpack_from("<IHHI", blob, 0)
    assert magic == MAGIC and version == 1
    offs = struct.unpack_from("<" + "I" * 11, blob, 12)
    for o in offs[:10]:
        assert o % 8 == 0
    pos = np.frombuffer(blob, "<f4", n * 3, offs[0]).reshape(n, 3).astype(float)
    absmag = np.frombuffer(blob, "<i2", n, offs[1])
    logl = np.frombuffer(blob, "<i2", n, offs[2])
    teff = np.frombuffer(blob, "<u2", n, offs[3])
    flags = np.frombuffer(blob, "<u2", n, offs[4])
    dist_err = np.frombuffer(blob, "u1", n, offs[5])
    spec = np.frombuffer(blob, "u1", n, offs[6])
    dcat = np.frombuffer(blob, "u1", n, offs[7])
    did = np.frombuffer(blob, "<u4", 2 * n, offs[8])
    extra = json.loads(blob[offs[9] : offs[9] + offs[10]].decode()) if offs[10] else {}
    return dict(pos=pos, absmag=absmag, logl=logl, teff=teff, flags=flags, dist_err=dist_err, spec=spec, dcat=dcat, did=did, extra=extra, n=n)


def node_bounds(manifest, path):
    c = np.array(manifest["root"]["center"], dtype=float)
    h = manifest["root"]["halfSize"]
    for ch in path[1:]:
        o = int(ch)
        h /= 2
        c = c + np.array([h if o & 1 else -h, h if o & 2 else -h, h if o & 4 else -h])
    return c, h


def make_stars(n=20000, seed=3):
    rng = np.random.default_rng(seed)
    xyz = rng.normal(size=(n, 3)) * 300
    df = pd.DataFrame({"x": xyz[:, 0], "y": xyz[:, 1], "z": xyz[:, 2]})
    df["absmag"] = rng.uniform(-5, 15, n)
    df["logl"] = (4.74 - df["absmag"]) / 2.5
    df["teff"] = rng.uniform(2500, 30000, n)
    df["flags"] = Flag.SRC_GCNS
    df["dist_err"] = rng.uniform(0, 0.3, n)
    df["spec_code"] = 255
    df["spect"] = None
    gaia = rng.integers(1, 2**62, n, dtype=np.int64)
    df["desig_cat"] = Desig.GAIA_DR3
    df["desig_lo"] = gaia & 0xFFFFFFFF
    df["desig_hi"] = gaia >> 32
    df["desig_str"] = None
    df["name_rank"] = Rank.NONE
    df["name_en"] = None
    df["name_de"] = None
    df["alt"] = None
    df["system_id"] = -1
    # one named star, one string designation, the Sun
    df.loc[0, ["name_rank", "name_en", "name_de"]] = [Rank.BAYER, "Mu Cephei", "My Cephei"]
    df.loc[0, "alt"] = ["HIP 107259"]
    df.loc[1, ["desig_cat", "desig_str"]] = [Desig.STRING, "WISE J085510.83-071442.5"]
    df.loc[2, ["x", "y", "z", "absmag", "logl", "flags"]] = [0.0, 0.0, 0.0, 4.83, 0.0, Flag.SUN]
    return df, gaia


def test_roundtrip(tmp_path: Path):
    stars, gaia = make_stars()
    m = write_dataset(stars, None, tmp_path, sources=[], params={}, capacity=1000, pack_bytes=200_000)
    assert m["starCount"] == len(stars)
    assert sum(e[1] for e in m["nodes"]) == len(stars)
    assert len(m["packs"]) > 1
    seen = np.zeros(len(stars), bool)
    packs = {name: (tmp_path / name).read_bytes() for name in m["packs"]}
    root_entry = m["nodes"][0]
    assert root_entry[0] == "r"
    found_sun_in_root = False
    for path, count, nbytes, mask, pack, offset in m["nodes"]:
        assert offset % 8 == 0
        blob = packs[m["packs"][pack]][offset : offset + nbytes]
        c, h = node_bounds(m, path)
        d = decode_blob(blob, c, h)
        assert d["n"] == count <= 1000
        # every decoded star must lie inside its node cube
        assert np.all(d["pos"] >= c - h - 1e-3) and np.all(d["pos"] <= c + h + 1e-3)
        gid = d["did"][0::2].astype(np.int64) + (d["did"][1::2].astype(np.int64) << 32)
        for i in range(count):
            if d["flags"][i] & Flag.SUN:
                found_sun_in_root = path == "r"
                continue
            if d["dcat"][i] == Desig.GAIA_DR3:
                j = np.nonzero(gaia == gid[i])[0]
                assert len(j) == 1
                j = j[0]
                seen[j] = True
                # float32 rounding only
                assert np.allclose(d["pos"][i], stars.loc[j, ["x", "y", "z"]].to_numpy(float), rtol=1e-6, atol=1e-4)
        if "n" in d["extra"]:
            for entry in d["extra"]["n"]:
                assert entry[2] == "Mu Cephei" and entry[3] == "My Cephei" and entry[4] == ["HIP 107259"]
        if "d" in d["extra"]:
            assert "WISE J085510.83-071442.5" in d["extra"]["d"].values()
    assert found_sun_in_root
    # all Gaia-designated stars were found exactly once (rows 1 and 2 changed designation / are the Sun)
    assert seen.sum() == len(stars) - 2
    search = json.loads((tmp_path / "search.json").read_text())
    assert search[0][0] == "Mu Cephei" and search[0][1] == "My Cephei"


def test_luminosity_order(tmp_path: Path):
    stars, _ = make_stars(5000)
    m = write_dataset(stars, None, tmp_path, sources=[], params={}, capacity=500)
    packs = {name: (tmp_path / name).read_bytes() for name in m["packs"]}
    # the root holds the most luminous stars (besides the Sun)
    path, count, nbytes, mask, pack, offset = m["nodes"][0]
    c, h = node_bounds(m, path)
    d = decode_blob(packs[m["packs"][pack]][offset : offset + nbytes], c, h)
    root_min = np.sort(d["logl"][(d["flags"] & Flag.SUN) == 0])[0] / 1000
    assert root_min >= np.sort(stars["logl"].to_numpy())[::-1][count - 1] - 1e-3
