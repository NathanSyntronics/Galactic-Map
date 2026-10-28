# Scaling to hundreds of millions of stars

The map holds 4.3 million stars today. Gaia DR3 has 1.47 billion stars with a parallax, about
98 million with a distance better than 10 % and 192 million better than 20 %. This document is the
architecture that lets the pipeline and the app handle such numbers, and the specification the
implementation follows. Nothing here downloads the large catalogues; the pipeline is prepared for
them and tested with synthetic data.

## What does not scale today

* **The pipeline holds everything in memory.** Every star is a row of one pandas table from the
  download to the octree; the build peaks at about 7 GB for 4.3 million stars, so 100 million would
  need well over 100 GB.
* **The octree is built in one piece** (`octree.build_octree`), with all positions and luminosities
  in memory.
* **One manifest lists every node.** 2,893 nodes today (112 kB); 1.5 billion stars would need about
  360,000 nodes, a manifest of some 40 MB that every visitor loads first.
* **Field stars come through the archive's query interface** in chunks; 98 million rows would take
  about 12 hours that way, all of them far more.

## Two kinds of stars

1. **The core catalogue**: every star that needs cross-matching, names, systems or the 20 pc
   census: AT-HYG / HYG / Hipparcos / Tycho-2 with their Gaia matches, the GCNS within 100 pc, the
   census, SIMBAD, Wikidata, IAU names, exoplanet hosts. A few million rows. This part of the
   pipeline stays as it is (in memory, `build.py` up to the naming).
2. **Bulk field stars**: Gaia DR3 sources that are not in the core catalogue (by `source_id`).
   They need no cross-matching and get no names (their designation is their Gaia DR3 number) and no
   systems. Each one is processed on its own: quality cut, parallax zero point, RUWE inflation of the
   error, position, colour → temperature, luminosity and absolute magnitude, flags, spectral class.
   So they are processed **chunk by chunk** with bounded memory, however many there are.

Bulk stars still get what can be looked up by their Gaia id alone, chunk by chunk: a SIMBAD main
identifier as designation (where SIMBAD has the star) and the number of known exoplanets. They get
no wide-binary systems (that search needs the neighbourhood of every star).

The Gaia stars between 100 and 200 pc that the map holds today (1.5 million) stay in the core
catalogue: they fit in memory, and there they also take part in the wide-binary search. A build
option (`--field-bulk`) sends them through the bulk path instead; a check compares both builds
(same stars, positions and physical values), so the bulk path is tested on real data.

## Bulk sources

A bulk source yields chunks (pandas tables of a bounded size) with the Gaia columns the derivation
needs (`source_id, ra, dec, parallax, parallax_error, pmra, pmdec, ruwe, phot_g_mean_mag,
bp_rp, nu_eff_used_in_astrometry, pseudocolour, ecl_lat, astrometric_params_solved`).

* `gaia_tap`: chunked ADQL queries by `source_id` range (what `gaia.load_field` does today), with a
  parallax window and quality cut in the query. Fine up to a few million rows.
* `gaia_files`: the ESA bulk files (`GaiaSource_*.csv.gz` from `cdn.gea.esac.esa.int`), read file
  by file with only the needed columns. A local directory of such files is the input; downloading
  them is a separate, resumable step (`python -m galmap.fetch_gaia_bulk`, not run by the build).
  Tested with small synthetic files in the same format.
* Selection parameters (command line / config): maximum relative distance error (default 10 %),
  maximum distance, RUWE limit, accepted astrometric solutions.

Stars of the core catalogue are skipped by a sorted array of their Gaia ids (`np.searchsorted`,
some 30 MB for 4 million ids), so a bulk chunk never duplicates a core star.

## Out-of-core octree

The octree keeps its definition: each node holds the `capacity` most luminous stars of its cube
that no ancestor holds (deterministic order: luminosity, then a hash of a stable star id), so the
output is the same whichever way it is built.

1. **Partition.** The core catalogue and every bulk chunk are streamed into **buckets**: the nodes
   at a fixed split depth `D` of the root cube. Each bucket is a file of fixed-width records on disk
   (the columns the node writer needs). `D` is chosen so that a bucket stays below a few million
   stars (`D = 0` for small datasets: one bucket, the whole tree in memory as today).
2. **Upper levels.** The nodes above depth `D` take stars from many buckets. A node at depth
   `d < D` takes at most `capacity` stars, and from any one bucket the brightest ones not taken by
   its ancestors; so all stars the upper levels can take from a bucket are among its brightest
   `capacity · D`. These candidates of all buckets are gathered and the upper levels are built from
   them in memory, exactly as `build_octree` would; the stars they take are marked.
3. **Subtrees.** Each bucket is loaded on its own, its marked stars are dropped, and its subtree is
   built and encoded; nodes are appended to the pack files as they are finished.

Memory is bounded by one bucket plus the candidates of the upper levels (`8^D · capacity · D`
stars), not by the number of stars. Disk needs about twice the final data size during the build.

## Hierarchical manifest

* `manifest.json` lists the nodes down to the split depth as today. A node whose subtree has more
  than `SUBTREE_NODES` nodes (default 4,096) gets the field `sub`: the name of a **sub-manifest**
  (`m/<path>.json`) that lists the nodes of its subtree in the same row format. Smaller subtrees stay
  in the main manifest, so today's data keeps a single manifest.
* The app loads a sub-manifest when the level-of-detail selection first wants to look below that
  node; until then the node counts as a leaf (its own stars are shown). Route planning, which needs
  every node of a corridor, loads the sub-manifests of the corridor first.
* The format version of the manifest goes to 2; the node files do not change. The app reads
  version 1 and 2.

## Hosting

GitHub Pages serves up to about 1 GB. Larger data goes to object storage with HTTP range requests
and CORS (for example Cloudflare R2 or S3 behind a CDN); the app reads the data base URL from
`VITE_DATA_URL` (default: `data/` next to the app). Packs may then be larger (e.g. 64 MB) to keep
the number of files down.

## Expected sizes

About 40 bytes per star in the packs (today: 170 MB for 4.3 million).

| Selection | Stars | Packs | Manifests |
|---|---|---|---|
| today | 4.3 million | 170 MB | 1 |
| Gaia, distance better than 10 % | ~98 million | ~4 GB | ~10 |
| Gaia, distance better than 20 % | ~192 million | ~8 GB | ~20 |
| Gaia, every star with a parallax | ~1.47 billion | ~60 GB | ~150 |

Build time is dominated by reading the input (a few hours for the bulk files) and by the per-star
derivation (vectorised, millions of stars per second).

## Checks

* The build of today's data through the new octree writer gives the same stars (positions,
  values, names, designations) as before; `galmap.verify` passes.
* A build with `--field-bulk` gives the same field stars with the same positions and physical
  values as the core path (differences only in systems and SIMBAD-only names, reported).
* A synthetic build with tens of millions of bulk stars stays within a fixed memory limit (the peak
  is logged and tested) and produces sub-manifests that the app reads.
* The app is tested with a synthetic dataset that has sub-manifests (loading on demand, routes
  across them).
