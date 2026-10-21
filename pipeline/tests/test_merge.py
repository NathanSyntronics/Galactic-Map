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
    assert list(out["gaia_status"]) == ["rejected", "ok"]
    assert np.isnan(out.loc[0, "g_parallax"]) and out.loc[1, "g_parallax"] == 100.0


def test_link_gaia_shared_id_keeps_best_match():
    a = athyg_frame([dict(id=1, gaia=333, vmag=8.0), dict(id=2, gaia=333, vmag=11.5)])
    g = gaia_frame([dict(source_id=333, phot_g_mean_mag=7.8)])
    out = merge.link_gaia(a, g)
    assert list(out["gaia_status"]) == ["ok", "loser"]


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
    # the row already present keeps its zero-point corrected Gaia DR3 parallax
    assert abs(out.loc[0, "plx"] - 100.02) < 1e-9 and out.loc[0, "src"] & Flag.SRC_GCNS and out.loc[0, "src"] & Flag.SRC_ATHYG
    assert out.loc[1, "gaia"] == 999 and out.loc[1, "src"] == Flag.SRC_GCNS
    # new GCNS rows get a zero point too (global value without the Gaia table)
    assert abs(out.loc[1, "plx"] - 40.017) < 1e-9


def test_merge_gcns_uses_dr3_zero_point_from_gaia_table():
    a = athyg_frame([dict(id=1, gaia=222)])
    g = gaia_frame([dict(source_id=222), dict(source_id=999, parallax=40.0, parallax_zp=-0.03, ruwe=2.0, parallax_error=0.1)])
    s = merge.athyg_rows(merge.link_gaia(a, g), hyg_frame())
    out = merge.merge_gcns(s, gcns_frame([dict(source_id=999, plx=40.0)]), g)
    assert abs(out.loc[1, "plx"] - 40.03) < 1e-9 and abs(out.loc[1, "plx_err"] - 0.2) < 1e-9  # error inflated by RUWE


def hip_frame(rows):
    return pd.DataFrame([{**dict(ra=10.0, dec=0.0, pm_ra=0.0, pm_de=0.0, hp_mag=8.0, b_v=0.6), **r} for r in rows])


def test_rejected_gaia_link_never_supplies_the_distance():
    # AT-HYG's distance came from the rejected (faint, unrelated) Gaia source
    a = athyg_frame([dict(id=1, gaia=111, vmag=10.3, dist=360.0, dist_src="G_R3", hip=1512), dict(id=2, gaia=112, vmag=10.3, dist=360.0)])
    g = gaia_frame([dict(source_id=111, phot_g_mean_mag=19.6, parallax=2.77), dict(source_id=112, phot_g_mean_mag=19.6, parallax=2.77)])
    rows = merge.athyg_rows(merge.link_gaia(a, g), hyg_frame(), hip_frame([dict(hip=1512, plx=17.0, e_plx=1.2)]))
    assert rows.loc[0, "plx"] == 17.0 and rows.loc[0, "plx_src"] == "hip" and pd.isna(rows.loc[0, "gaia"])
    assert np.isnan(rows.loc[1, "plx"])  # no other distance: unusable


def test_hipparcos_preferred_over_high_ruwe_gaia():
    a = athyg_frame([dict(id=1, gaia=222, hip=7, vmag=3.6), dict(id=2, gaia=223, hip=8, vmag=8.0)])
    g = gaia_frame([dict(source_id=222, parallax=24.02, parallax_error=0.19, ruwe=2.56, phot_g_mean_mag=3.5),
                    dict(source_id=223, parallax=24.02, parallax_error=0.05, ruwe=1.0)])
    rows = merge.athyg_rows(merge.link_gaia(a, g), hyg_frame(), hip_frame([dict(hip=7, plx=27.10, e_plx=0.20), dict(hip=8, plx=25.0, e_plx=0.5)]))
    assert rows.loc[0, "plx_src"] == "hip" and rows.loc[0, "plx"] == 27.10
    assert rows.loc[0, "gaia"] == 222  # still the same Gaia source for all later matching
    assert rows.loc[1, "plx_src"] == "gaia"


def test_shared_gaia_id_gliese_row_is_merged_into_winner():
    a = athyg_frame([
        dict(id=1, gaia=333, tyc="1272-658-1", vmag=8.0),
        dict(id=2, gaia=333, vmag=8.6, gj="GJ 3275", ra_deg=10.001, epoch=1991.2),  # Gliese entry of the same star
    ])
    g = gaia_frame([dict(source_id=333, phot_g_mean_mag=7.8)])
    rows = merge.athyg_rows(merge.link_gaia(a, g), hyg_frame())
    assert len(rows) == 1 and rows.loc[0, "gj"] == "GJ 3275" and rows.loc[0, "tyc"] == "1272-658-1"


def test_dedupe_merges_catalogue_row_into_gaia_row():
    a = athyg_frame([dict(id=1, gaia=pd.NA, gj="GJ 1003", dist=21.1, dist_src="GJ", ra_deg=10.002, epoch=1991.2, vmag=12.0, tyc=None)])
    s = merge.athyg_rows(merge.link_gaia(a, gaia_frame([dict(source_id=1)])), hyg_frame())
    out = merge.merge_gcns(s, gcns_frame([dict(source_id=555, plx=47.4, ra=10.0, gmag=11.2, bp_rp=2.3)]))
    out = merge.dedupe_against_gaia(out)
    assert len(out) == 1 and out.loc[0, "gaia"] == 555 and out.loc[0, "gj"] == "GJ 1003"


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


