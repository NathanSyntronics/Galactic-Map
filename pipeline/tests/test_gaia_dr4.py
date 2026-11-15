"""Gaia DR4 (docs/GAIA_DR4.md): the release switch, the query, the rows normalised to DR3's columns
and the stars that keep their DR3 designation."""

import numpy as np
import pandas as pd
import pytest

from galmap import bulk, derive, naming
from galmap.flags import Desig
from galmap.sources import gaia

from test_bulk import photometry


def test_release_switch(monkeypatch):
    monkeypatch.delenv(gaia.RELEASE_ENV, raising=False)
    assert gaia.release() is gaia.DR3
    monkeypatch.setenv(gaia.RELEASE_ENV, "DR4")
    assert gaia.release() is gaia.DR4
    assert gaia.release("dr3") is gaia.DR3  # an explicit choice wins
    with pytest.raises(ValueError):
        gaia.release("dr5")


def test_dr4_query():
    q = gaia.DR4_QUERIES["precise"].format(cols=gaia.DR4_COLUMNS, lo=0, hi=10)
    assert "FROM gaiadr4.gaia_source AS g" in q
    assert "LEFT OUTER JOIN gaiadr4.dr3_neighbourhood AS n ON n.source_id = g.source_id" in q
    assert gaia.PRECISE_WHERE in q and "astrometric_params_solved" not in q
    assert "g.tentative_parallax_bias" in q and "g.ref_epoch" in q and "n.probable_match" in q
    c = gaia.DR4_COUNTS["precise"].format(lo=0, hi=10)
    assert "gaiadr4.gaia_source" in c and "dr3_neighbourhood" not in c


def test_dr4_ranges_are_checked_by_distinct_sources(monkeypatch):
    # three sources, one of them with two DR3 neighbours: four rows
    rows = pd.DataFrame({"source_id": ["1", "2", "2", "3"], "dr3_source_id": ["11", "12", "13", ""]})
    monkeypatch.setattr(gaia, "_count", lambda name, lo, hi, rel=gaia.DR3: 3)
    monkeypatch.setattr(gaia, "tap_sync", lambda *a, **k: rows)
    assert len(gaia._fetch_range("precise", 0, 10, gaia.DR4)) == 4
    monkeypatch.setattr(gaia, "_count", lambda name, lo, hi, rel=gaia.DR3: 4)
    with pytest.raises(RuntimeError):
        gaia._fetch_range("precise", 0, 10, gaia.DR4)  # a source is missing


def dr4_rows() -> pd.DataFrame:
    """Rows of the DR4 precise query as the archive's CSV gives them (strings)."""
    return pd.DataFrame(
        {
            # 100: two neighbours, the nearer one a probable match; 200: a neighbour that is not a
            # probable match; 300 and 301: a DR3 source resolved into two in DR4 (both claim 31);
            # 400: no neighbour at all
            "source_id": ["100", "100", "200", "300", "301", "400"],
            "dr3_source_id": ["5853498713190525696", "12", "21", "31", "31", ""],
            "angular_distance": ["3.5", "1.0", "2.0", "40.0", "10.0", ""],
            "probable_match": ["true", "false", "false", "true", "true", ""],
            "magnitude_difference": ["0.01", "3.0", "2.5", "0.2", "0.1", ""],
            "ra": ["10", "10", "20", "30", "30.0001", "40"],
            "dec": ["-5", "-5", "5", "15", "15", "25"],
            "parallax": ["2.0", "2.0", "1.5", "3.0", "3.1", "1.0"],
            "parallax_error": ["0.01", "0.01", "0.01", "0.02", "0.02", "0.005"],
            "pmra": ["10", "10", "-3", "1", "1", ""],
            "pmdec": ["-20", "-20", "4", "2", "2", ""],
            "ruwe": ["1.0", "1.0", "1.1", "0.9", "0.9", "1.0"],
            "phot_g_mean_mag": ["12", "12", "14", "13", "13.1", "15"],
            "bp_rp": ["0.8", "0.8", "1.5", "1.0", "1.1", "2.0"],
            "nu_eff_used_in_astrometry": ["1.5", "1.5", "1.4", "", "1.5", "1.4"],
            "pseudocolour": ["", "", "", "1.5", "", ""],
            "ecl_lat": ["-20", "-20", "10", "30", "30", "45"],
            "ref_epoch": ["2017.5"] * 5 + [""],
            "tentative_parallax_bias": ["-0.01", "-0.01", "-0.02", "", "-0.03", "-0.02"],
            "unreliable_astrometry": ["false", "false", "true", "false", "false", ""],
            "astrometry_origin": ["all_source_astrometry"] * 6,
        }
    )


