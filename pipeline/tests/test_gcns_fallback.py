"""GCNS: when the CDS does not answer, the table comes from the ESA Gaia archive."""

import pandas as pd
import requests

from galmap.sources import gaia, gcns


def test_the_archive_copy_when_the_cds_is_down(monkeypatch, tmp_path):
    monkeypatch.setattr(gcns, "FILE", tmp_path / "table1c.dat.gz")
    monkeypatch.setattr(gcns, "CACHE_DIR", tmp_path)

    def down(*a, **kw):
        raise requests.ConnectTimeout("cdsarc.cds.unistra.fr timed out")

    asked = []

    def archive(name, chunks, refresh=False):
        asked.append(name)
        row = {c: "1.5" for c, _, _ in gcns.COLSPECS}
        row.update(source_id="4472832130942575872", name_2mass="17574849+0441405", bpmag="10.5", rpmag="8.25")
        return pd.DataFrame([row])

    monkeypatch.setattr(gcns, "fetch", down)
    monkeypatch.setattr(gaia, "fetch_xmatch", archive)
    df = gcns.load()
    assert asked == ["gcns_table"]
    assert int(df["source_id"].iloc[0]) == 4472832130942575872
    assert df["plx"].iloc[0] == 1.5
    assert df["bp_rp"].iloc[0] == 2.25
    assert df["name_2mass"].iloc[0] == "17574849+0441405"


def test_the_archive_query_uses_the_cds_column_names():
    q = gaia.QUERIES["gcns_table"]
    for name, _, _ in gcns.COLSPECS:
        assert f" {name}," in q or f"x.{name}," in q or f" AS {name} " in q or f"AS {name}," in q, name
