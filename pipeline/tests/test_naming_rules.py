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


def test_wds_discoverer_codes():
    assert prettify_simbad("** STF 2398A") == "Struve 2398 A"
    assert prettify_simbad("** KR 60B") == "Kruger 60 B"
    assert prettify_simbad("** LUH 4A") is None  # HN Pegasi A, not "Luhman 4 A"
    assert prettify_simbad("NAME Luhman 16") == "Luhman 16"


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
    # a lower-case letter after a number is no name ("GJ 810 a" in SIMBAD, planets)
    assert classify_name("GJ 810 a") == Rank.OTHER and classify_name("Gliese 876 b") == Rank.OTHER
    assert classify_title("HN Pegasi b") == Rank.SURVEY  # only a Wikipedia title makes it a name (a brown dwarf)


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


def test_wikipedia_title_rules():
    from galmap.naming import P_IAU, P_SIMBAD, P_WIKI, Cand, choose

    # a Gliese / survey title beats the IAU name, which stays the first alternative
    best, alts = choose([Cand("Noquisi", None, Rank.IAU, P_IAU), Cand("Gliese 436", None, Rank.GJ, P_WIKI)])
    assert best.en == "Gliese 436" and alts[0] == "Noquisi"
    # "<IAU name> A" as title -> the IAU name
    assert choose([Cand("Sirius", None, Rank.IAU, P_IAU), Cand("Sirius A", None, Rank.COMMON, P_WIKI)])[0].en == "Sirius"
    # an HD title is not preferred over names, but over other catalogue numbers
    assert choose([Cand("C Carinae", None, Rank.BAYER, P_SIMBAD), Cand("HD 69863", None, Rank.HD, P_WIKI)])[0].en == "C Carinae"
    best = choose([Cand("LSPM J0633+0527", None, Rank.SURVEY, P_SIMBAD), Cand("HD 46375", None, Rank.HD, P_WIKI)])[0]
    assert best.en == "HD 46375" and best.rank == Rank.SURVEY
    # Gould numbers are used like Flamsteed numbers
    assert classify_name("82 G. Eridani") == Rank.FLAMSTEED


def test_wikidata_codes_pass():
    import pandas as pd

    from galmap.sources.wikidata import attach, code_key

    assert code_key("ο² Eri") == "omicron2eridani" and code_key("GJ 166") == "gj166"
    assert code_key("ADS 3093 ABC") is None and code_key("Gl 105.5") != code_key("GJ 1055")
    wd = pd.DataFrame(
        {
            "qid": ["Q1"], "simbad": [[]], "en": ["40 Eridani"], "de": [None], "en_label": [None], "de_label": [None],
            "hip": [[]], "gaia": [[]], "stellar": [True], "codes": [["GJ 166", "40 Eri", "ADS 3093 ABC"]], "system": [True],
        }
    )
    stars = pd.DataFrame(
        {
            "simbad_main_id": ["* omi02 Eri B", "* omi02 Eri"],
            "gj": ["GJ 166 B", "GJ 166 A"],
            "gaia": pd.array([None, None], dtype="Int64"),
            "hip": pd.array([None, 19849], dtype="Int64"),
            "flags": [4, 12],
        }
    )
    out = attach(stars, wd, {1: ["* 40 Eri", "* omi02 Eri"]})
    assert out == {1: {"wiki_en": "40 Eridani", "wiki_de": None, "label_en": None, "label_de": None, "wiki_system": True}}


P_FLAGS = 12  # IN_SYSTEM | SYSTEM_PRIMARY
C_FLAGS = 4  # IN_SYSTEM


