# Scaling to hundreds of millions of stars

The map holds 4.3 million stars today. Gaia DR3 has 1.47 billion stars with a parallax, about
98 million with a distance better than 10 % and 192 million better than 20 %. This document is the
architecture that lets the pipeline and the app handle such numbers. It is implemented and tested
with today's data and with synthetic data; the large catalogues themselves are not downloaded
(`galmap.fetch_gaia_bulk` does that when wanted).

## What did not scale

* **The pipeline held everything in memory.** Every star was a row of one pandas table from the
  download to the octree; the build peaks at about 7 GB for 4.3 million stars, so 100 million
  would need well over 100 GB.
* **The octree was built in one piece**, with all positions and luminosities in memory.
* **One manifest listed every node.** 2,893 nodes today (112 kB); 1.5 billion stars would need
  about 360,000 nodes, a manifest of some 40 MB that every visitor loads first.
* **Field stars came through the archive's query interface** in chunks; 98 million rows would
  take about 12 hours that way, all of them far more.

## Two kinds of stars

1. **The core catalogue**: every star that needs cross-matching, names, systems or the 20 pc
   census: AT-HYG / HYG / Hipparcos / Tycho-2 with their Gaia matches, the GCNS within 100 pc, the
   census, SIMBAD, Wikidata, IAU names, exoplanet hosts. A few million rows, merged in memory as
   before (`build.py` up to the naming).
2. **Bulk stars** (`pipeline/galmap/bulk.py`): Gaia DR3 sources that are not in the core catalogue
   (by `source_id`). They need no cross-matching and are processed **chunk by chunk** with bounded
   memory, however many there are. Each chunk goes through the same functions as the core rows
   (`merge.field_rows`, `derive.positions`, `derive.physics`, `naming.assign_names`), so a star
   gets the same position, physical values and designation either way. By their Gaia id alone
   they get, per chunk, the SIMBAD object (identifiers, from which the naming may take a name or
   a designation as for the core stars; object type; spectral type; `SimbadByGaia`, objects that
   a core star already has are left out) and the number of known planets (hosts not matched to a
   core star). What needs the neighbourhood of every star is missing: wide-binary systems,
   SIMBAD matches by position, Wikidata and IAU names.

The Gaia stars between 100 and 200 pc that the map holds (1.5 million) stay in the core catalogue
by default: they fit in memory, and there they also take part in the wide-binary search. The build
option `--field-bulk` sends them through the bulk path instead; comparing both builds tests the
bulk path on real data (see Checks).

**Duplicates.** The core merges a catalogue row without Gaia astrometry (an old Tycho-2,
Hipparcos or Gliese entry) into the Gaia row of the same star (`merge.dedupe_against_gaia`). So
that this works the same with bulk stars, a **pre-pass** over the bulk source moves the Gaia
sources within the dedupe's search radius (3", 60" for Gliese-only rows) of such a row into the
core first (`bulk.prepass`; 73 of 1.5 million for the field).

## Bulk sources

A bulk source yields chunks (pandas tables of a bounded size) with the Gaia columns the derivation
needs (`source_id, ra, dec, parallax, parallax_error, pmra, pmdec, ruwe, phot_g_mean_mag, bp_rp,
nu_eff_used_in_astrometry, pseudocolour, ecl_lat, astrometric_params_solved`); the parallax zero
point is computed per chunk.

* `field_source`: the archive query of the 100–200 pc field (cached by `galmap.sources.gaia`),
  read in row groups (`parquet_source`). Fine up to a few million rows.
* `files_source`: the ESA bulk files (`GaiaSource_*.csv.gz`), read file by file with only the
  needed columns (exact float parsing). Downloading them is a separate, resumable step:
  `python -m galmap.fetch_gaia_bulk --dest DIR` (3,386 files, about 650 GB; a partial file is
  continued with an HTTP range request, finished files are checked against the published MD5
  sums). The build never downloads them.
* Selection (`bulk.Selection`, build options `--bulk-min-plx`, `--bulk-max-rel-err`,
  `--bulk-max-ruwe`): a parallax window, the maximum relative parallax error (default 10 %,
  errors inflated by the RUWE), the accepted astrometric solutions (5 and 6 parameters), an
  optional RUWE limit. For the bulk files the parallax window ends where the field (or, without
  it, the GCNS) begins.

Stars of the core catalogue are skipped by a sorted array of their Gaia ids (`SortedIds`,
`np.searchsorted`, 8 bytes per id).

## Out-of-core octree

`pipeline/galmap/ooc.py` (`OctreeWriter`; `octree.write_dataset` uses it for every build). The
octree keeps its definition: each node holds the `capacity` most important stars of its cube that
no ancestor holds. The order is importance, then a hash of the star's designation, then the order
of arrival, so the tree does not depend on how the stars arrive (it used to be a random jitter;
206 of today's 4.3 million stars of equal luminosity sit in another node now).

1. **Spool.** The core table and every bulk chunk are written to disk as fixed-width records
   (110 bytes: position, values, designation numbers, order keys); the few text fields
   (designation strings, names, spectral types) go to a side file per chunk.
2. **Buckets.** The root cube is split adaptively, four levels per pass over the spool, until
   every cube holds at most `max_bucket` stars (default 8 million, `--max-bucket`); every star is
   appended to its bucket's file. A dataset that fits one bucket (today's) is one bucket: the
   whole tree in memory as before.
3. **Upper levels.** A node above a bucket of depth `d` takes at most `capacity` stars from it
   per level, so all stars the nodes above can take from a bucket are among its
   `capacity · d` most important. These candidates of all buckets (56 bytes each: position, order
   keys, id) build the upper levels exactly as the in-memory builder would.
