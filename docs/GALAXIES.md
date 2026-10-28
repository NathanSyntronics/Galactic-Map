# Galaxies

The map shows the galaxies whose distances are measured independently of their redshift: the
Local Group, the galaxies of the Local Volume (to about 36 million ly) and the 55,877 galaxies of
Cosmicflows-4 (to about 1.5 billion ly). Galaxies with only a redshift distance or only a position
on the sky are not included. This document is the specification the implementation follows.

## Data (`pipeline/galmap/galaxies.py`)

    cd pipeline && python -m galmap.galaxies --out ../public/data

### Sources

| Catalogue | What | Galaxies |
|---|---|---|
| Local Volume Database (Pace 2025, release v1.1.1, GitHub) | dwarf galaxies of the Local Group and the Local Volume: satellites of the Milky Way and Andromeda, field dwarfs to about 10 Mpc; distances, half-light radii, ellipticities, position angles, magnitudes | 732 with a distance |
| Updated Nearby Galaxy Catalog (Karachentsev, Makarov & Kaisina 2013, AJ 145, 101) | all known galaxies within about 11 Mpc: distances and their method, Holmberg diameters, axis ratios, types, luminosities | 869, of which 90 have a distance from their velocity only (left out) |
| Cosmicflows-4 (Tully et al. 2023, ApJ 944, 94) | distances of 55,877 galaxies from the tip of the red giant branch, Cepheids, masers, surface brightness fluctuations, supernovae, the fundamental plane and the Tully-Fisher relation | 55,877 |
| 2MASS Extended Source Catalog (IRSA) | total radius, axis ratio, position angle and K magnitude of the galaxies it has | |
| Wikidata | English and German names, Wikipedia articles and catalogue numbers (Messier, NGC, IC, UGC, ESO) of the 17,000 galaxies with a PGC number | |

The machine-readable tables of both papers come from the publisher (the VizieR and EDD copies
were not reachable when this was built); all downloads are cached in `pipeline/cache/galaxies`.

### One list

* Cosmicflows-4 is the base (PGC numbers). A UNGC galaxy is the same as a Cosmicflows-4 galaxy
  within 1.5' (or a sixth of its Holmberg diameter, for large nearby galaxies), an LVDB dwarf within
  1.5' (or half its half-light radius), if their distance moduli also agree within 1 mag; the
  nearest one wins. Unmatched galaxies are added.
* **Distance:** the most precise of the catalogues' distances (smallest distance-modulus error;
  where a catalogue gives none, the method's typical error). The method is kept (TRGB, Cepheids,
  masers, SBF, SN Ia, SN II, fundamental plane, Tully-Fisher, RR Lyrae, horizontal branch, CMD,
  brightest stars, group membership, …). Galaxies without a redshift-independent distance are
  left out.
* **Position:** right ascension, declination and distance → heliocentric galactic Cartesian
  coordinates in light years, the frame of the stars.
* **Size:** the UNGC's Holmberg diameter (about the 26.5 mag/arcsec² isophote in B); else the
  2MASS total diameter or the LVDB half-light diameter, scaled to the Holmberg diameter by the
  median ratio of the galaxies that have both; else from the luminosity (a fit of size against
  luminosity).
* **Shape:** axis ratio and position angle from the LVDB, else 2MASS, else the UNGC's axis ratio
  with a fixed pseudo-random position angle.
