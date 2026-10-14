import numpy as np

from galmap.coords import LY_PER_PC, galactic_lb, icrs_to_galactic_xyz
from galmap.flags import Rank, is_giant_spect, spectral_code
from galmap.names import bayer_name, classify_name, flamsteed_name, german_variant, parse_hyg_bayer, prettify_simbad
from galmap.naming import german_of, gliese_display


def test_bayer_and_flamsteed():
    assert bayer_name("Alp", "Cen", component="A") == "Alpha Centauri A"
    assert bayer_name("alf", "CMa") == "Alpha Canis Majoris"
    assert bayer_name("Omi", "Eri", 2) == "Omicron² Eridani"
    assert bayer_name("Mu", "Cep", lang="de") == "My Cephei"
    assert bayer_name("Ups", "And", lang="de") == "Ypsilon Andromedae"
    assert flamsteed_name(61, "Cyg", "A") == "61 Cygni A"
    assert parse_hyg_bayer("Alp-1") == ("Alp", "1")
    assert parse_hyg_bayer("Eps") == ("Eps", None)


def test_simbad_prettify():
    assert prettify_simbad("* alf Cen A") == "Alpha Centauri A"
    assert prettify_simbad("* alf01 Cen") == "Alpha¹ Centauri"
    assert prettify_simbad("* 61 Cyg B") == "61 Cygni B"
    assert prettify_simbad("V* EZ Aqr") == "EZ Aquarii"
    assert prettify_simbad("V* V645 Cen") == "V645 Centauri"
    assert prettify_simbad("NAME Barnard's Star") == "Barnard's Star"
    assert prettify_simbad("* mu. Cep", "de") == "My Cephei"
    assert prettify_simbad("HD  48915") is None


def test_classify():
    assert classify_name("Epsilon Eridani") == Rank.BAYER
    assert classify_name("Alpha¹ Centauri") == Rank.BAYER
    assert classify_name("61 Cygni A") == Rank.FLAMSTEED
    assert classify_name("EZ Aquarii") == Rank.VARIABLE
    assert classify_name("V1216 Sagittarii") == Rank.VARIABLE
    assert classify_name("Wolf 359") == Rank.TRADITIONAL
    assert classify_name("Lalande 21185") == Rank.TRADITIONAL
    assert classify_name("Luhman 16") == Rank.TRADITIONAL
    assert classify_name("Gliese 581") == Rank.GJ
    assert classify_name("GJ 1061") == Rank.GJ
    assert classify_name("HD 10180") == Rank.HD
    assert classify_name("HIP 12345") == Rank.HIP
    assert classify_name("Barnard's Star") == Rank.COMMON
    assert classify_name("Proxima Centauri") == Rank.COMMON
    assert classify_name("2MASS J12345678+1234567") == Rank.OTHER


def test_german():
    assert german_of("Barnard's Star") == "Barnards Pfeilstern"
    assert german_of("Kapteyn's Star") == "Kapteyns Stern"
    assert german_of("Scholz's Star") == "Scholz' Stern"
    assert german_of("Vega") == "Wega"
    assert german_variant("Mu Cephei") == "My Cephei"
    assert german_variant("Omicron² Eridani") == "Omikron² Eridani"
    assert german_of("Sirius") is None


def test_gliese_display():
    assert gliese_display("GJ 551") == "Gliese 551"
    assert gliese_display("GJ 65 A") == "Gliese 65 A"
    assert gliese_display("GJ 1061") == "GJ 1061"
    assert gliese_display("GJ 54.1") == "Gliese 54.1"


def test_spectral_codes():
    assert spectral_code("G2V") == 42
    assert spectral_code("M5.5Ve") == 65
    assert spectral_code("sdM4") == 64
    assert spectral_code("T7.5") == 87
    assert spectral_code("DA2") == 102
    assert spectral_code("") == 255
    assert is_giant_spect("K0III")
    assert is_giant_spect("B8Ia")
    assert not is_giant_spect("K0IV")
    assert not is_giant_spect("M3V")


def test_galactic_frame():
    # Galactic centre direction (Sgr A*) maps to +X, North Galactic Pole to +Z
    xyz = icrs_to_galactic_xyz(266.40500, -28.93617, 1.0)
    assert np.allclose(xyz, [1, 0, 0], atol=1e-4)
    xyz = icrs_to_galactic_xyz(192.85948, 27.12825, 1.0)
    assert np.allclose(xyz, [0, 0, 1], atol=1e-4)
    # Sirius: l = 227.23, b = -8.89, d = 2.637 pc
    xyz = icrs_to_galactic_xyz(101.28715533, -16.71611586, 2.637 * LY_PER_PC)
    l, b = galactic_lb(xyz)
    assert abs(l - 227.23) < 0.01 and abs(b + 8.89) < 0.01
    assert abs(np.linalg.norm(xyz) - 8.601) < 0.01


def test_choose_prefers_wikipedia_title():
    from galmap.naming import P_IAU, P_SIMBAD, P_WIKI, Cand, choose

    ran = Cand("Ran", None, Rank.IAU, P_IAU)
    eps = Cand("Epsilon Eridani", None, Rank.BAYER, P_WIKI)
    assert choose([ran, eps, Cand("eps Eri", None, Rank.BAYER, P_SIMBAD)])[0].en == "Epsilon Eridani"
    # the IAU name wins over a catalogue-style title and over "<IAU name> A"
    assert choose([Cand("Fomalhaut", None, Rank.IAU, P_IAU), Cand("HD 216956", None, Rank.HD, P_WIKI)])[0].en == "Fomalhaut"
    assert choose([Cand("Sirius", None, Rank.IAU, P_IAU), Cand("Sirius A", None, Rank.COMMON, P_WIKI)])[0].en == "Sirius"


def test_wikidata_attach():
    import pandas as pd

    from galmap.sources.wikidata import attach

    wd = pd.DataFrame(
        {
            "qid": ["Q1", "Q2", "Q3"],
            "simbad": [["* eps Eri"], ["NAME Barnard's star"], ["* alf Lyr"]],
            "en": ["Epsilon Eridani", "Barnard's Star", "Vega"],
            "en_is_title": [True, True, True],
            "de": ["Epsilon Eridani", "Barnards Pfeilstern", None],
            "hip": [[16537], [87937], [91262]],
            "gaia": [[], [4472832130942575872], []],
        }
    )
    stars = pd.DataFrame(
        {
            "simbad_main_id": ["* eps Eri", None, None, None],
            "gaia": pd.array([None, 4472832130942575872, None, None], dtype="Int64"),
            "hip": pd.array([16537, None, 91262, 91262], dtype="Int64"),
        }
    )
    out = attach(stars, wd)
    assert out[0]["wiki_en"] == "Epsilon Eridani"
    assert out[1]["wiki_de"] == "Barnards Pfeilstern"
    assert out[2]["wiki_en"] == "Vega" and out[2]["wiki_de"] is None
    assert 3 not in out  # one Wikidata item names one star only
