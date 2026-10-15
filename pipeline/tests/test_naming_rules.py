"""Regression tests for the naming rules (review findings on names.py / naming.py)."""

from galmap.flags import Rank
from galmap.names import classify_name, classify_title, prettify_simbad, split_component_loose


def test_luyten_numbers_are_survey_designations():
    assert prettify_simbad("L 668-21") is None
    assert classify_name("L 668-21") == Rank.SURVEY
    assert classify_name("Luyten 668-21") == Rank.SURVEY
    assert classify_name("Gliese 229") < classify_name("L 668-21")
    assert classify_name("BV Phoenicis") < classify_name("L 220-80")
    # only a Wikipedia title promotes them, and "Luyten's Star" is a name, not a survey number
    assert classify_title("Luyten 726-8") == Rank.SURVEY
    assert classify_name("Luyten's Star") == Rank.COMMON


def test_raw_simbad_identifiers_are_not_names():
    for ident in ("Cl* Melotte 25 S 6", "Cl Melotte 111 132", "GR* 195", "EM* StHA 67", "SV* ZI 2047",
                  "HIDDEN NAME 2M1207", "NAME 17 Com B", "[MFL2000] J2101"):
        assert classify_name(ident) == Rank.OTHER, ident
    assert prettify_simbad("HIDDEN NAME 17 Com B") == "17 Comae Berenices B"
    assert prettify_simbad("HIDDEN NAME 2M1207") is None
    assert prettify_simbad("HIDDEN NAME WD 0551+4135") is None
    # SIMBAD NAMEs with numbers rank below HR / HIP / HD
    assert classify_name(prettify_simbad("NAME 47 Tuc TO Star")) > Rank.HD
    assert classify_name("LoTr 5") > Rank.HD


def test_abbreviated_and_suffixed_forms_are_not_names():
    assert classify_name("BO Mus") == Rank.OTHER
    assert classify_name("iot Cas AB") == Rank.OTHER
    assert prettify_simbad("NAME iot Cas AB") == "Iota Cassiopeiae AB"
    assert prettify_simbad("* gam Vir S") is None  # SIMBAD's position suffix, not a component
    assert classify_name("Gamma Virginis S") == Rank.OTHER
    assert classify_name("Mu Arae b") == Rank.OTHER  # a planet
    assert classify_name("Beta Leonis Minoris") == Rank.BAYER
    assert classify_name("46 Leonis Minoris A") == Rank.FLAMSTEED


def test_component_letters_attached_to_numbers():
    assert split_component_loose("HD 73752A") == ("HD 73752", "A")
    assert split_component_loose("BD-22 2345A") == ("BD-22 2345", "A")
    assert split_component_loose("Sirius B") == ("Sirius", "B")
    assert split_component_loose("LSPM J0016+1951E") == ("LSPM J0016+1951E", None)  # E = east
    assert split_component_loose("LHS 5139a") == ("LHS 5139a", None)


def _frame(rows):
    import numpy as np
    import pandas as pd

    df = pd.DataFrame(rows)
    for c in ("hip", "gaia", "hd"):
        if c not in df:
            df[c] = pd.NA
        df[c] = df[c].astype("Int64")
    for c, v in (("flags", 0), ("system_id", -1), ("ra", 10.0), ("dec", 10.0), ("vmag", np.nan)):
        if c not in df:
            df[c] = v
        df[c] = df[c].fillna(v)
    df["flags"] = df["flags"].astype("int64")
    df["system_id"] = df["system_id"].astype("int64")
    return df


def test_no_two_stars_with_one_name():
    from galmap.flags import Flag
    from galmap.naming import assign_names

    P = int(Flag.SYSTEM_PRIMARY | Flag.IN_SYSTEM)
    C = int(Flag.IN_SYSTEM)
    s = _frame([
        # 57 Aql A/B: both HYG rows carry the Flamsteed number, no component letters -> by brightness
        {"flam": 57, "con": "Aql", "hip": 97966, "vmag": 5.66, "ra": 298.56, "dec": -8.227},
        {"flam": 57, "con": "Aql", "hip": 97967, "vmag": 6.35, "ra": 298.562, "dec": -8.235},
        # CT Cet: HYG puts the variable name on A, SIMBAD on B -> both get their letter
        {"hyg_var": "CT", "con": "Cet", "hip": 5452, "simbad_main_id": "HD 6956A", "flags": P, "system_id": 1},
        {"con": "Cet", "simbad_main_id": "HD 6956B", "flags": C, "system_id": 1},
        # GJ 1006: the census star B was given the SIMBAD object of A (EZ Psc) -> not "EZ Piscium"
        {"census_name": "G 32-7", "census_gj": "GJ 1006 B", "simbad_main_id": "G 32-6", "system_size": 2,
         "system_row": 7, "flags": P, "system_id": 2},
        {"census_name": "G 32-6 A", "var_name": "V* EZ Psc", "system_size": 2, "system_row": 7, "flags": C,
         "system_id": 2, "hip": 1295},
    ])
    ext = {
        3: {"simbad": ["V* CT Cet", "HD 6956B"]},
        4: {"simbad": ["GJ 1006 A", "V* EZ Psc", "G 32-6"]},
    }
    out = assign_names(s, ext)
    names = list(out["name_en"])
    assert names[0] == "57 Aquilae A" and names[1] == "57 Aquilae B"
    assert names[2] == "CT Ceti A" and names[3] == "CT Ceti B"
    assert names[4] == "GJ 1006 B" and names[5] == "EZ Piscium"
    assert len(set(names)) == len(names)
