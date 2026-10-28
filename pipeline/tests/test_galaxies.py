"""The galaxy list (galmap.galaxies): tables, names, matching, orientation and the file layout."""

import json
import math
import struct

import numpy as np
import pandas as pd

from galmap import galaxies as G
from galmap.coords import A_G, unit_vectors

MRT = """Title: Test
================================================================================
Byte-by-byte Description of file: t.txt
--------------------------------------------------------------------------------
   Bytes Format Units  Label  Explanations
--------------------------------------------------------------------------------
   1-  8 A8     ---    Name   Galaxy name
  10- 14 F5.2   Mpc    Dis    ? Distance
  16- 19 A4     ---  f_Dis    Method flag
--------------------------------------------------------------------------------
Note (1): something.
--------------------------------------------------------------------------------
NGC0024   7.67 TRGB
And XVIII 9.99 h
WLM            mem
"""


def test_read_mrt(tmp_path):
    p = tmp_path / "t.txt"
    p.write_text(MRT)
    t = G.read_mrt(p)
    assert list(t.columns) == ["Name", "Dis", "f_Dis"]
    assert t["Name"].tolist() == ["NGC0024", "And XVII", "WLM"]
    assert G.num(t["Dis"])[0] == 7.67 and math.isnan(G.num(t["Dis"])[2])
    assert t["f_Dis"].tolist() == ["TRGB", "h", "mem"]


def test_ungc_names_and_keys():
    assert G.ungc_name("NGC0024") == "NGC 24"
    assert G.ungc_name("ESO349-031") == "ESO 349-031"
    assert G.ungc_name("MESSIER081") == "M 81"
    assert G.ungc_name("HolmIX") == "Holmberg IX"
    assert G.ungc_name("KKH34") == "KKH 34"
    assert G.ungc_name("Sculptor") == "Sculptor"
    assert G.name_key("Messier 81") == G.name_key("M 81") == G.name_key("MESSIER081") == "M81"
    assert G.name_key("ESO 349-031") == G.name_key("ESO 349-31")
    assert G.name_key("And XVIII") == G.name_key("Andromeda XVIII")
    assert G.messier("Messier 101") == "M 101" and G.messier("Andromeda Galaxy") == "Andromeda Galaxy"


def test_catalogue_names_are_not_common_names():
    for name in ["NGC 2442/2443", "UGC 12889", "ESO 349-031", "3C 66B", "KK 246", "2MASX J01234567+0123456", "Holmberg II", "A0952+69"]:
        assert G.CATALOGUE_RE.match(name), name
    for name in ["Andromeda Galaxy", "Bootes I", "Fornax", "Antennae Galaxies", "Leo T", "Sculptor Galaxy", "Barnard's galaxy"]:
        assert not G.CATALOGUE_RE.match(name), name


def test_label_variants():
    v = G.label_variants("Bootes I")
    assert "Boötes I" in v and "Bootes I Dwarf Galaxy" in v
    assert "Andromeda XVI" in G.label_variants("And XVI")


def test_match_takes_the_nearest_within_the_radius():
    tra = np.array([10.0, 10.02, 50.0])
    tdec = np.array([20.0, 20.0, 20.0])
    idx = G.match(np.array([10.019, 30.0]), np.array([20.0, 0.0]), np.array([1.5, 1.5]), tra, tdec)
    assert idx.tolist() == [1, -1]
    # the target's own radius counts too
    idx = G.match(np.array([10.1]), np.array([20.0]), np.array([1.0]), tra, tdec, np.array([0.0, 10.0, 0.0]))
    assert idx.tolist() == [1]


def sky(ra, dec):
    return unit_vectors(np.array([ra]), np.array([dec])) @ A_G.T


