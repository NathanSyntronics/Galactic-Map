import numpy as np
import pandas as pd

from galmap import merge
from galmap.flags import Flag


def athyg_frame(rows):
    base = dict(
        id=1, tyc=None, gaia=pd.NA, hyg=pd.NA, hip=pd.NA, hd=pd.NA, hr=pd.NA, gl=None, bayer=None, flam=pd.NA,
        con="Cen", proper=None, dec=0.0, pos_src="T", dist=10.0, dist_src="G_R3", spect=None, pm_src="G_R3",
        mag_src="T", pmra=0.0, pmdec=0.0, ra_deg=10.0, epoch=2000.0, gj=None, vmag=8.0, bv=0.6, is_sun=False,
    )
    df = pd.DataFrame([{**base, **r} for r in rows])
    for c in ("gaia", "hyg", "hip", "hd", "hr", "flam"):
        df[c] = df[c].astype("Int64")
    return df


def gaia_frame(rows):
    base = dict(ra=10.0, dec=0.0, parallax=100.0, parallax_error=0.05, pmra=0.0, pmdec=0.0, ruwe=1.0,
                phot_g_mean_mag=7.8, bp_rp=0.8, parallax_zp=-0.02)
    df = pd.DataFrame([{**base, **r} for r in rows])
    df["source_id"] = df["source_id"].astype("Int64")
    return df


def test_link_gaia_rejects_inconsistent_photometry():
    a = athyg_frame([
        dict(id=1, gaia=111, vmag=1.3),   # bright star linked to a G=20.9 neighbour (like alpha Cen B)
        dict(id=2, gaia=222, vmag=8.0),
    ])
    g = gaia_frame([dict(source_id=111, phot_g_mean_mag=20.9), dict(source_id=222, phot_g_mean_mag=7.8)])
    out = merge.link_gaia(a, g)
    assert list(out["gaia_ok"]) == [False, True]
    assert np.isnan(out.loc[0, "g_parallax"]) and out.loc[1, "g_parallax"] == 100.0


def test_link_gaia_shared_id_keeps_best_match():
    a = athyg_frame([dict(id=1, gaia=333, vmag=8.0), dict(id=2, gaia=333, vmag=11.5)])
    g = gaia_frame([dict(source_id=333, phot_g_mean_mag=7.8)])
    out = merge.link_gaia(a, g)
    assert list(out["gaia_ok"]) == [True, False]


def hyg_frame():
    return pd.DataFrame({"hyg": pd.array([], dtype="Int64"), "hyg_var": [], "hyg_base": [], "hyg_comp": pd.array([], dtype="Int64"), "hyg_proper": []})


def test_athyg_rows_use_gaia_parallax_with_zero_point():
    a = athyg_frame([dict(id=1, gaia=222, dist=9.0)])
    g = gaia_frame([dict(source_id=222, parallax=100.0, parallax_zp=-0.02)])
    rows = merge.athyg_rows(merge.link_gaia(a, g), hyg_frame())
    assert abs(rows.loc[0, "plx"] - 100.02) < 1e-9
    assert rows.loc[0, "plx_src"] == "gaia" and rows.loc[0, "epoch"] == 2016.0


def gcns_frame(rows):
    base = dict(ra=10.0, dec=0.0, plx=50.0, plx_err=0.02, pmra=0.0, pmdec=0.0, gmag=12.0, bpmag=13.0, rpmag=11.0,
                ruwe=1.0, gcns_prob=1.0, wd_prob=0.0, dist50=0.02, dist16=0.02, dist84=0.02, name_2mass=None, jmag=9.0, bp_rp=2.0)
    df = pd.DataFrame([{**base, **r} for r in rows])
    df["source_id"] = df["source_id"].astype("Int64")
    return df


def test_merge_gcns_updates_and_appends():
    a = athyg_frame([dict(id=1, gaia=222)])
    g = gaia_frame([dict(source_id=222)])
    s = merge.athyg_rows(merge.link_gaia(a, g), hyg_frame())
    out = merge.merge_gcns(s, gcns_frame([dict(source_id=222, plx=99.0), dict(source_id=999, plx=40.0)]))
    assert len(out) == 2
    assert out.loc[0, "plx"] == 99.0 and out.loc[0, "src"] & Flag.SRC_GCNS and out.loc[0, "src"] & Flag.SRC_ATHYG
    assert out.loc[1, "gaia"] == 999 and out.loc[1, "src"] == Flag.SRC_GCNS


def census_frame(rows):
    base = dict(
        census_row=0, census_name="X", depth=0, is_leaf=True, parent_row=-1, system_row=0, n_comps_row=1,
        common_name=None, bayer_flamsteed=None, gaia=pd.NA, hip=pd.NA, hd_name=None, hr_name=None, gj=None,
        var_name=None, tyc=None, ra=10.0, dec=0.0, epoch=2016.0, plx=100.0, plx_err=0.01, pmra=0.0, pmdec=0.0,
        spt_opt=None, spt_nir=None, teff=np.nan, mass=np.nan, wd_name=None, gmag=np.nan, bp=np.nan, rp=np.nan,
        jmag=np.nan, n_planets=np.nan, catalog_names=[], system_size=1, bp_rp=np.nan, spect=None,
        brown_dwarf=False, white_dwarf=False,
    )
    df = pd.DataFrame([{**base, **r} for r in rows])
    df["gaia"] = df["gaia"].astype("Int64")
    df["hip"] = df["hip"].astype("Int64")
    return df


def test_merge_census_replaces_unresolved_pair_and_drops_phantoms():
    a = athyg_frame([
        dict(id=1, gaia=500, ra_deg=50.0, dec=10.0),            # Gaia sees an unresolved pair
        dict(id=2, gaia=pd.NA, dist=3.0, dist_src="H", ra_deg=200.0, dec=-30.0, hip=42),  # phantom neighbour
        dict(id=3, gaia=600, ra_deg=100.0, dec=5.0),             # a single census star
    ])
    g = gaia_frame([dict(source_id=500, ra=50.0, dec=10.0), dict(source_id=600, ra=100.0, dec=5.0)])
    s = merge.athyg_rows(merge.link_gaia(a, g), hyg_frame())
    c = census_frame([
        dict(census_row=0, census_name="Pair AB", is_leaf=False, system_row=0, gaia=500, ra=50.0, dec=10.0, system_size=2),
        dict(census_row=1, census_name="Pair A", depth=1, parent_row=0, system_row=0, ra=50.0, dec=10.0, system_size=2),
        dict(census_row=2, census_name="Pair B", depth=1, parent_row=0, system_row=0, ra=50.0, dec=10.0, system_size=2,
             spect="L5", brown_dwarf=True),
        dict(census_row=3, census_name="Single", system_row=3, gaia=600, ra=100.0, dec=5.0, plx=101.0),
    ])
    out = merge.merge_census(s, c)
    names = sorted(n for n in out["census_name"] if isinstance(n, str))
    assert names == ["Pair A", "Pair B", "Single"]
    # the unresolved Gaia row (id 1) was replaced by the two components, the phantom was dropped
    assert len(out) == 3
    single = out[out["census_name"] == "Single"].iloc[0]
    assert single["plx"] == 101.0 and single["src"] & Flag.SRC_CENSUS20 and single["src"] & Flag.SRC_ATHYG
    assert out[out["census_name"] == "Pair B"].iloc[0]["brown_dwarf"]
