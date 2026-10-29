# Galactic Map – data format (manifest version 2)

This document is the contract between the Python pipeline (`pipeline/`) and the
web app (`src/`). Both sides must implement exactly what is written here.

## Coordinate frame and units

* **Frame:** heliocentric *galactic* Cartesian coordinates.
  * `+X` points to the Galactic Centre (l = 0°, b = 0°)
  * `+Y` points in the direction of Galactic rotation (l = 90°, b = 0°)
  * `+Z` points to the North Galactic Pole (b = +90°)
  * The Sun is at the origin. The X–Y plane is the galactic plane *through the
    Sun* (the Sun lies ~20 pc above the true mid-plane; we do not correct for that).
* **Unit:** light years (ly). `1 pc = 3.261563777 ly`.
* **Epoch:** positions are the catalogue positions (Gaia: J2016.0,
  Hipparcos/HYG: J2000.0). Proper motion over a few decades moves even the
  fastest nearby stars by far less than 0.001 ly, so no epoch correction is
  applied to 3-D positions (it *is* applied when cross-matching catalogues).
* ICRS → galactic rotation matrix (Hipparcos definition, ESA 1997 Vol. 1 §1.5.3):

  ```
  [-0.0548755604, -0.8734370902, -0.4838350155]
  [+0.4941094279, -0.4448296300, +0.7469822445]
  [-0.8676661490, -0.1980763734, +0.4559837762]
  ```
  `r_gal = A · r_icrs` with `r_icrs = d · (cos δ cos α, cos δ sin α, sin δ)`.

In the three.js scene the galactic frame is mapped to the y-up world:
`world.x = X`, `world.y = Z`, `world.z = -Y` (a proper rotation, handedness preserved).

## Directory layout (`public/data/`)

```
public/data/
  manifest.json        global metadata + octree hierarchy
  m/<path>.json        sub-manifests of large subtrees (only in large datasets)
  search.json          search index of named stars
  systems.json         multiple-star systems
  n/p000.bin …         pack files, each containing many node blobs back to back
```

Node blobs are bundled into a few pack files (each subtree in depth-first order,
so a pack holds neighbouring subtrees; see docs/SCALING.md for the order of a
dataset built in buckets) instead of one file per node. This keeps the
number of files small (git, static hosting limits) while still allowing small
nodes. A client fetches one node with an HTTP `Range` request
(`bytes=offset-(offset+bytes-1)`); if the server ignores the range and answers
`200` with the whole pack, the client slices the node out of it (and may keep
the pack in memory for the other nodes in it).

## manifest.json

```jsonc
{
  "format": "galmap-octree",
  "version": 2,                          // 1: no sub-manifests (still read)
  "generated": "2026-10-14T12:00:00Z",   // ISO timestamp of the build
  "units": "ly",
  "frame": "galactic-heliocentric",
  "root": { "center": [cx, cy, cz], "halfSize": H },  // root cube, ly
  "capacity": 4096,                      // max stars stored per node
  "starCount": 2900000,
  "nodeCount": 1100,                     // all nodes, including those in sub-manifests
  "packs": ["n/p000.bin", "n/p001.bin"], // pack files, relative to manifest
  "nodes": [
    // [path, count, bytes, childMask, packIndex, byteOffset(, subManifest)]
    ["r", 4096, 104345, 255, 0, 0],
    ["r0", 4096, 109876, 17, 0, 104448],
    ["r1", 4096, 101200, 255, 3, 0, "m/r1.json"],   // descendants of r1: in m/r1.json
    ...
  ],
  "sources": [
    { "key": "census20", "title": "...", "citation": "...", "url": "...",
      "license": "...", "rows": 3601, "used": 3580 }
  ],
  "params": { ... },   // pipeline parameters used (quality cuts, thresholds)
  "stats":  { ... }    // free-form counts for display / debugging
}
```

### Sub-manifests (version 2)

A dataset of hundreds of millions of stars has hundreds of thousands of nodes; listing them all in
`manifest.json` would make every visitor load tens of MB first. The writer
(`pipeline/galmap/ooc.py`, `split_manifest`) therefore hands large subtrees to files of their own:

* A node row with a 7th field names a sub-manifest (`m/<path>.json`); the node itself stays in
  the listing, its descendants are in that file:
  `{"format": "galmap-octree-nodes", "version": 2, "path": "r1", "nodes": [rows...]}`, rows in
  the same format, which may name further sub-manifests.
* Bottom-up, a node whose listing would exceed 4,096 rows hands its largest child subtrees to
  sub-manifests until it fits, so every file lists at most about 4,096 nodes. Today's data
  (2,893 nodes) keeps a single manifest.
* The app loads a sub-manifest when the level-of-detail selection, the search or a route corridor
  reaches the node (until then the node counts as a leaf). `nodeCount` counts every node.

### Node paths and bounds