def test_companions_keep_their_own_names():
    from galmap.naming import assign_names

    s = _frame([
        # Capella: the red dwarf "Capella H" (census nickname) is not renamed "Capella A"
        {"census_name": "alpha Aur Aa", "system_size": 3, "system_row": 1, "flags": P_FLAGS, "system_id": 1, "hip": 24608},
        {"census_name": 'G 96-29 A "Capella H"', "census_gj": "GJ 195 A", "system_size": 2, "system_row": 2, "flags": C_FLAGS, "system_id": 1},
        # Gliese 229 B keeps its Wikipedia title next to the primary
        {"census_name": "Gl 229 A", "census_gj": "GJ 229 A", "system_size": 2, "system_row": 3, "flags": P_FLAGS, "system_id": 2, "hip": 29295},
        {"census_name": "Gl 229 B", "system_size": 2, "system_row": 3, "flags": C_FLAGS, "system_id": 2},
        # a wide system of two pairs: Struve 2576 A/B must not become a second 17 Cygni A/B
        {"gj": "GJ 767.1 A", "simbad_main_id": "* 17 Cyg", "flags": P_FLAGS, "system_id": 3, "hip": 97295},
        {"gj": "GJ 767.1 B", "simbad_main_id": "* 17 Cyg B", "flags": C_FLAGS, "system_id": 3},
        {"gj": "GJ 765.4 A", "simbad_main_id": "HD 186858A", "flags": C_FLAGS, "system_id": 3, "hip": 97222},
        {"gj": "GJ 765.4 B", "simbad_main_id": "HD 186858B", "flags": C_FLAGS, "system_id": 3},
    ])
    ext = {
        0: {"iau": "Capella", "wiki_en": "Capella"},
        2: {"wiki_en": "Gliese 229"},
        3: {"wiki_en": "Gliese 229 B"},
        4: {"simbad": ["* 17 Cyg", "GJ 767.1 A"]},
        5: {"simbad": ["* 17 Cyg B", "GJ 767.1 B"]},
        6: {"simbad": ["** STF 2576A", "GJ 765.4 A"]},
        7: {"simbad": ["** STF 2576B", "GJ 765.4 B"]},
    }
    names = list(assign_names(s, ext)["name_en"])
    assert names[1] == "Capella H"
    assert names[2] == "Gliese 229 A" and names[3] == "Gliese 229 B"
    assert names[4:] == ["17 Cygni A", "17 Cygni B", "Struve 2576 A", "Struve 2576 B"]


def test_iau_name_plus_letter_follows_the_primary():
    from galmap.naming import assign_names

    s = _frame([
        # Zeta Herculis = Tianji: AT-HYG calls the companion "Tianji B"
        {"census_name": "zeta Her A", "system_size": 2, "system_row": 1, "flags": P_FLAGS, "system_id": 1, "hip": 81693},
        {"census_name": "zeta Her B", "proper": "Tianji B", "system_size": 2, "system_row": 1, "flags": C_FLAGS, "system_id": 1},
        # Algieba B is not linked into a system with Gamma Leonis (4.6" away)
        {"proper": "Algieba", "hip": 50583, "ra": 154.993, "dec": 19.8415},
        {"proper": "Algieba B", "hd": 89485, "ra": 154.9935, "dec": 19.8405},
    ])
    ext = {
        0: {"iau": "Tianji", "wiki_en": "Zeta Herculis"},
        2: {"iau": "Algieba", "wiki_en": "Gamma Leonis", "wiki_de": "Algieba"},
    }
    out = assign_names(s, ext)
    names = list(out["name_en"])
    assert names[0] == "Zeta Herculis A" and names[1] == "Zeta Herculis B"
    assert names[2] == "Gamma Leonis" and names[3] == "Gamma Leonis B"
    assert out["name_de"].iloc[3] == "Algieba B"
    assert out["alt"].iloc[0][0] == "Tianji"  # the IAU name stays the first alternative
    assert out["system_name_en"].iloc[0] == "Zeta Herculis"


