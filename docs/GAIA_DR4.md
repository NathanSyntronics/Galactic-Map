# Gaia DR4

Gaia Data Release 4 is announced for **2 December 2026**. It is based on 66 months of data, where
DR3 used 34, and has about 2 billion sources in `gaia_source`. Parallax errors shrink roughly with the
square root of the time span, so they come out about 1.4 times smaller than in DR3. Proper motions
improve by about 2.7 times. This document describes what the map takes from DR4, what the
pipeline already does for it, and what still has to be checked once the data is out.

The DR4 details here come from ESA's draft data model of 26 June 2026
(`gaia-dr4-prerelease-draft-data-model_2026-06-26`, on ESA's public Gaia FTP server). Column
names may still change before the release.

## What DR4 means for the map

| | Gaia DR3 (today) | Gaia DR4 (estimate) |
|---|---|---|
| Archive query beyond 200 pc (ϖ/σ > 90) | 5.8 million rows | about 9.5 million rows |
| Stars beyond 200 pc with parallaxes better than 1 % | 4.4 million | about 7 million |
| … of them new to the map | 3.6 million | about 6 million |
| Site (all tiles) | about 357 MB | about 480 MB |
| First download from the archive | (cached) | about 1.6 times as long as DR3's |

Basis of the estimate: with errors 1.39 times smaller, the 1 % limit of DR4 corresponds to
ϖ/σ > 72 in DR3. The star counts scale like the DR3 counts above that limit.

The stars within 200 pc stay as they are for now: the GCNS within 100 pc, the 100–200 pc field and
the cross-matches with Hipparcos and Tycho-2. All of these are DR3-based. A later step could
move them to DR4 too (see "Later" below).

## What changes between the releases

* **New source numbers.** DR4 assigns its own `source_id`s ("Gaia DR4 …"), which are not
  stable against DR3. Their encoding is the same: a HEALPix level-12 pixel in bits 36–63, so the
  pipeline's chunking by `source_id` range works unchanged. The same number can belong to
  different stars in DR3 and DR4.
* **`dr3_neighbourhood`.** For every DR4 source, this table lists its DR3 neighbours within 2″:
  `dr3_source_id`, `angular_distance` (mas, after moving the DR4 position back to J2016.0),
  `magnitude_difference` (G, DR4 − DR3) and `probable_match`. A probable match is closer than
  60 mas and has −0.25 ≤ ΔG ≤ 0.35.
* **Epoch.** Positions are at J2017.5 (`ref_epoch`), not J2016.0.
* **Parallax zero point.** Each row has a `tentative_parallax_bias`, to be subtracted from the
  parallax. It replaces the Lindegren et al. (2021) recipe of DR3.
* **No `astrometric_params_solved`.** Instead there are `astrometry_origin` (which processing
  produced the solution: AGIS, the source-environment or crowded-field pipeline, or a
  non-single-star model) and `unreliable_astrometry`. The unreliable flag is set when the
  uncertainty factor R exceeds 1.2, when there are too few visibility periods, or for some
  duplicated sources.
* **Cross-matches.** `hipparcos2_best_neighbour` and `tycho2tdsc_merge_best_neighbour` exist in
  DR4 too.

## What the pipeline does (ready now)

`pipeline/galmap/sources/gaia.py`:

* **`Release`** describes a data release: schema, designation prefix, epoch, zero point and
  neighbourhood table. `DR3` stays the default. `DR4` is selected by the build option
  `--gaia-release dr4` or by the environment variable `GALMAP_GAIA_RELEASE=dr4`. The GitHub
  workflow sets that variable from the repository variable `GAIA_RELEASE`.
* **The DR4 query** (`DR4_QUERIES["precise"]`) uses the same limits as the DR3 query
  (`PRECISE_WHERE`). It joins `dr3_neighbourhood`, so each source comes once per DR3 neighbour.
  For that reason every source-id range is checked by its number of *distinct* sources, compared
  with `COUNT(*)` on `gaia_source`. The ranges are kept half as large to allow for the extra rows.
* **`normalise_dr4`** turns the rows into the columns the pipeline reads from DR3:
  * `source_id` becomes the DR3 number of the same star (`dr3_counterparts`), or −1 where
    there is none. The DR4 number moves to `dr4_source_id`.
  * The DR3 counterpart is the nearest probable match. When a DR3 source has split into two
    DR4 sources, it goes to the nearer of them only.
  * `astrometric_params_solved` becomes 95 when there is a pseudocolour (six parameters), else 31,
    and 0 for unreliable astrometry. The bulk selection only takes 31 and 95, so unreliable stars
    are left out.
  * `parallax_zp` takes `tentative_parallax_bias`, or the median of the others where it is
    missing.
  * `ref_epoch` is the epoch of the position. `derive.positions` moves the star to J2016.0, the
    epoch of the tiles.
* **Designations.** A DR4 star with a DR3 counterpart keeps its "Gaia DR3 …" designation, its
  SIMBAD identifiers and its planets. Imported attributes keyed by "Gaia DR3 …" keep working too.
  A star DR3 does not have is designated "Gaia DR4 …".
* **Duplicates.** Stars the core catalogue already has (by their DR3 number) are skipped, exactly
  as with DR3.
* **Cache.** DR4 has its own cache files (`gaia_dr4_precise.parquet`), so the DR3 cache stays
  valid alongside it.
* **Readiness check.** `python -m galmap.sources.gaia check dr4` asks the archive's `TAP_SCHEMA`
  whether every table and column the DR4 query reads is there. Exit codes: 0 means ready,
  1 means something is missing (it is listed), 2 means the archive does not answer.

Tests: `pipeline/tests/test_gaia_dr4.py`.

## Switching on the release day

1. Run `cd pipeline && python -m galmap.sources.gaia check dr4` and fix any column names that
   changed (`DR4_COLUMNS`, `DR4_REQUIRED`, `Release.zero_point`).
2. Check the boolean columns in the archive's CSV (`probable_match`, `unreliable_astrometry`).
   `_truthy` reads `true`/`True`/`t`/`1`.
3. Set the repository variable `GAIA_RELEASE` to `dr4` (Settings → Secrets and variables →
   Actions → Variables) and start the workflow. The first run downloads the DR4 sample (some
   hours; an interrupted run continues where it stopped). The DR3 cache stays as it is.
4. Compare the stats in `manifest.json` (`stats`, `params.gaiaReleaseBeyond200pc`) with the
   estimate above, and check a few known stars with `python -m galmap.verify`.
5. To go back, set `GAIA_RELEASE` to `dr3` (or delete it).

## Open points

* **Photometry.** DR4's G band and its zero points differ slightly from DR3's (hence the
  asymmetric ΔG window of `probable_match`). The colour–temperature relations of the map were
  made for DR3 colours. The difference is a few hundredths of a magnitude, so it is not visible
  on the map, but it is worth a check.
* **Parallax bias.** The draft calls it "tentative". If the release brings a recipe like
  Lindegren's instead, it replaces `normalise_dr4`'s use of the column.
* **SIMBAD** will list DR4 identifiers only some time after the release. Until then a star
  without a DR3 number has no SIMBAD names.

## Later

* **The core catalogue on DR4.** This means the cross-matches with Hipparcos and Tycho-2 (both
  tables exist in DR4) and the 100–200 pc field. The GCNS is based on EDR3; within 100 pc it would
  stay the list of stars, with DR4 astrometry through `dr3_neighbourhood`.
* **More stars at 2 %.** With DR4 a 2 % limit would mean about 25 million stars and a site of
  about 1 GB, the limit of GitHub Pages.
