"""Planet hosts added from the NASA Exoplanet Archive (galmap.hosts)."""

import numpy as np
import pandas as pd

from galmap import hosts as H
from galmap.flags import Desig, Flag, Rank


def raw_planets() -> pd.DataFrame:
    rows = [
        # on the map (Gaia id)
        ("Known b", "Known", "Gaia DR3 111", "", "", "10.0", "20.0", "50", "1", "-1", "Transit"),
        # not on the map: added
        ("Kepler-90 b", "Kepler-90", "Gaia DR3 222", "", "", "284.43", "49.31", "840", "20", "-18", "Transit"),
        ("Kepler-90 c", "Kepler-90", "Gaia DR3 222", "", "", "284.43", "49.31", "840", "20", "-18", "Transit"),
        ("OGLE-2005-BLG-390L b", "OGLE-2005-BLG-390L", "", "", "", "268.58", "-30.38", "6600", "1000", "-1000", "Microlensing"),
        # 1" from a star of the map at another distance: the same star, not added
        ("Near b", "Near", "", "", "", "30.0003", "40.0", "300", "", "", "Radial Velocity"),
        # no distance: not added
        ("Far b", "Far", "", "", "", "50.0", "-10.0", "", "", "", "Imaging"),
    ]
    cols = ["pl_name", "hostname", "gaia_dr3_id", "hip_name", "hd_name", "ra", "dec", "sy_dist", "sy_disterr1", "sy_disterr2", "discoverymethod"]
    df = pd.DataFrame(rows, columns=cols)
    for c, v in (("sy_pmra", "1.0"), ("sy_pmdec", "-2.0"), ("sy_vmag", "13.7"), ("sy_gaiamag", "13.6"), ("st_teff", "6080"), ("st_spectype", "G0V")):
        df[c] = v
    return df


def stars() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "ra": [10.0, 30.0], "dec": [20.0, 40.0], "epoch": [2016.0, 2016.0], "pmra": [0.0, 0.0], "pmdec": [0.0, 0.0],
            "plx": [20.0, 10.0], "gaia": pd.array([111, pd.NA], dtype="Int64"), "hip": pd.array([pd.NA, pd.NA], dtype="Int64"),
            "src": [Flag.SRC_ATHYG, Flag.SRC_ATHYG], "is_sun": [False, False],
        }
    )


def test_adds_the_hosts_the_map_lacks():
    out = H.add_hosts(stars(), raw_planets())
    added = out.iloc[2:]
    assert list(added["host_name"]) == ["Kepler-90", "OGLE-2005-BLG-390L"]
    k = added.iloc[0]
    assert k["src"] == Flag.SRC_EXOPLANET and k["gaia"] == 222
    assert abs(k["plx"] - 1000 / 840) < 1e-12 and abs(k["plx_err"] / k["plx"] - 20 / 840) < 1e-12
    assert k["vmag"] == 13.7 and k["teff_cat"] == 6080 and k["spect"] == "G0V" and k["plx_src"] == "exoplanet"
    assert added.iloc[1]["plx_src"] == "exoplanet_est"  # a microlensing distance
    assert pd.isna(added.iloc[1]["gaia"])
    # the identifiers stay exact integers (a Gaia id as a float would lose its last digits)
    assert str(out["gaia"].dtype) == "Int64" and str(out["hip"].dtype) == "Int64"


def test_keeps_large_gaia_ids_exact():
    raw = raw_planets()
    raw.loc[raw["hostname"] == "Kepler-90", "gaia_dr3_id"] = "Gaia DR3 2135550755683407232"
    out = H.add_hosts(stars(), raw)
    assert out["gaia"].iloc[2] == 2135550755683407232
    assert out["gaia"].iloc[0] == 111


def test_names_them_by_their_archive_name():
    s = pd.DataFrame(
        {
            "host_name": [None, "Kepler-90", "OGLE-2005-BLG-390L"],
            "name_rank": [Rank.IAU, Rank.NONE, Rank.NONE],
            "name_en": ["Sun", None, None],
            "name_de": ["Sonne", None, None],
            "desig_cat": [Desig.STRING, Desig.GAIA_DR3, Desig.STRING],
            "desig_str": ["Sun", None, None],
        }
    )
    assert H.name_hosts(s) == 2
    assert list(s["name_en"]) == ["Sun", "Kepler-90", "OGLE-2005-BLG-390L"]
    assert list(s["name_rank"]) == [Rank.IAU, Rank.SURVEY, Rank.SURVEY]
    # designated by the archive name only where no catalogue designation exists
    assert pd.isna(s.loc[1, "desig_str"]) and s.loc[2, "desig_str"] == "OGLE-2005-BLG-390L"


def test_a_host_next_to_a_star_of_the_map_is_that_star():
    from galmap.sources import exoplanets

    raw = raw_planets()
    # a fast star (900 mas/yr): its archive position 15" from where the map has it
    fast = raw[raw["hostname"] == "Near"].copy()
    fast["hostname"], fast["pl_name"], fast["ra"], fast["dec"], fast["sy_pmra"] = "LHS 1678", "LHS 1678 b", "10.0042", "20.0", "900"
    raw = pd.concat([raw[raw["hostname"] != "Known"], fast], ignore_index=True)
    out = H.add_hosts(stars(), raw)
    assert "LHS 1678" not in list(out["host_name"].dropna())
    assert out.loc[0, "archive_host"] == "LHS 1678" and out.loc[1, "archive_host"] == "Near"
    # the planet counts find them by that name
    counts = exoplanets.attach(out, exoplanets.hosts_of(raw))
    assert counts[0] == 1 and counts[1] == 1 and counts[2] == 2  # LHS 1678, Near, Kepler-90 (two planets)


def test_a_host_next_to_another_host_is_a_star_of_its_own():
    raw = raw_planets()
    comp = raw[raw["hostname"] == "Known"].copy()
    comp["hostname"], comp["pl_name"], comp["gaia_dr3_id"], comp["ra"] = "Known B", "Known B b", "", "10.0002"
    out = H.add_hosts(stars(), pd.concat([raw, comp], ignore_index=True))
    assert "Known B" in list(out["host_name"].dropna())
    assert pd.isna(out.loc[0, "archive_host"])