def test_census_sibling_and_system_names():
    from galmap.naming import assign_names

    s = _frame([
        # GJ 1245: the Wikipedia title is on the pair G 208-44 A; its unnamed sibling Ab follows
        {"census_name": "G 208-45", "census_gj": "GJ 1245 B", "system_size": 3, "system_row": 1, "flags": P_FLAGS, "system_id": 1},
        {"census_name": "G 208-44 Aa", "system_size": 3, "system_row": 1, "flags": C_FLAGS, "system_id": 1},
        {"census_name": "G 208-44 Ab", "system_size": 3, "system_row": 1, "flags": C_FLAGS, "system_id": 1},
        # 59 Virginis: the system is named after the primary's name, not the Latin Bayer letter "e Virginis"
        {"census_name": "e Vir Aa", "simbad_main_id": "* e Vir", "system_size": 2, "system_row": 2, "flags": P_FLAGS, "system_id": 2, "hip": 64792},
        {"census_name": "e Vir Ab", "system_size": 2, "system_row": 2, "flags": C_FLAGS, "system_id": 2},
        # a census name that is a real name is kept: "QY Aurigae B" next to "Gliese 268"
        {"census_name": "QY Aur A", "system_size": 2, "system_row": 3, "flags": P_FLAGS, "system_id": 3, "hip": 34603},
        {"census_name": "QY Aur B", "system_size": 2, "system_row": 3, "flags": C_FLAGS, "system_id": 3},
    ])
    ext = {1: {"wiki_en": "GJ 1245"}, 3: {"wiki_en": "59 Virginis", "simbad": ["* e Vir", "* 59 Vir"]}, 5: {"wiki_en": "Gliese 268"}}
    out = assign_names(s, ext)
    assert out["name_en"].iloc[5] == "Gliese 268" and out["name_en"].iloc[6] == "QY Aurigae B"
    assert list(out["name_en"].iloc[:3]) == ["GJ 1245 B", "GJ 1245 Aa", "GJ 1245 Ab"]
    assert out["name_en"].iloc[3] == "59 Virginis Aa" and out["name_en"].iloc[4] == "59 Virginis Ab"
    assert out["system_name_en"].iloc[3] == "59 Virginis"


def test_wikipedia_spelling_and_german_names():
    from galmap.naming import assign_names

    s = _frame([
        {"simbad_main_id": "* f Eri", "hip": 17797},
        {"simbad_main_id": "* b01 Hya", "hip": 52737},
        {"simbad_main_id": "* nu.01 Col", "hip": 26412},
        {"census_name": "HD 217987", "hip": 114046},
        {"census_name": "HD 88230", "hip": 49908},
        {"simbad_main_id": "V* AB Dor", "hip": 25647},
    ])
    ext = {
        0: {"wiki_en": "F Eridani", "simbad": ["* f Eri"]},
        1: {"wiki_en": "B1 Hydrae", "simbad": ["* b01 Hya"]},
        2: {"wiki_en": "Nu1 Columbae"},
        3: {"wiki_en": "Gliese 887", "wiki_de": "Lacaille 9352"},
        4: {"wiki_en": "Groombridge 1618", "wiki_de": "GJ 380"},
        5: {"wiki_en": "AB Doradus", "wiki_de": "AB Doradus"},
    }
    out = assign_names(s, ext)
    assert list(out["name_en"]) == ["f Eridani", "b¹ Hydrae", "Nu¹ Columbae", "Gliese 887", "Groombridge 1618", "AB Doradus"]
    de = list(out["name_de"])
    assert de[2] == "Ny¹ Columbae"
    assert de[3] == "Lacaille 9352"  # the German title is kept for an English Gliese number
    assert not isinstance(de[4], str)  # a German title of a worse kind (a Gliese number) is not used
    assert not isinstance(de[5], str)  # the same as the English name


def test_census_strings_and_simbad_alias_order():
    from galmap.naming import Cand, P_CENSUS, candidates, census_display, choose

    assert census_display("YY Gem A (alpha Gem C)") == "YY Geminorum A"
    assert census_display("2MASS J07003664+3157266 [C]") == "2MASS J07003664+3157266 C"
    assert census_display("** WJG 5C") == "WJG 5C"
    assert census_display("DENIS J063001.4-184014 (C)") == "DENIS J063001.4-184014 C"  # a component, not a note
    assert census_display("Mothallah (A?)") == "Mothallah"
    cands = candidates({"census_name": "YY Gem A (alpha Gem C)", "flags": 0}, {"simbad": ["NAME Castor C"]})
    assert choose(cands)[0].en == "Castor C"
    assert all(c.rank != Rank.COMMON for c in cands if c.src == "census")
    # the main id's unlettered alias wins the tie over "* del Tuc B"
    best = choose(candidates({"simbad_main_id": "* del Tuc", "flags": 0}, {"simbad": ["* del Tuc B", "* del Tuc A", "* del Tuc"]}))[0]
    assert best.en == "Delta Tucanae"
    assert isinstance(Cand("x", None, 1, P_CENSUS), Cand)