* The root node has path `"r"`. A child appends one digit `0`–`7`.
* Child index bits: `bit0 = +X half`, `bit1 = +Y half`, `bit2 = +Z half`.
* Bounds of a node: start with the root cube (`center`, `halfSize`); for each
  digit, `halfSize /= 2` and `center[axis] += (bit ? +1 : -1) * halfSize`
  (using the *new* half size).
* `childMask` bit *i* is set if child *i* exists.
* The node blob is the byte range `[byteOffset, byteOffset + bytes)` of pack
  file `packs[packIndex]`. Blobs start at multiples of 8 bytes.

### Level of detail

Stars are distributed like a Potree-style LOD octree: every node stores (up to
`capacity`) the **most luminous** stars of its cube that are not already stored
in an ancestor; the remaining stars are passed down to the children. Hence
loading a node and all its ancestors gives a complete, luminosity-ordered
sample of that cube: shallow nodes contain the brightest stars, deep nodes the
faint ones. The Sun is always stored in the root node.

## Node blob

Little-endian. All offsets inside a blob are relative to the start of the
blob and are multiples of 8 bytes, so typed-array views can be created
without copying once the blob is in its own `ArrayBuffer`.

### Header (64 bytes)

| offset | type   | field          | description                               |
|-------:|--------|----------------|-------------------------------------------|
| 0      | u32    | magic          | `0x4D4C4147` (bytes `G A L M`)            |
| 4      | u16    | version        | `1`                                       |
| 6      | u16    | reserved       | `0`                                       |
| 8      | u32    | count          | number of stars `N` in this node          |
| 12     | u32    | offPos         | offset of `pos`                           |
| 16     | u32    | offAbsMag      | offset of `absMag`                        |
| 20     | u32    | offLogL        | offset of `logL`                          |
| 24     | u32    | offTeff        | offset of `teff`                          |
| 28     | u32    | offFlags       | offset of `flags`                         |
| 32     | u32    | offDistErr     | offset of `distErr`                       |
| 36     | u32    | offSpec        | offset of `spec`                          |
| 40     | u32    | offDesigCat    | offset of `desigCat`                      |
| 44     | u32    | offDesigId     | offset of `desigId`                       |
| 48     | u32    | offExtra       | offset of the UTF-8 JSON `extra` blob     |
| 52     | u32    | lenExtra       | length of the JSON blob in bytes          |
| 56     | u32    | reserved       | `0`                                       |
| 60     | u32    | reserved       | `0`                                       |

### Columns

| column     | type          | encoding                                                                 |
|------------|---------------|--------------------------------------------------------------------------|
| `pos`      | f32 × 3N      | interleaved galactic X, Y, Z in light years (absolute, Sun at origin). Float32 keeps the rounding error below 0.002 ly even at 30,000 ly. |
| `absMag`   | i16 × N       | absolute visual magnitude `M_V × 100`; `-32768` = unknown                |
| `logL`     | i16 × N       | `log10(L / L☉) × 1000` (bolometric); `-32768` = unknown                   |
| `teff`     | u16 × N       | effective temperature in K; `0` = unknown                                |
| `flags`    | u16 × N       | bit field, see below                                                     |
| `distErr`  | u8 × N        | relative distance uncertainty: `percent × 2` (0…254 = 0…127 %); `255` = unknown |
| `spec`     | u8 × N        | spectral class code, see below                                           |
| `desigCat` | u8 × N        | catalogue of the star's primary designation, see below                   |
| `desigId`  | u32 × 2N      | designation payload `(lo, hi)` per star                                  |
| `extra`    | UTF-8 JSON    | sparse per-star extras, see below                                        |

#### flags

| bit | name              | meaning                                                         |
|----:|-------------------|-----------------------------------------------------------------|
| 0   | `BROWN_DWARF`     | substellar object (spectral type L/T/Y or catalogue flag)       |
| 1   | `WHITE_DWARF`     | white dwarf                                                     |
| 2   | `IN_SYSTEM`       | member of a multiple-star system (see `extra.s`)                |
| 3   | `SYSTEM_PRIMARY`  | the primary (most luminous member) of its system                |
| 4   | `NAMED`           | has a real name (name rank ≤ 5, see ranks)                      |
| 5   | `SRC_CENSUS20`    | data from the 20 pc census                                      |
| 6   | `SRC_GCNS`        | data from the Gaia Catalogue of Nearby Stars                    |
| 7   | `SRC_ATHYG`       | data from AT-HYG                                                |
| 8   | `SRC_HYG`         | data from HYG                                                   |
| 9   | `DIST_NO_PARALLAX`| distance not from a trigonometric parallax (photometric etc.)   |
| 10  | `SUN`             | the Sun                                                         |
| 11  | `GIANT`           | luminosity class I–III (giant / supergiant)                     |
| 12  | `VARIABLE`        | known variable star                                             |
| 13  | `SRC_GAIA`        | Gaia DR3 field star between 100 and 200 pc (no other catalogue) |
| 14  | `SRC_EXOPLANET`   | planet host from the NASA Exoplanet Archive (no other catalogue; see docs/PLANETS.md) |
| 14–15 | –               | reserved (0)                                                    |

#### spec

