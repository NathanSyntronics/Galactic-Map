"""NED-D: parsing, one distance per galaxy, positions from designations, merging into the list."""

import numpy as np
import pandas as pd
import pytest

from galmap import galaxies as G
from galmap import nedd


def test_j_position_of_designations():
    ra, dec = nedd.j_position("2MASX J00000755+1554070")
    assert ra == pytest.approx(15 * (7.55 / 3600), abs=1e-9)
    assert dec == pytest.approx(15 + 54 / 60 + 7.0 / 3600, abs=1e-9)
    ra, dec = nedd.j_position("SDSS J025202.64-000131.7")
    assert ra == pytest.approx(15 * (2 + 52 / 60 + 2.64 / 3600))
    assert dec == pytest.approx(-(1 / 60 + 31.7 / 3600))
    assert nedd.j_position("NGC 0224") is None
    assert nedd.j_position("2MASX J25000000+0000000") is None  # no such hour


def test_leda_key_compares_spellings():
    assert nedd.leda_key("ESO 563- G 028") == nedd.leda_key("ESO563-028")
    assert nedd.leda_key("MCG -02-13-038") == nedd.leda_key("MCG-02-13-038")
    assert nedd.leda_key("NGC 0224") == nedd.leda_key("NGC224")
    assert nedd.leda_key("MESSIER 031") == nedd.leda_key("M31")
    assert nedd.leda_key("2MASX J00000755+1554070") == nedd.leda_key("2MASXJ00000755+1554070")
    assert nedd.leda_key("UGC 03657") != nedd.leda_key("UGC 03658")


def test_best_distance_is_the_most_precise_methods_median():
    t = pd.DataFrame(
        {
            "name": ["A", "A", "A", "A", "B", "B"],
            "dm": [30.0, 30.4, 31.0, 29.0, 35.0, 35.2],
            "e_dm": [0.1, 0.1, 0.4, 0.5, np.nan, 0.01],
            "method": ["TRGB", "TRGB", "TF", "FP", "FP", "FP"],
            "ref": ["r1", "r2", "r3", "r4", "r5", "r6"],
        }
    )
    b = nedd.best_distances(t).set_index("name")
    # A: TRGB (typical 0.1 mag) before TF and FP: the median of its two
    assert b.loc["A", "method"] == "TRGB"
    assert b.loc["A", "dm"] == pytest.approx(30.2)
    assert b.loc["A", "n"] == 2
    # A has a fundamental plane distance and a Tully-Fisher one: not early-type
    assert not b.loc["A", "early"]
    # B: fundamental plane only; a missing error is the method's typical one, an implausibly small one at least half of it
    assert b.loc["B", "early"]
    assert b.loc["B", "e_dm"] == pytest.approx(np.median([0.45, 0.225]))


def test_nice_names():
    assert G.nice_name("MESSIER 031") == "M 31"
    assert G.nice_name("UGC 03657") == "UGC 3657"
    assert G.nice_name("ESO 563- G 028") == "ESO 563-28"
    assert G.nice_name("NGC 0224") == "NGC 224"
    assert G.nice_name("MCG -02-13-038") == "MCG -02-13-038"


def test_bibcode_reference():
    assert G.distance_reference("2016A&A...596A..14S") == ("A&A 2016", "2016A&A...596A..14S")
    assert G.distance_reference("Pietrzynski2019Natur.567..200P") == ("Pietrzynski 2019", "2019Natur.567..200P")


def listed():
    """Two listed galaxies (Cosmicflows-4 rows): PGC 1 at 30 mag, PGC 2 at 34 mag."""
    cf4 = pd.DataFrame({"pgc": [1, 2], "ra": [10.0, 50.0], "dec": [0.0, 20.0], "dm": [30.0, 34.0], "e_dm": [0.4, 0.45], "method": ["TF", "FP"]})
    g = pd.DataFrame({"ra": [10.0, 50.0], "dec": [0.0, 20.0], "pgc": [1, 2], "cf4": [0, 1], "ungc": [-1, -1], "lvdb": [-1, -1], "nedd": [-1, -1]})
    ungc = pd.DataFrame({"dm": pd.Series([], dtype=float)})
    lvdb = pd.DataFrame({"dm": pd.Series([], dtype=float)})
    return g, cf4, ungc, lvdb


