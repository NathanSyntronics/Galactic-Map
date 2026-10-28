"""The bulk path (galmap.bulk) gives the same stars as the core catalogue's path, chunk by chunk."""

import gzip
import json
from pathlib import Path

import numpy as np
import pandas as pd

from galmap import bulk, derive, merge, naming
from galmap.fetch_gaia_bulk import Remote, download, fetch, list_files
from galmap.flags import Desig, Flag
from galmap.ooc import all_rows
from galmap.octree import write_dataset
from galmap.photometry import Photometry, spt_number
from galmap.sources.simbad import SimbadByGaia


def photometry() -> Photometry:
    """A small dwarf sequence in the shape of Pecaut & Mamajek's table."""
    spt = ["B5V", "A0V", "F0V", "G2V", "K0V", "M0V", "M5V", "L0V", "T5V"]
    t = pd.DataFrame(
        {
            "SpT": spt,
            "Teff": [15700, 9700, 7220, 5770, 5270, 3850, 3060, 2250, 1100],
            "logL": [2.7, 1.4, 0.7, 0.0, -0.3, -1.2, -2.6, -3.6, -5.0],
            "BCv": [-1.2, -0.1, 0.0, -0.07, -0.19, -1.0, -2.7, -4.0, -6.0],
            "B-V": [-0.15, 0.0, 0.3, 0.65, 0.8, 1.4, 1.9, 2.2, 2.4],
            "Bp-Rp": [-0.2, 0.0, 0.4, 0.82, 0.98, 1.84, 3.3, 4.3, 5.0],
        }
    )
    t["spt_num"] = t["SpT"].map(spt_number)
    return Photometry(t)


def gaia_rows(n=3000, seed=7, start=10**15) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    plx = rng.uniform(4.0, 9.0, n)  # 110-250 pc: some outside the field selection
    return pd.DataFrame(
        {
            "source_id": start + np.arange(n, dtype=np.int64) * 7919,
            "ra": rng.uniform(0, 360, n),
            "dec": np.degrees(np.arcsin(rng.uniform(-1, 1, n))),
            "parallax": plx,
            "parallax_error": plx * rng.uniform(0.005, 0.15, n),
            "pmra": rng.normal(0, 20, n),
            "pmdec": rng.normal(0, 20, n),
            "ruwe": rng.uniform(0.8, 1.6, n),
            "phot_g_mean_mag": rng.uniform(8, 19, n),
            "bp_rp": rng.uniform(0.0, 4.0, n),
            "nu_eff_used_in_astrometry": rng.uniform(1.2, 1.8, n),
            "pseudocolour": np.nan,
            "ecl_lat": rng.uniform(-80, 80, n),
            "astrometric_params_solved": np.where(rng.random(n) < 0.05, 3, 31),
            "parallax_zp": rng.uniform(-0.04, 0.0, n),
        }
    )


def simbad_tables(raw: pd.DataFrame):
    """SIMBAD objects for three of the sources: a variable star, a white dwarf, an M dwarf."""
    keep, _, _ = bulk.FIELD.keep(raw)
    ids = raw["source_id"].to_numpy()[np.nonzero(keep)[0][[5, 9, 20]]]
    basic = pd.DataFrame(
        {
            "oid": [101, 102, 103],
            "main_id": ["V*  XX Tst", "WD 1234+567", "2MASS J01234567+0123456"],
            "otype": ["Mi*", "WD*", "*"],
            "sp_type": ["M5e", "DA", ""],
            "ra": [0.0, 0.0, 0.0],
            "dec": [0.0, 0.0, 0.0],
            "plx_value": [np.nan] * 3,
        }
    )
    ident = pd.DataFrame(
        {
            "oidref": [101, 101, 102, 102, 103, 103],
            "id": [f"Gaia DR3 {ids[0]}", "V* XX Tst", f"Gaia DR3 {ids[1]}", "WD 1234+567", f"Gaia DR3 {ids[2]}", "2MASS J01234567+0123456"],
        }
    )
    return basic, ident


def core_way(raw: pd.DataFrame, phot: Photometry, simbad=None) -> pd.DataFrame:
    """The same rows through the core catalogue's steps (build.build)."""
    s = merge.add_gaia_field(pd.DataFrame({"gaia": pd.array([], dtype="Int64")}), raw)
    s["is_sun"] = s["is_sun"].astype(bool)
    s["src"] = s["src"].astype(np.int64)
    for c in ("brown_dwarf", "white_dwarf"):
        s[c] = False
    s = derive.positions(s)
    ext = {}
    if simbad is not None:
        idents, info = SimbadByGaia(*simbad).lookup(s["gaia"].to_numpy(dtype=np.int64))
        s = pd.concat([s, info], axis=1)
        no_spt = s["spect"].isna() & s["simbad_sp_type"].notna()
        s.loc[no_spt, "spect"] = s.loc[no_spt, "simbad_sp_type"]
        otype = s["simbad_otype"].astype(object)
        s["brown_dwarf"] = s["brown_dwarf"] | otype.isin(["BD*"]).to_numpy()
        s["white_dwarf"] = s["white_dwarf"] | otype.isin(["WD*"]).to_numpy()
        ext = {i: {"simbad": v} for i, v in idents.items()}
    else:
        s["simbad_main_id"] = None
    s = derive.physics(s, phot)
    s["system_id"] = -1
    s["hip"] = pd.array([pd.NA] * len(s), dtype="Int64")
    s["hd"] = pd.array([pd.NA] * len(s), dtype="Int64")
    s["tyc"] = None
    return naming.assign_names(s, ext)