def test_orientation():
    ra = np.array([10.0, 10.0, 200.0])
    dec = np.array([41.0, 41.0, -30.0])
    pa = np.array([38.0, 38.0, 120.0])
    q = np.array([1.0, G.Q0, 0.5])
    cls = np.array([G.SPIRAL, G.SPIRAL, G.SPIRAL])
    seed = np.array([1, 2, 3], dtype=np.uint64)
    major, normal = G.orientation(ra, dec, pa, q, cls, seed)
    assert np.allclose(np.linalg.norm(major, axis=1), 1) and np.allclose(np.linalg.norm(normal, axis=1), 1)
    assert np.allclose(np.sum(major * normal, axis=1), 0, atol=1e-9)
    s0, s2 = sky(10.0, 41.0)[0], sky(200.0, -30.0)[0]
    # round on the sky: face on; as thin as a disk can be: edge on; the major axis lies on the sky
    assert abs(abs(normal[0] @ s0) - 1) < 1e-9
    assert abs(normal[1] @ s0) < 1e-9
    assert abs(major[2] @ s2) < 1e-9
    # a disk with axis ratio q seen from the Sun: cos i = sqrt((q² - Q0²) / (1 - Q0²))
    assert abs(abs(normal[2] @ s2) - math.sqrt((0.25 - G.Q0**2) / (1 - G.Q0**2))) < 1e-9


def names_inputs():
    labels = pd.DataFrame(
        {
            "pgc": [2557, 28630, 10],
            "en": ["Andromeda Galaxy", "Messier 81", "ESO-LV 1-2"],
            "de": ["Andromedagalaxie", "Messier 81", ""],
            "enwiki": ["Andromeda Galaxy", "Messier 81", ""],
            "dewiki": ["Andromedagalaxie", "Messier 81", ""],
        }
    )
    codes = pd.DataFrame(
        {
            "pgc": [2557, 2557, 28630, 28630, 77],
            "code": ["M31", "NGC 224", "M81", "NGC 3031", "UGC 99"],
            "catLabel": ["Messier object", "New General Catalogue", "Messier object", "New General Catalogue", "Uppsala General Catalogue"],
        }
    )
    return labels, codes


def test_add_names():
    labels, codes = names_inputs()
    g = pd.DataFrame(
        {
            "pgc": [2557, 28630, 77, 0, 5],
            "ungc_name": [None, "M 81", None, "KK 246", None],
            "lvdb_name": [None, None, "Leo T", "Fornax", None],
            "flags": [0, 0, 0, 0, 0],
        }
    )
    out = G.add_names(g, labels, codes)
    assert out.loc[0, ["name_en", "name_de", "rank"]].tolist() == ["Andromeda Galaxy", "Andromedagalaxie", 0]
    assert "M 31" in out.loc[0, "alt"] and out.loc[0, "designation"] == "PGC 2557"
    # Messier: the short form, in both languages
    assert out.loc[1, "name_en"] == "M 81" and G._text(out.loc[1, "name_de"]) is None and out.loc[1, "rank"] == 1
    # an LVDB name before a UGC number
    assert out.loc[2, "name_en"] == "Leo T" and out.loc[2, "alt"][0] == "UGC 99"
    # no PGC number: the LVDB name first, the catalogue name among the others
    assert out.loc[3, "name_en"] == "Fornax" and out.loc[3, "designation"] == "KK 246"
    assert out.loc[4, "name_en"] == "PGC 5" and out.loc[4, "rank"] == 99
    assert (out["flags"].to_numpy()[:4] & G.F_NAMED).all() and not out["flags"].iat[4] & G.F_NAMED


def test_wikipedia_names_by_label_and_position():
    g = pd.DataFrame(
        {
            "ra": [39.96, 100.0],
            "dec": [-34.5, 10.0],
            "pgc": [0, 0],
            "dist_ly": [4.6e5, 1e6],
            "diam_ly": [2400.0, 1000.0],
            "lvdb_name": ["Fornax", "Carina"],
            "ungc_name": [None, None],
            "name_en": ["Fornax", "Carina"],
            "name_de": [None, None],
            "rank": [4, 4],
            "alt": [[], []],
            "designation": ["Fornax", "Carina"],
            "flags": [0, 0],
        }
    )
    found = pd.DataFrame(
        {
            "label": ["Fornax Dwarf Galaxy", "Carina Dwarf Galaxy"],
            "item": ["Q1", "Q2"],
            "ra": ["39.997", "160.0"],  # Carina's is somewhere else: not the same object
            "dec": ["-34.449", "-50.0"],
            "en": ["Fornax Dwarf Galaxy", "Carina Dwarf Galaxy"],
            "de": ["Fornax-Zwerggalaxie", ""],
            "enwiki": ["Fornax Dwarf Spheroidal Galaxy", "Carina Dwarf"],
            "dewiki": ["Fornax-Zwerggalaxie", ""],
        }
    )
    out = G.wikipedia_names(g, found)
    assert out.loc[0, ["name_en", "name_de", "rank"]].tolist() == ["Fornax Dwarf Galaxy", "Fornax-Zwerggalaxie", 0]
    assert out.loc[0, "alt"] == ["Fornax"] and out.loc[0, "designation"] == "Fornax"
    assert out.loc[1, "name_en"] == "Carina" and out.loc[1, "rank"] == 4