def test_dr3_counterparts():
    t = gaia.dr3_counterparts(gaia._numeric(dr4_rows()))
    by = dict(zip(t["source_id"], t["dr3_source_id"]))
    assert len(t) == 5
    assert by[100] == 5853498713190525696  # the probable match, although the other neighbour is nearer
    assert by[200] == -1  # no probable match
    assert by[301] == 31 and by[300] == -1  # the nearer of the two claimants
    assert by[400] == -1


def test_normalise_dr4():
    n = gaia.normalise_dr4(gaia._numeric(dr4_rows())).set_index("dr4_source_id")
    assert list(n.loc[[100, 200, 300, 301, 400], "source_id"]) == [5853498713190525696, -1, -1, 31, -1]
    assert list(n.loc[[100, 200, 300, 301, 400], "astrometric_params_solved"]) == [31, 0, 95, 31, 31]
    # the bias of the row, where missing the median of the others
    assert n.loc[100, "parallax_zp"] == pytest.approx(-0.01)
    assert n.loc[300, "parallax_zp"] == pytest.approx(-0.02)
    assert n.loc[400, "ref_epoch"] == gaia.DR4.epoch and n.loc[100, "ref_epoch"] == 2017.5
    assert set(bulk.GAIA_COLUMNS) <= set(n.reset_index().columns)


def test_dr4_stars_through_the_bulk_path(tmp_path):
    n = gaia.normalise_dr4(gaia._numeric(dr4_rows()))
    n.to_parquet(tmp_path / "dr4.parquet", index=False)
    raw = next(bulk.parquet_source(tmp_path / "dr4.parquet"))
    sel = bulk.Selection(min_plx=0.0, max_plx=10.0, max_rel_err=0.01)
    # DR3 source 31 is already in the core catalogue: its DR4 counterpart is left out
    rows = bulk.derive_chunk(raw, sel, photometry(), bulk.SortedIds([31]), bulk.Lookups()).set_index("gaia_dr4", drop=False)
    # 200 has unreliable astrometry; 301 is the core's DR3 source 31
    assert len(rows) == 3
    # the DR3 number of the same star stays its designation, a star DR3 does not have gets its DR4 number
    a = rows[rows["gaia"].notna()].iloc[0]
    assert a["desig_cat"] == Desig.GAIA_DR3
    assert naming.designation_text(a["desig_cat"], a["desig_lo"], a["desig_hi"], a["desig_str"]) == "Gaia DR3 5853498713190525696"
    b = rows[rows["gaia"].isna()]
    assert sorted(b["desig_str"]) == ["Gaia DR4 300", "Gaia DR4 400"]
    # positions are moved from J2017.5 to the tiles' epoch J2016.0 (1.5 years of 10 / -20 mas/yr)
    one = rows[rows["gaia"].notna()].reset_index(drop=True)
    assert one.loc[0, "epoch"] == 2017.5
    at2016 = derive.positions(one.assign(epoch=2016.0))
    u, v = one[["x", "y", "z"]].to_numpy(float)[0], at2016[["x", "y", "z"]].to_numpy(float)[0]
    shift_mas = np.degrees(np.arccos(np.clip(u @ v / (np.linalg.norm(u) * np.linalg.norm(v)), -1, 1))) * 3.6e6
    assert shift_mas == pytest.approx(1.5 * np.hypot(10, 20), rel=0.02)


def test_missing_columns():
    listing = pd.DataFrame(
        {
            "table_name": ["gaiadr4.gaia_source"] * 3 + ["gaiadr4.dr3_neighbourhood"],
            "column_name": ["source_id", "RA", "dec", "source_id"],
        }
    )
    req = {"gaiadr4.gaia_source": ["source_id", "ra", "dec"], "gaiadr4.dr3_neighbourhood": ["source_id", "dr3_source_id"], "gaiadr4.x": ["a"]}
    assert gaia.missing_columns(listing, req) == {"gaiadr4.dr3_neighbourhood": ["dr3_source_id"], "gaiadr4.x": ["a"]}
    # every column the DR4 query reads is checked
    for c in gaia.DR4_COLUMNS.split(", "):
        table = "gaiadr4.gaia_source" if c.startswith("g.") else gaia.DR4.dr3_neighbourhood
        assert c.split(".", 1)[1] in gaia.DR4_REQUIRED[table]


def test_dr4_cache_files_are_their_own(tmp_path, monkeypatch):
    seen = []

    def fake(name, lo, hi, rel=gaia.DR3):
        seen.append(rel.key)
        return dr4_rows() if lo == 0 else pd.DataFrame()

    monkeypatch.setattr(gaia, "_fetch_range", fake)
    df = gaia.fetch_xmatch("precise", chunks=2, cache=tmp_path, rel=gaia.DR4, post=gaia.normalise_dr4)
    assert (tmp_path / "gaia_dr4_precise.parquet").exists() and not (tmp_path / "gaia_dr3_precise.parquet").exists()
    assert set(seen) == {"dr4"} and len(df) == 5 and "dr4_source_id" in df