def test_iau_names_by_designation():
    import pandas as pd

    from galmap.build import external_names

    s = _frame([
        {"census_name": "L 119-213", "simbad_main_id": "L 119-213"},  # LHS 3844 in SIMBAD's identifiers
        {"simbad_main_id": "WASP-17"},
        {"census_name": "L 97-3 A", "census_gj": "GJ 3483 A", "flags": P_FLAGS, "system_id": 1},
        {"census_name": "L 97-3 B", "flags": C_FLAGS, "system_id": 1},
        {"hip": 71683, "census_name": "alpha Cen A"},
    ])
    iau = pd.DataFrame(
        {
            "name": ["Batsũ̀", "Dìwö", "Maru", "Rigil Kentaurus"],
            "hip": pd.array([None, None, None, 71683], dtype="Int64"),
            "designation": ["LHS 3844", "WASP-17", "WD 0806−661", "HR 5459"],
        }
    )
    ext = {0: {"simbad": ["LHS 3844", "L 119-213"]}, 2: {"simbad": ["WD 0806-661", "L 97-3"]}, 3: {"simbad": ["WD 0806-661 B"]}}
    out = external_names(s, iau, ext)
    assert out[0]["iau"] == "Batsũ̀" and out[1]["iau"] == "Dìwö"
    assert out[2]["iau"] == "Maru" and "iau" not in out[3]
    assert out[4]["iau"] == "Rigil Kentaurus"