def test_adopt_pgc_merges_a_galaxy_listed_under_the_same_name():
    cf4 = pd.DataFrame({"pgc": [3085], "ra": [13.16], "dec": [-72.8], "dm": [18.96], "e_dm": [0.05], "method": ["Cep"]})
    ungc = pd.DataFrame({"name": ["SMC", "M 81"], "ra": [13.16, 148.89], "dec": [-72.8, 69.07], "dm": [18.9, 27.8], "a26": [300.0, 28.0]})
    lvdb = pd.DataFrame({"name": ["SMC"], "ra": [16.25], "dec": [-72.42], "dm": [18.96], "rhalf": [59.4]})
    g = pd.DataFrame({"ra": [13.16, 148.89, 16.25], "dec": [-72.8, 69.07, -72.42], "pgc": [3085, 0, 0], "cf4": [0, -1, -1], "ungc": [0, 1, -1], "lvdb": [-1, -1, 0]})
    labels, codes = names_inputs()
    wpos = pd.DataFrame({"pgc": [28630], "ra": [148.89], "dec": [69.07]})
    out = G.adopt_pgc(g, cf4, ungc, lvdb, labels, codes, wpos)
    assert len(out) == 2
    assert out.loc[0, ["pgc", "ungc", "lvdb"]].tolist() == [3085, 0, 0]
    assert out.loc[1, "pgc"] == 28630  # M 81 by name


def galaxy_rows():
    return pd.DataFrame(
        {
            "x": [1e6], "y": [-2e6], "z": [3e5], "diam_ly": [5e4], "dist_ly": [2.25e6],
            "mx": [1.0], "my": [0.0], "mz": [0.0], "nx": [0.0], "ny": [0.6], "nz": [0.8],
            "q": [0.5], "cls": [G.LENTICULAR], "logl": [np.nan], "e_dm": [0.1], "method": ["SBF"],
            "flags": [G.F_CF4 | G.F_NAMED], "pgc": [1234],
            "name_en": ["NGC 1"], "name_de": [np.nan], "rank": [2], "alt": [["UGC 2", "PGC 1234"]], "designation": ["PGC 1234"],
        }
    )


def test_write_round_trip(tmp_path):
    meta = G.write(galaxy_rows(), tmp_path)
    data = (tmp_path / "galaxies.bin").read_bytes()
    assert meta["count"] == 2 and len(data) == 2 * G.RECORD.size == 72
    js = json.loads((tmp_path / "galaxies.json").read_text())
    assert js["data"] == "galaxies.bin" and js["recordBytes"] == 36
    # the Milky Way first, as the model
    mw = G.RECORD.unpack_from(data, 0)
    assert mw[11] == G.MILKY_WAY and mw[15] & G.F_MODEL and js["names"][0][:4] == [0, "Milky Way", "Milchstraße", 0]
    r = G.RECORD.unpack_from(data, 36)
    assert r[0:4] == struct.unpack("<4f", struct.pack("<4f", 1e6, -2e6, 3e5, 5e4))
    assert r[4:7] == (127, 0, 0) and r[7:10] == (0, 76, 102)
    assert r[10] == round(0.5 * 255) and r[11] == G.LENTICULAR
    assert r[12] == -32768  # unknown luminosity
    assert r[13] == round(0.1 * math.log(10) / 5 * 200)
    assert G.METHODS[r[14]] == "SBF" and r[15] == G.F_CF4 | G.F_NAMED and r[18] == 1234
    # no NaN in the names; the designation is not repeated among the others
    assert js["names"][1] == [1, "NGC 1", None, 2, "PGC 1234", ["UGC 2"]]