COLUMNS = ("x", "y", "z", "absmag", "logl", "teff", "dist_err", "flags", "spec_code", "desig_cat", "desig_lo", "desig_hi", "desig_str", "name_rank", "name_en", "spect")


def assert_same(a: pd.DataFrame, b: pd.DataFrame) -> None:
    assert len(a) == len(b)
    for c in COLUMNS:
        x, y = a[c].to_numpy(), b[c].to_numpy()
        if x.dtype.kind == "f":
            assert np.array_equal(x, y, equal_nan=True), c
        else:
            assert list(pd.Series(x).where(pd.notna(x), None)) == list(pd.Series(y).where(pd.notna(y), None)), c


def test_derive_chunk_matches_the_core_way():
    phot = photometry()
    raw = gaia_rows()
    rows = bulk.derive_chunk(raw, bulk.FIELD, phot, bulk.SortedIds([]), bulk.Lookups())
    assert 0 < len(rows) < len(raw)
    assert_same(rows, core_way(raw, phot))
    assert (rows["desig_cat"] == Desig.GAIA_DR3).all()


def test_simbad_and_planets_by_gaia_id():
    phot = photometry()
    raw = gaia_rows()
    tables = simbad_tables(raw)
    variable, wd, _m = (int(v[9:]) for v in tables[1]["id"] if v.startswith("Gaia DR3"))
    planets = pd.Series([3], index=[wd])
    rows = bulk.derive_chunk(raw, bulk.FIELD, phot, bulk.SortedIds([]), bulk.Lookups(simbad=SimbadByGaia(*tables), planets=planets))
    assert_same(rows, core_way(raw, phot, tables))
    by_gaia = rows.set_index(rows["gaia"].astype("int64"))
    assert by_gaia.loc[wd, "planets"] == 3 and rows["planets"].sum() == 3
    assert by_gaia.loc[wd, "flags"] & Flag.WHITE_DWARF
    assert by_gaia.loc[variable, "spect"] == "M5e"
    # objects a core star already has are left out
    taken = SimbadByGaia(*tables, taken={101})
    assert set(taken.lookup(np.array([variable, wd]))[0]) == {1}


def test_skip_and_selection():
    phot = photometry()
    raw = gaia_rows()
    skip = bulk.SortedIds(raw["source_id"].to_numpy()[::2])
    rows = bulk.derive_chunk(raw, bulk.FIELD, phot, skip, bulk.Lookups())
    assert not skip.contains(rows["gaia"].to_numpy(dtype=np.int64)).any()
    keep, plx, err = bulk.FIELD.keep(raw)
    assert len(rows) == int((keep & ~skip.contains(raw["source_id"].to_numpy())).sum())
    assert bulk.SortedIds([]).contains(np.array([1, 2])).tolist() == [False, False]


def write_gaia_files(directory: Path, raw: pd.DataFrame, parts=3) -> None:
    """ESA-style files: '#' metadata lines, more columns than needed, 'null' for missing values."""
    table = raw.drop(columns=["parallax_zp"])
    for k, idx in enumerate(np.array_split(np.arange(len(table)), parts)):
        df = table.iloc[idx].copy()
        df.insert(1, "designation", [f"Gaia DR3 {v}" for v in df["source_id"]])
        df["radial_velocity"] = "null"
        text = "# %ECSV 1.0\n# ---\n# datatype: ...\n" + df.to_csv(index=False, na_rep="null")
        with gzip.open(directory / f"GaiaSource_{k:06d}-{k:06d}.csv.gz", "wt") as fh:
            fh.write(text)


def test_files_source(tmp_path: Path):
    raw = gaia_rows(2500)
    write_gaia_files(tmp_path, raw)
    got = pd.concat(list(bulk.files_source(tmp_path, rows=400)), ignore_index=True)
    assert list(got.columns) == bulk.GAIA_COLUMNS
    assert len(got) == len(raw)
    assert got["source_id"].tolist() == raw["source_id"].tolist()
    assert np.allclose(got["parallax"], raw["parallax"])
    assert got["pseudocolour"].isna().all()
    # the zero point is computed for such chunks; the derived stars are the same as from a table
    phot = photometry()
    a = pd.concat(bulk.chunks(bulk.files_source(tmp_path, rows=700), bulk.FIELD, phot, bulk.SortedIds([]), bulk.Lookups()), ignore_index=True)
    with_zp = bulk.with_zero_point(raw.drop(columns=["parallax_zp"]))
    b = bulk.derive_chunk(with_zp, bulk.FIELD, phot, bulk.SortedIds([]), bulk.Lookups())
    assert_same(a, b)