def test_census_numbers_keep_large_negative_values():
    import pandas as pd

    from galmap.sources.census20 import _num

    v = _num(pd.Series(["-8123.70", "-999.000", "", "12.5"]))
    assert v.iloc[0] == -8123.7
    assert v.iloc[1:3].isna().all()
    assert v.iloc[3] == 12.5



def test_census_position_match_respects_component_letters_and_hip_owners():
    a = athyg_frame([
        dict(id=1, gaia=pd.NA, dist=12.5, dist_src="H", hip=500, ra_deg=60.0, dec=20.0, gj="GJ 325 B", tyc="1-2-1"),
        dict(id=2, gaia=700, ra_deg=80.0, dec=-10.0, hip=1295, gj="GJ 1006 A"),   # carries the HIP of another census object
    ])
    g = gaia_frame([dict(source_id=700, ra=80.0, dec=-10.0, parallax=70.0)])
    s = merge.athyg_rows(merge.link_gaia(a, g), hyg_frame())
    c = census_frame([
        dict(census_row=0, census_name="HD 75632 AB", is_leaf=False, system_row=0, ra=60.0, dec=20.0, plx=80.0, system_size=2),
        dict(census_row=1, census_name="HD 75632 Ab", depth=1, parent_row=0, system_row=0, ra=60.0, dec=20.0, plx=80.0, system_size=2),
        dict(census_row=2, census_name="G 32-7", system_row=2, gaia=700, ra=80.0, dec=-10.0, plx=70.0),
        dict(census_row=3, census_name="G 32-6 A", system_row=3, hip=1295, ra=80.01, dec=-10.0, plx=70.0),
    ])
    out = merge.merge_census(s, c)
    ab = out[out["census_name"] == "HD 75632 Ab"].iloc[0]
    assert ab["gj"] != "GJ 325 B"  # the B row is not taken by component Ab
    g327 = out[out["census_name"] == "G 32-7"].iloc[0]
    g326 = out[out["census_name"] == "G 32-6 A"].iloc[0]
    assert pd.isna(g327["hip"]) and g326["hip"] == 1295 and g326["gj"] == "GJ 1006 A"
    assert (out["hip"] == 1295).sum() == 1


def test_census_confirmation_uses_the_full_20_pc():
    a = athyg_frame([dict(id=1, gaia=pd.NA, dist=19.6, dist_src="GJ", ra_deg=200.0, dec=-30.0, gj="GJ 3758")])
    s = merge.athyg_rows(merge.link_gaia(a, gaia_frame([dict(source_id=1)])), hyg_frame())
    out = merge.merge_census(s, census_frame([dict(census_row=0, census_name="Single", gaia=pd.NA, ra=10.0, dec=5.0)]))
    assert list(out["census_name"].fillna("")) == ["Single"]


def test_tight_census_components_share_one_distance():
    from galmap.sources.census20 import _unify_tight_systems

    df = pd.DataFrame({
        "is_leaf": [False, True, True, True],
        "ra": [10.0, 10.0, 10.0003, 30.0],
        "dec": [5.0, 5.0, 5.0, 5.0],
        "plx": [227.0, 231.12, 223.48, 50.0],
        "plx_err": [1.0, 0.51, 0.47, 0.1],
        "plx_estimated": [False, False, False, False],
    })
    parent = np.array([-1, 0, 0, -1])
    _unify_tight_systems(df, parent, np.array([True, True, True, True]))
    # inconsistent component parallaxes: the system row's own measurement is adopted
    assert list(df["plx"]) == [227.0, 227.0, 227.0, 50.0]


def test_imprecise_system_member_moves_to_system_distance():
    from galmap.systems import common_distances

    s = pd.DataFrame({
        "system_id": [0, 0, -1],
        "plx": [12.05, 14.69, 10.0],
        "plx_err": [0.02, 1.60, 0.1],
        "x": [83.0, 59.9, 1.0], "y": [0.0, 0.01, 99.0], "z": [0.0, 0.0, 0.0],
    })
    changed = common_distances(s)
    assert 1 in list(changed) and abs(s.loc[1, "plx"] - 12.05) < 0.01 and abs(s.loc[0, "plx"] - 12.05) < 0.01
    assert s.loc[2, "plx"] == 10.0
    # a member whose own measurement contradicts the system distance (> 2 sigma) keeps it
    s2 = s.assign(plx=[12.05, 16.69, 10.0], plx_err=[0.02, 1.60, 0.1])
    common_distances(s2)
    assert s2.loc[1, "plx"] == 16.69



def test_census_component_takes_row_without_usable_parallax():
    # xi UMa B: AT-HYG's Gaia-derived distance is unusable (link rejected), but the row's identifiers
    # belong to the census component
    a = athyg_frame([dict(id=1, gaia=pd.NA, dist=8.73, dist_src="G_R3", hd=98230, gj="GJ 423 B", ra_deg=169.5452, dec=31.5291)])
    s = merge.athyg_rows(merge.link_gaia(a, gaia_frame([dict(source_id=1)])), hyg_frame())
    assert np.isnan(s.loc[0, "plx"])
    c = census_frame([dict(census_row=0, census_name="xi UMa Ba", gaia=pd.NA, ra=169.5452, dec=31.5291, plx=114.49)])
    out = merge.merge_census(s, c)
    assert len(out) == 1 and out.loc[0, "hd"] == 98230 and out.loc[0, "plx"] == 114.49