4. **Subtrees.** Each bucket is loaded on its own; the stars taken above are set aside (they are
   written with their upper nodes at the end), and the bucket's subtree is built and written. Nodes
   go to the pack files as they are finished.

Memory is bounded by one bucket plus the candidates (`capacity · depth` per bucket), not by the
number of stars. Disk needs about twice the final data size during the build (`--work-dir`).

## Hierarchical manifest

* The node list is split by `ooc.split_manifest`: bottom-up, a node whose listing would exceed
  `SUBTREE_NODES` (4,096) rows hands its largest child subtrees to **sub-manifests**
  (`m/<path>.json`) until it fits. The node's own row stays with its parent and names the file in
  a 7th field; the file lists the node's descendants in the same row format (and may name further
  files). Today's data keeps a single manifest.
* The manifest's format version is 2 (`docs/DATA_FORMAT.md`); the node files do not change. The
  app reads version 1 and 2.
* The app (`src/data/octree.ts`) treats a node whose sub-manifest is not loaded as a leaf (its own
  stars are shown) and loads the file when the level-of-detail selection selects the node; a
  selection with such a node counts as incomplete (the jump network then waits). The search loads
  the files on the way to a star's node (`reach`); route planning loads those of every node that
  touches the corridor before taking its nodes (`expandWhere`), and so does locating a route end.
* The jump network's tie-break keys of nodes come from their place in the packs (`nodeKeyOf`), so
  they do not depend on which sub-manifests are loaded in which order (and keep today's order).

## Hosting

GitHub Pages serves up to about 1 GB. Larger data goes to object storage with HTTP range requests
and CORS (for example Cloudflare R2 or S3 behind a CDN); the app reads the data base URL from
`VITE_DATA_URL` at build time (default: `data/` next to the app). Packs may then be larger (e.g.
64 MB, `pack_bytes`) to keep the number of files down.

## Expected sizes

About 30–40 bytes per star in the packs (today: 170 MB for 4.3 million; synthetic stars without
names: 31 bytes).

| Selection | Stars | Packs | Nodes | Manifests |
|---|---|---|---|---|
| today | 4.3 million | 170 MB | 2,900 | 1 |
| Gaia, distance better than 10 % | ~98 million | ~4 GB | ~70,000 | ~20 |
| Gaia, distance better than 20 % | ~192 million | ~8 GB | ~140,000 | ~40 |
| Gaia, every star with a parallax | ~1.47 billion | ~55 GB | ~1 million | ~250 |

Build time is dominated by reading the input (a few hours for the bulk files) and by the per-star
work: the bulk derivation runs at about 250,000 stars per second, the writer at about 200,000
stars per second (one core; numbers from the checks below).

## Checks

All run on a 4-core container (`pipeline/tests`, `galmap.compare`, `galmap.scale_test`).

* **Same tree out of core.** The writer with forced small buckets (up to 159 buckets, 28 nodes
  above them, input in 7 chunks) writes byte-identical nodes to the in-memory reference builder
  (`tests/test_ooc.py`); stars arriving in another order give the same tree.
* **Today's data through the new writer.** A full rebuild (`galmap.build`, 386 s, peak 7.35 GB)
  compared star by star with the previous data (`galmap.compare`): the same 4,263,891 stars with
  the same positions, values, flags, names, designations, systems and planets; the same name
  index and `systems.json`; 206 stars of equal luminosity in another node. `galmap.verify`
  passes, and the example factions computed from the new data are byte-identical.
* **Bulk path on real data.** A build with `--field-bulk` (248 s, peak 5.9 GB: the 1.5 million
  field stars are derived in 8 s in chunks and never held together) against the core build: the
  same number of stars; for the 4,116,276 stars that are in no system in either build, positions,
  magnitudes, luminosities, temperatures, distance errors and spectral classes are identical. The
  differences are the expected ones: the wide-binary systems of field stars are missing
  (20,290 systems instead of 68,280, and their members' common distances, so 112,000 positions
  differ), 38 names that come from Wikipedia (CT Chamaeleontis, CI Tauri) or SIMBAD matches by
  position, and 6 planet hosts matched by position.
* **Bulk path in tests** (`tests/test_bulk.py`): a chunk gives the same rows as the core's steps
  (also with SIMBAD objects and planets by Gaia id); ESA-style files (metadata lines, `null`,
  extra columns, several files) give the same stars as a table; the pre-pass finds the source
  next to a Tycho-2 row; bulk chunks streamed after a core table give the same tree as one table;
  the download resumes a partial file with a range request and removes a corrupt one.
* **Bounded memory** (`galmap.scale_test`, synthetic stars streamed in chunks; bucket 250,000,
  capacity 256): 1 million stars 318 MB peak, 4 million 325 MB, 8 million 337 MB (97,496 nodes, 35
  sub-manifests, 40 s). `tests/test_scale.py` checks that four times the stars need no more
  memory.
* **App** (`tests/js/octree-sub.test.ts`, synthetic dataset with 300 nodes in 18 sub-manifests):
  a lazily grown tree selects what the complete tree selects; a sub-manifest is fetched once;
  route corridors load exactly the nodes they touch; node keys do not depend on the load order;
  version 1 manifests are read as before. In a browser (477 nodes, 65 sub-manifests, served
  through `VITE_DATA_URL`): the view loads 9 files at the start and 61 when zoomed out, the search
  finds stars in sub-manifests, and a route from the Sun to Polaris loads the 15 files of its
  corridor.