`255` = unknown. Otherwise `class * 10 + subclass` where subclass is the integer
part of the spectral subclass (0–9; 0 if unknown) and class is:

| class | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|-------|---|---|---|---|---|---|---|---|---|---|----|----|
| type  | O | B | A | F | G | K | M | L | T | Y | D (white dwarf) | other (C, S, W, …) |

#### desigCat / desigId

The *primary designation* is the best catalogue designation of the star (used
as stable key and as label when the star has no name).

| code | catalogue    | payload                                                   | rendered as                 |
|-----:|--------------|-----------------------------------------------------------|-----------------------------|
| 0    | (string)     | unused; designation string is in `extra.d[i]`             | as given                    |
| 1    | Hipparcos    | `lo` = HIP number                                         | `HIP 70890`                 |
| 2    | Henry Draper | `lo` = HD number                                          | `HD 48915`                  |
| 3    | Tycho-2      | `lo` = TYC1 \| (TYC2 << 16), `hi` = TYC3                  | `TYC 9007-5848-1`           |
| 4    | Gaia DR3     | 64-bit source_id = `lo + hi * 2^32`                       | `Gaia DR3 5853498713190525696` |
| 5    | Harvard (HR) | `lo` = HR number                                          | `HR 2491`                   |

Note: Gaia source ids exceed 2^53, so JavaScript must combine `lo`/`hi` with
`BigInt`.

#### extra (JSON blob)

All keys optional; star indices are the local index within the node (as JSON
object keys they are strings).

```jsonc
{
  // designation strings for stars with desigCat == 0
  "d": { "17": "WISE J085510.83-071442.5" },
  // names: [localIndex, rank, nameEn, nameDe | null, [alternative designations...]]
  "n": [ [3, 0, "Sirius", null, ["alf CMa A", "HIP 32349", "HD 48915", "GJ 244 A"]] ],
  // system membership: localIndex -> systemId (key into systems.json)
  "s": { "3": 1201 },
  // the systems referenced in "s": systemId -> [nameEn, nameDe | null, memberCount,
  //   primary designation of the system's primary star]
  "S": { "1201": ["Sirius", null, 2, "HR 2491"] },
  // spectral type strings for stars that have one: localIndex -> string
  "t": { "3": "A0mA1Va" },
  // number of known exoplanets (NASA Exoplanet Archive) of planet hosts: localIndex -> count
  "p": { "5": 3 },
  // the archive's name of those hosts (galmap.planets links the planets by it): localIndex -> name
  "h": { "5": "LHS 1678" }
}
```

`nameDe` is `null` when the German name equals the English one.

#### Name ranks

| rank | kind                                                         | example                 |
|-----:|--------------------------------------------------------------|-------------------------|
| 0    | IAU proper name (or the Sun)                                 | Sirius, Proxima Centauri|
| 1    | other common name (Wikipedia title, SIMBAD `NAME`)           | Barnard's Star          |
| 2    | Bayer designation                                            | Epsilon Eridani         |
| 3    | Flamsteed designation                                        | 61 Cygni A              |
| 4    | historical catalogue / discovery name                        | Wolf 359, Lalande 21185, Luhman 16 |
| 5    | variable-star designation                                    | EZ Aquarii              |
| 6    | Gliese / GJ                                                  | Gliese 1061             |
| 7    | proper-motion / survey catalogue                             | LHS 292, LP 816-60, WISE 0855−0714 |
| 8    | HR                                                           | HR 8832                 |
| 9    | HIP                                                          | HIP 12345               |
| 10   | HD                                                           | HD 12345                |
| 11   | TYC                                                          | TYC 1234-567-1          |
| 12   | Gaia DR3                                                     | Gaia DR3 …              |
| 13   | other survey designation (full 2MASS / WISE coordinates, …)  |                         |

The display name is the English Wikipedia article title when there is one (it is
the best available measure of which name is most commonly used), otherwise the
IAU name, otherwise the best-ranked candidate. Stars whose best name has rank
≤ 7 get an `extra.n` entry; all others are labelled with their primary
designation.

## search.json

Array of named stars (rank ≤ 7):

```jsonc
[
  // [nameEn, nameDe | null, nodePath, localIndex, x, y, z, rank, [alt designations] | null,
  //  designation, systemId]
  ["Sirius A", null, "r", 3, -5.03, -1.88, -1.34, 0, ["Sirius", "Alpha Canis Majoris A"], "HR 2491", 4149]
]
```

Coordinates in ly, rounded to 0.001. `designation` is the star's primary designation exactly as
`designationOf()` renders it from the node data; it is unique over the whole dataset and is the key
under which the web app stores user data for the star. `systemId` is the star's system (`-1` for
single stars).

## systems.json

```jsonc
{
  // systemId: [nameEn, nameDe | null, memberCount, cx, cy, cz, primary designation of the primary star]
  "1201": ["Sirius", null, 2, -5.03, -1.88, -1.34, "HR 2491"]
}
```

`cx, cy, cz` is the luminosity-weighted centroid (ly).