* **Orientation in space:** the major axis lies on the sky at the position angle; the disk is
  tilted out of the sky plane about it by the inclination that the axis ratio gives
  (`cos² i = (q² − 0.2²) / (1 − 0.2²)`, 0.2 being a disk's own thickness). Which way it is tilted
  the sky does not tell; a fixed pseudo-random choice. So every galaxy looks from the Sun as it
  does on the sky.
* **Class:** spiral, lenticular, elliptical, irregular, spheroidal (dwarf spheroidal / dwarf
  elliptical) from the UNGC's type; for Cosmicflows-4 galaxies without one, elliptical if their
  distance comes from the fundamental plane or SBF and not from Tully-Fisher, else spiral; LVDB
  dwarfs without one: spheroidal for satellites, irregular for field dwarfs.
* **Luminosity** (log L☉): the UNGC's K-band luminosity, else from the 2MASS K magnitude, else from
  M_V (LVDB) or M_B (UNGC), else from the size.
* **Names:** the Wikidata label in English and German where it is a common name with a Wikipedia
  article (Andromeda Galaxy / Andromedagalaxie); else the best catalogue designation (Messier,
  NGC, IC, others; the LVDB and UNGC names such as "Bootes I" or "WLM"). Every galaxy keeps its
  designations (PGC number first). Name ranks: 0 common name, 1 Messier, 2 NGC, 3 IC, 4 other,
  99 PGC number only.
* **Local Group:** members are the galaxies within 1.5 Mpc of the barycentre between the Milky Way
  and Andromeda (at 55 % of the way to Andromeda).
* **The Milky Way** is the first record, drawn as a model (see below), at the Galactic Centre
  (Sgr A*, 8.178 kpc).

### Files

`galaxies.bin`: one 36-byte record per galaxy (little-endian):

| Offset | Type | Field |
|---|---|---|
| 0 | f32 ×3 | x, y, z (ly, heliocentric galactic) |
| 12 | f32 | diameter (ly) |
| 16 | i8 ×3 | major axis (unit vector × 127) |
| 19 | i8 ×3 | disk normal (unit vector × 127) |
| 22 | u8 | axis ratio × 255 |
| 23 | u8 | class (0 spiral, 1 lenticular, 2 elliptical, 3 irregular, 4 spheroidal, 5 Milky Way model) |
| 24 | i16 | log L☉ × 1000 (−32768: unknown) |
| 26 | u8 | relative distance error × 200 (255: unknown) |
| 27 | u8 | distance method (index into `methods`) |
| 28 | u8 | flags: 1 LVDB, 2 UNGC, 4 Cosmicflows-4, 8 Local Group, 16 named, 32 model |
| 29 | u8, u16 | reserved |
| 32 | u32 | PGC number (0: none) |

`galaxies.json`: `count`, `recordBytes`, `classes`, `methods`, `sources`, `stats` and `names`: for
every galaxy with a name or without a PGC number `[index, English, German or null, rank,
designation, [other designations]]`. A galaxy without an entry is called "PGC <number>".

## App

### Scales

* The visible radius reaches 2 billion ly, the camera 5 billion ly. Distances of a million light
  years and more are written in millions ("2.5 million ly" / "2,5 Mio. Lj") and billions.
* The galaxy files (2 MB and about 1 MB) are loaded the first time the visible radius exceeds
  20,000 ly, or the search needs them.

### Drawing (`src/render/galaxies.ts`)

* Like the stars, a galaxy is drawn while it lies in the visible sphere (the same fade at its
  edge), relative to an origin near the view centre (float precision).
* **Disk galaxies** (spiral, lenticular, irregular) are quads in their disk plane, of their true
  size and orientation, with a procedural pattern: a spiral has an exponential disk, two
  logarithmic arms (pitch 15°, a phase of its own) and a bulge; a lenticular a smooth disk and a
  bulge; an irregular clumpy noise. **Ellipticals and spheroidals** face the camera, with their
  axis ratio along their major axis's projection. Every galaxy also has a small glow facing the
  camera, so that disks seen edge-on stay visible.
* A galaxy smaller than 2 pixels on screen is drawn as a 2-pixel glow. Brightness follows the
  luminosity (log L 7 → faint, 11 → full), colours the class (spiral disks blue-white with a
  yellow bulge, ellipticals and lenticulars warm, irregulars blue, spheroidals pale).
* **The Milky Way model:** a disk of 100,000 ly with a bar (half length 16,000 ly, 27° from the
  Sun–centre line) and four arms (logarithmic, pitch 12°) plus the Local Arm, which passes the
  Sun; a stylised picture, not data. It fades in as the visible radius grows from 4,000 to
  30,000 ly; the stars stay drawn over it.
* Setting *Galaxies* (on) shows them, *Milky Way model* (on) the model.

### Labels, picking, card, search

* Named galaxies (rank < 99) in the visible sphere are label candidates, ranked by name rank and
  luminosity; the Milky Way is labelled at its centre while the model is shown.
* A click picks a star first (as before); otherwise the galaxy whose ellipse on screen contains
  the pointer (or within 6 px of a small one), the smallest of several.
* The galaxy card shows name (and German name), class, distance with error and method, the
  catalogues, diameter, luminosity, Local Group membership and the designations; *Centre view
  here* and a link to NED.
* The search knows the names and designations of all galaxies (PGC numbers too); picking one flies
  to it at a distance that shows the whole galaxy.