def test_sub_components_keep_their_own_letter():
    from galmap.naming import assign_names
    from galmap.verify import nested_letters

    s = _frame([
        # Castor: SIMBAD's "NAME Castor A" is the A pair; the census star alpha Gem Ab is "Castor Ab"
        {"census_name": "alpha Gem Aa", "system_size": 6, "system_row": 1, "flags": P_FLAGS, "system_id": 1, "hip": 36850,
         "simbad_main_id": "* alf Gem"},
        {"census_name": "alpha Gem Ab", "simbad_main_id": "* alf Gem A", "simbad_match": "pos", "system_size": 6,
         "system_row": 1, "flags": C_FLAGS, "system_id": 1},
        {"census_name": "alpha Gem Ba", "simbad_main_id": "* alf Gem B", "system_size": 6, "system_row": 1, "flags": C_FLAGS,
         "system_id": 1},
        {"census_name": "alpha Gem Bb", "system_size": 6, "system_row": 1, "flags": C_FLAGS, "system_id": 1},
        # "Castor C" is the pair YY Gem A+B: neither component is shown under it
        {"census_name": "YY Gem A (alpha Gem C)", "proper": "Castor C", "gj": "GJ 278 C", "system_size": 6, "system_row": 1,
         "flags": C_FLAGS, "system_id": 1},
        {"census_name": "YY Gem B (alpha Gem D)", "simbad_main_id": "V* YY Gem", "simbad_match": "pos", "system_size": 6,
         "system_row": 1, "flags": C_FLAGS, "system_id": 1},
        # beta Aql: "Alshain B" (IAU name + letter) on the census star Ba
        {"census_name": "beta Aql A", "system_size": 3, "system_row": 2, "flags": P_FLAGS, "system_id": 2, "hip": 98036},
        {"census_name": "beta Aql Ba", "proper": "Alshain B", "system_size": 3, "system_row": 2, "flags": C_FLAGS, "system_id": 2},
        {"census_name": "beta Aql Bb", "system_size": 3, "system_row": 2, "flags": C_FLAGS, "system_id": 2},
        # HD 73752 = GJ 314: "BD-22 2345A" is the A pair; its component Ab follows "Gliese 314 Aa"
        {"census_name": "HD 73752 Aa", "gj": "GJ 314 A", "system_size": 3, "system_row": 3, "flags": P_FLAGS, "system_id": 3,
         "hip": 42430},
        {"census_name": "HD 73752 Ab", "simbad_main_id": "HD 73752A", "simbad_match": "pos", "system_size": 3, "system_row": 3,
         "flags": C_FLAGS, "system_id": 3},
        {"census_name": "HD 73752 B", "census_gj": "GJ 314 B", "system_size": 3, "system_row": 3, "flags": C_FLAGS, "system_id": 3},
    ])
    ext = {
        0: {"iau": "Castor", "wiki_en": "Castor (star)", "simbad": ["* alf Gem", "NAME Castor"]},
        1: {"simbad": ["* alf Gem A", "NAME Castor A", "GJ 278 A"]},
        2: {"simbad": ["* alf Gem B", "NAME Castor B", "GJ 278 B"]},
        5: {"simbad": ["V* YY Gem", "NAME Castor C", "GJ 278 C", "GJ 278 D"]},
        6: {"iau": "Alshain", "wiki_en": "Beta Aquilae", "wiki_de": "Alschain"},
        10: {"simbad": ["HD 73752A", "BD-22 2345A"]},
    }
    out = assign_names(s, ext)
    names = list(out["name_en"])
    assert names[:4] == ["Castor Aa", "Castor Ab", "Castor Ba", "Castor Bb"]
    assert names[4:6] == ["YY Geminorum A", "YY Geminorum B"]
    assert all("Castor C" in out["alt"].iloc[i] for i in (4, 5))
    assert names[6:9] == ["Beta Aquilae A", "Beta Aquilae Ba", "Beta Aquilae Bb"]
    assert out["name_de"].iloc[7] == "Alschain Ba"
    assert names[9:] == ["Gliese 314 Aa", "Gliese 314 Ab", "Gliese 314 B"]
    search = [[n, None, "r", k, 0.0, 0.0, float(k // 6), 1] for k, n in enumerate(names)]
    assert nested_letters(search) == []
    assert nested_letters([["Castor A", None, "r", 0, 0, 0, 0, 1], ["Castor Aa", None, "r", 1, 0, 0, 0.1, 1]]) == ["Castor A"]


def test_system_article_titles_name_the_system():
    from galmap.naming import assign_names

    s = _frame([
        # 40 Eridani: the article is about the system; the primary is "40 Eridani A" (German "Keid A")
        {"census_name": "omicron02 Eri A", "simbad_main_id": "* omi02 Eri", "system_size": 3, "system_row": 1,
         "flags": P_FLAGS, "system_id": 1, "hip": 19849},
        {"census_name": "omicron02 Eri B", "simbad_main_id": "* omi02 Eri B", "system_size": 3, "system_row": 1,
         "flags": C_FLAGS, "system_id": 1},
        # Epsilon Lyrae (the Double Double): a member keeps its own name, the title names the system
        {"simbad_main_id": "* eps01 Lyr A", "flags": P_FLAGS, "system_id": 2},
        {"simbad_main_id": "* eps02 Lyr A", "flags": C_FLAGS, "system_id": 2, "hip": 91926},
        {"simbad_main_id": "* eps02 Lyr B", "flags": C_FLAGS, "system_id": 2},
        # 30 Arietis: the star is "30 Arietis A" in SIMBAD
        {"simbad_main_id": "* 30 Ari A", "flags": P_FLAGS, "system_id": 3, "hip": 12189},
        {"simbad_main_id": "* 30 Ari B", "flags": C_FLAGS, "system_id": 3, "hip": 12184},
        # 81 Cancri is not resolved into components in our data: it is the system
        {"simbad_main_id": "* pi.01 Cnc", "gj": "GJ 337 A", "hip": 45170},
    ])
    ext = {
        0: {"iau": "Keid", "wiki_en": "40 Eridani", "wiki_de": "Keid", "wiki_system": True},
        1: {"simbad": ["* omi02 Eri B", "* 40 Eri B"]},
        2: {"simbad": ["* eps01 Lyr A"]},
        3: {"wiki_en": "Epsilon Lyrae", "wiki_de": "Epsilon Lyrae", "wiki_system": True, "simbad": ["* eps02 Lyr A"]},
        4: {"simbad": ["* eps02 Lyr B"]},
        5: {"wiki_en": "30 Arietis", "wiki_system": True, "simbad": ["* 30 Ari A"]},
        6: {"simbad": ["* 30 Ari B"]},
        7: {"wiki_en": "81 Cancri", "wiki_system": True, "simbad": ["* pi.01 Cnc", "* 81 Cnc"]},
    }
    out = assign_names(s, ext)
    names = list(out["name_en"])
    assert names[0] == "40 Eridani A" and out["name_de"].iloc[0] == "Keid A"
    assert names[1] == "40 Eridani B"
    assert out["system_name_en"].iloc[0] == "40 Eridani" and out["system_name_de"].iloc[0] == "Keid"
    assert names[2:5] == ["Epsilon¹ Lyrae A", "Epsilon² Lyrae A", "Epsilon² Lyrae B"]
    assert not isinstance(out["name_de"].iloc[3], str)  # not the German title of the system
    assert "Epsilon Lyrae" in out["alt"].iloc[3]
    assert out["system_name_en"].iloc[2] == "Epsilon Lyrae"
    assert names[5:7] == ["30 Arietis A", "30 Arietis B"] and out["system_name_en"].iloc[5] == "30 Arietis"
    assert names[7] == "81 Cancri"


def test_system_article_of_an_unresolved_pair():
    import pandas as pd

    from galmap.naming import assign_names
    from galmap.sources.wikidata import attach

    # Gliese 65 (= Luyten 726-8): SIMBAD id of the unresolved pair, our stars are its components
    wd = pd.DataFrame(
        {
            "qid": ["Q494595"], "simbad": [["G 272-61"]], "en": ["Gliese 65"], "de": ["Luyten 726-8"],
            "en_label": [None], "de_label": [None], "hip": [[]], "gaia": [[]], "stellar": [True], "codes": [[]],
            "system": [False],
        }
    )
    s = _frame([
        {"census_name": "G 272-61 A", "simbad_main_id": "G 272-61A", "var_name": "V* BL Cet", "system_size": 2,
         "system_row": 1, "flags": P_FLAGS, "system_id": 1},
        {"census_name": "G 272-61 B", "simbad_main_id": "G 272-61B", "var_name": "V* UV Cet", "system_size": 2,
         "system_row": 1, "flags": C_FLAGS, "system_id": 1},
        # a star of another system with the same letter-stripped id is not matched
        {"simbad_main_id": "G 272-61C", "flags": P_FLAGS, "system_id": 2},
    ])
    ext = attach(s, wd)
    assert ext == {}  # the id matches two systems
    s.loc[2, "system_id"] = 1
    s.loc[2, "flags"] = C_FLAGS
    ext = attach(s, wd)
    assert ext == {0: {"sys_wiki_en": "Gliese 65", "sys_wiki_de": "Luyten 726-8"}}
    out = assign_names(s, ext)
    assert list(out["name_en"])[:2] == ["BL Ceti", "UV Ceti"]  # the title names the system, not a star
    assert out["system_name_en"].iloc[0] == "Gliese 65"
    assert "Gliese 65" in out["alt"].iloc[0]


def test_no_letter_after_a_lower_case_letter():
    from galmap.naming import assign_names

    s = _frame([
        # LP 756-19 = GJ 810 A: SIMBAD's alias "GJ 810 a" is not a name ("GJ 810 a Aa")
        {"census_name": "LP 756-19 Aa", "gj": "GJ 810 A", "simbad_main_id": "LP 756-19", "simbad_match": "pos",
         "system_size": 3, "system_row": 1, "flags": P_FLAGS, "system_id": 1},
        {"census_name": "LP 756-19 Ab", "system_size": 3, "system_row": 1, "flags": C_FLAGS, "system_id": 1},
        {"census_name": "LP 756-18", "census_gj": "GJ 810 B", "system_size": 3, "system_row": 1, "flags": C_FLAGS, "system_id": 1},
    ])
    ext = {0: {"simbad": ["GJ 810 A", "GJ 810 a", "LP 756-19", "LHS 501"]}}
    names = list(assign_names(s, ext)["name_en"])
    assert names == ["Gliese 810 Aa", "Gliese 810 Ab", "Gliese 810 B"]


def test_census_objects_keep_a_name():
    from galmap.flags import Desig
    from galmap.naming import assign_names

    s = _frame([
        # alpha Tri: SIMBAD calls the census star 2MASS J01530103+2937044 "* alf Tri B", the census
        # has its own alpha Tri B -> the 2MASS star keeps its census designation as its name, and its
        # designation is not the other star's name
        {"census_name": "alpha Tri A", "simbad_main_id": "* alf Tri", "system_size": 3, "system_row": 1, "flags": P_FLAGS,
         "system_id": 1, "hip": 8796},
        {"census_name": "alpha Tri B", "system_size": 3, "system_row": 1, "flags": C_FLAGS, "system_id": 1},
        {"census_name": "2MASS J01530103+2937044", "simbad_main_id": "* alf Tri B", "simbad_match": "gaia",
         "system_size": 3, "system_row": 1, "flags": C_FLAGS, "system_id": 1, "gaia": 299467939039225728},
        # a raw census code is no name, but another designation of the object is
        {"census_name": "[BHR2005] 832-2", "catalog_names": ["2MASS J03111547+0106307"], "gaia": 3266937637860051840},
        # a system without any name: its label is the census designation without the primary's letter
        {"census_name": "[MFL2000] J210104.18+030705.1 A", "system_size": 2, "system_row": 2, "flags": P_FLAGS, "system_id": 2},
        {"census_name": "[MFL2000] J210104.18+030705.1 B", "system_size": 2, "system_row": 2, "flags": C_FLAGS, "system_id": 2},
    ])
    ext = {0: {"wiki_en": "Alpha Trianguli", "iau": "Mothallah"}, 2: {"simbad": ["* alf Tri B", "2MASS J01530103+2937044"]}}
    out = assign_names(s, ext)
    names = list(out["name_en"])
    assert names[1] == "Alpha Trianguli B"
    assert names[2] == "2MASS J01530103+2937044" and "Alpha Trianguli B" in out["alt"].iloc[2]
    assert out["desig_cat"].iloc[2] == Desig.GAIA_DR3  # not "Alpha Trianguli B"
    assert names[3] == "2MASS J03111547+0106307" and "[BHR2005] 832-2" in out["alt"].iloc[3]
    assert not isinstance(names[4], str) and not isinstance(names[5], str)
    assert out["system_name_en"].iloc[4] == "[MFL2000] J210104.18+030705.1"


def test_census_designations_without_notes():
    from galmap.naming import assign_names, primary_designation

    assert primary_designation({"census_name": "YY Gem B (alpha Gem D)"})[3] == "YY Gem B"
    assert primary_designation({"census_name": "2MASS J07003664+3157266 [C]"})[3] == "2MASS J07003664+3157266 C"
    s = _frame([
        {"census_name": "DENIS J063001.4-184014 A", "system_size": 3, "system_row": 1, "flags": P_FLAGS, "system_id": 1},
        {"census_name": "DENIS J063001.4-184014 B", "system_size": 3, "system_row": 1, "flags": C_FLAGS, "system_id": 1},
        {"census_name": "DENIS J063001.4-184014 (C)", "system_size": 3, "system_row": 1, "flags": C_FLAGS, "system_id": 1},
    ])
    names = list(assign_names(s, {})["name_en"])
    assert names == ["DENIS J063001.4-184014 A", "DENIS J063001.4-184014 B", "DENIS J063001.4-184014 C"]


def test_hd_number_beats_durchmusterung_number():
    from galmap.flags import Rank
    from galmap.naming import P_SIMBAD, Cand, prefer_hd_over_durchmusterung

    best = Cand("BD+16 523", None, Rank.SURVEY, P_SIMBAD, src="simbad")
    out, alts = prefer_hd_over_durchmusterung(best, ["HR 1201"], {"hd": 24357})
    assert out.en == "HD 24357" and alts[0] == "BD+16 523"
    # without an HD number, or for real survey names, nothing changes
    assert prefer_hd_over_durchmusterung(best, [], {"hd": None})[0].en == "BD+16 523"
    lhs = Cand("LHS 288", None, Rank.SURVEY, P_SIMBAD, src="simbad")
    assert prefer_hd_over_durchmusterung(lhs, [], {"hd": 123})[0].en == "LHS 288"