def test_prepass_finds_sources_next_to_catalogue_rows():
    raw = gaia_rows()
    core = pd.DataFrame(
        {
            "gaia": pd.array([pd.NA, pd.NA, 5], dtype="Int64"),
            "plx": [7.0, 7.0, 7.0],
            "is_sun": [False, False, False],
            "ra": [raw["ra"].iloc[100] + 1e-4, 10.0, 20.0],
            "dec": [raw["dec"].iloc[100], 10.0, 20.0],
            "pmra": [0.0, 0.0, 0.0],
            "pmdec": [0.0, 0.0, 0.0],
            "epoch": [2016.0, 2016.0, 2016.0],
            "tyc": ["1-2-1", "1-3-1", None],
            "hip": pd.array([pd.NA] * 3, dtype="Int64"),
        }
    )
    promoted = bulk.prepass(iter([raw.iloc[:1500], raw.iloc[1500:]]), bulk.Selection(max_rel_err=1.0, solutions=(31, 3)), core)
    assert promoted["source_id"].tolist() == [raw["source_id"].iloc[100]]


def test_streamed_bulk_gives_the_tree_of_one_table(tmp_path: Path):
    phot = photometry()
    raw = gaia_rows(6000)
    parts = [bulk.derive_chunk(p, bulk.FIELD, phot, bulk.SortedIds([]), bulk.Lookups()) for p in (raw.iloc[i] for i in np.array_split(np.arange(len(raw)), 4))]
    core, rest = parts[0], parts[1:]
    a = write_dataset(core, None, tmp_path / "a", sources=[], params={}, capacity=100, bulk=iter(rest), max_bucket=900)
    b = write_dataset(pd.concat(parts, ignore_index=True), None, tmp_path / "b", sources=[], params={}, capacity=100)
    assert a["starCount"] == b["starCount"] == sum(len(p) for p in parts)

    def nodes(out, m):
        packs = {n: (out / n).read_bytes() for n in m["packs"]}
        return {r[0]: packs[m["packs"][r[4]]][r[5] : r[5] + r[2]] for r in all_rows(out, m)}

    assert nodes(tmp_path / "a", a) == nodes(tmp_path / "b", b)


class FakeResponse:
    def __init__(self, status, body=b"", text=""):
        self.status_code, self.body, self.text = status, body, text

    def raise_for_status(self):
        if self.status_code >= 400:
            raise IOError(f"HTTP {self.status_code}")

    def iter_content(self, n):
        for i in range(0, len(self.body), n):
            yield self.body[i : i + n]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeSession:
    """A server with Range support and an MD5 list."""

    def __init__(self, files: dict[str, bytes]):
        import hashlib

        self.files = files
        self.md5 = "\n".join(f"{hashlib.md5(v).hexdigest()}  {k}" for k, v in files.items())
        self.ranges = []

    def get(self, url, headers=None, stream=False, timeout=None):
        name = url.rsplit("/", 1)[-1]
        if name == "_MD5SUM.txt":
            return FakeResponse(200, text=self.md5)
        body = self.files[name]
        rng = (headers or {}).get("Range")
        if rng:
            start = int(rng.split("=")[1].rstrip("-"))
            self.ranges.append(start)
            if start >= len(body):
                return FakeResponse(416)
            return FakeResponse(206, body[start:])
        return FakeResponse(200, body)


def test_fetch_resumes_and_checks(tmp_path: Path):
    files = {"GaiaSource_000000-003111.csv.gz": b"a" * 5000, "GaiaSource_003112-005263.csv.gz": b"b" * 3000}
    s = FakeSession(files)
    assert [f.name for f in list_files(s, "x/")] == sorted(files)
    # an interrupted download
    (tmp_path / "GaiaSource_000000-003111.csv.gz.part").write_bytes(b"a" * 1234)
    counts = fetch(tmp_path, session=s, base_url="x/")
    assert counts == {"files": 2, "skipped": 0, "done": 1, "resumed": 1, "failed": 0}
    assert s.ranges == [1234]
    for k, v in files.items():
        assert (tmp_path / k).read_bytes() == v
    assert fetch(tmp_path, session=s, base_url="x/")["skipped"] == 2
    # a corrupt partial file is detected and removed
    (tmp_path / "GaiaSource_003112-005263.csv.gz").unlink()
    (tmp_path / "GaiaSource_003112-005263.csv.gz.part").write_bytes(b"x" * 10)
    remote = Remote("GaiaSource_003112-005263.csv.gz", list_files(s, "x/")[1].md5)
    try:
        download(s, remote, tmp_path, "x/")
        raise AssertionError("expected an MD5 mismatch")
    except IOError:
        pass
    assert not (tmp_path / "GaiaSource_003112-005263.csv.gz.part").exists()