def test_attach_nedd():
    g, cf4, ungc, lvdb = listed()
    nd = pd.DataFrame(
        {
            "name": ["UGC 1", "2MASX X", "far", "near", "twin", "gc", "2MASX Y", "other"],
            # PGC 1 by number; PGC 2 by number but 1.5 mag off (left out); a new one; one at 3" from PGC 2
            # with another distance (the same galaxy: left out); a second name of the new one; a globular
            # cluster of the Milky Way (too near to be added); one without a PGC number 2" from the new one
            # (counted once); one 1' from PGC 1 with a different distance (a neighbour: added)
            "pgc": [1, 2, 99, 0, 99, 77, 0, 0],
            "ra": [10.0, 50.0, 100.0, 50.0 + 3 / 3600 / np.cos(np.radians(20)), 100.0, 200.0, 100.0 + 2 / 3600, 10.0 + 1 / 60],
            "dec": [0.0, 20.0, -30.0, 20.0, -30.0, 10.0, -30.0, 0.0],
            "dm": [30.2, 35.5, 36.0, 32.0, 36.1, 15.0, 36.0, 33.0],
            "e_dm": [0.1, 0.3, 0.45, 0.45, 0.5, 0.1, 0.45, 0.45],
            "method": ["Cep", "FP", "FP", "FP", "FP", "CMD", "FP", "TF"],
            "ref": [""] * 8,
            "early": [False, True, True, True, True, False, True, False],
        }
    )
    out = G.attach_nedd(g, nd, cf4, ungc, lvdb)
    assert out.loc[0, "nedd"] == 0  # UGC 1 -> PGC 1
    assert out.loc[1, "nedd"] == -1  # disagrees: PGC 2 keeps its own
    added = out.iloc[2:]
    assert sorted(nd["name"].to_numpy()[added["nedd"].to_numpy()]) == ["far", "other"]
    assert set(added["pgc"]) == {99, 0}


def test_nedd_replaces_a_distance_only_with_a_better_method():
    g, cf4, ungc, lvdb = listed()
    nd = pd.DataFrame(
        {
            "name": ["a", "b"], "pgc": [1, 2], "ra": [10.0, 50.0], "dec": [0.0, 20.0],
            # a: Cepheids for a Tully-Fisher galaxy (better); b: a fundamental plane distance with a smaller quoted error (not better)
            "dm": [30.3, 34.2], "e_dm": [0.08, 0.2], "method": ["Cep", "FP"], "ref": ["", ""], "early": [False, True],
        }
    )
    xsc = pd.DataFrame({"ra": [0.0], "dec": [-89.0], "r_ext": [10.0], "sup_ba": [0.5], "k_ba": [0.5], "sup_phi": [0.0], "k_phi": [0.0], "k_m_ext": [10.0]})
    labels = pd.DataFrame({"pgc": pd.Series([], dtype=np.int64), "en": [], "de": [], "enwiki": [], "dewiki": []})
    codes = pd.DataFrame({"pgc": pd.Series([], dtype=np.int64), "code": [], "catLabel": []})
    wpos = pd.DataFrame({"pgc": pd.Series([], dtype=np.int64), "ra": [], "dec": []})
    ungc = pd.DataFrame({c: pd.Series([], dtype=float) for c in ("ra", "dec", "dm", "e_dm", "a26", "ba", "ttype", "logkl", "absb")})
    ungc["name"] = pd.Series([], dtype=object)
    ungc["method"] = pd.Series([], dtype=object)
    ungc["tdw"] = pd.Series([], dtype=object)
    lvdb = pd.DataFrame({c: pd.Series([], dtype=float) for c in ("ra", "dec", "dm", "e_dm", "rhalf", "ell", "pa", "absv")})
    for c in ("name", "method", "host", "ref"):
        lvdb[c] = pd.Series([], dtype=object)
    cf4["has_tf"] = [True, False]
    cf4["early"] = [False, True]
    t = G.galaxy_table(cf4, ungc, lvdb, xsc, labels, codes, wpos, nd).set_index("pgc")
    assert t.loc[1, "method"] == "Cep" and t.loc[1, "dm"] == pytest.approx(30.3)
    assert t.loc[2, "method"] == "FP" and t.loc[2, "dm"] == pytest.approx(34.0)
    assert t.loc[1, "flags"] & G.F_NEDD and t.loc[2, "flags"] & G.F_CF4
