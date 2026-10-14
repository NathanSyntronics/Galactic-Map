# Galactic Map – data format (version 1)

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
  search.json          search index of named stars
  systems.json         multiple-star systems
  n/p000.bin …         pack files, each containing many node blobs back to back
```

Node blobs are bundled into a few pack files (in depth-first order, so a pack
holds neighbouring subtrees) instead of one file per node. This keeps the
number of files small (git, static hosting limits) while still allowing small
nodes. A client fetches one node with an HTTP `Range` request
(`bytes=offset-(offset+bytes-1)`); if the server ignores the range and answers
`200` with the whole pack, the client slices the node out of it (and may keep
the pack in memory for the other nodes in it).

## manifest.json

```jsonc
{
  "format": "galmap-octree",
  "version": 1,
  "generated": "2026-10-14T12:00:00Z",   // ISO timestamp of the build
  "units": "ly",
  "frame": "galactic-heliocentric",
  "root": { "center": [cx, cy, cz], "halfSize": H },  // root cube, ly
  "capacity": 4096,                      // max stars stored per node
  "starCount": 2900000,
  "nodeCount": 1100,
  "packs": ["n/p000.bin", "n/p001.bin"], // pack files, relative to manifest
  "nodes": [
    // [path, count, bytes, childMask, packIndex, byteOffset]
    ["r", 4096, 104345, 255, 0, 0],
    ["r0", 4096, 109876, 17, 0, 104448],
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
| 13–15 | –               | reserved (0)                                                    |

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
  // spectral type strings for stars that have one: localIndex -> string
  "t": { "3": "A0mA1Va" }
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
| 4    | traditional / discovery catalogue name                       | Wolf 359, Lalande 21185, Luhman 16 |
| 5    | variable-star designation                                    | EZ Aquarii              |
| 6    | Gliese / GJ                                                  | GJ 1061                 |
| 7    | HR                                                           | HR 8832                 |
| 8    | HIP                                                          | HIP 12345               |
| 9    | HD                                                           | HD 12345                |
| 10   | TYC                                                          | TYC 1234-567-1          |
| 11   | Gaia DR3                                                     | Gaia DR3 …              |
| 12   | other survey designation (2MASS, WISE, …)                    |                         |

Only stars with rank ≤ 6 get an `extra.n` entry; for all others the label is the
primary designation.

## search.json

Array of named stars (rank ≤ 6):

```jsonc
[
  // [nameEn, nameDe | null, nodePath, localIndex, x, y, z, rank, [alt designations]]
  ["Sirius", null, "r", 3, -5.03, -1.88, -1.34, 0, ["alf CMa A", "HIP 32349"]]
]
```

Coordinates in ly, rounded to 0.001.

## systems.json

```jsonc
{
  // systemId: [nameEn, nameDe | null, memberCount, cx, cy, cz]
  "1201": ["Sirius", null, 2, -5.03, -1.88, -1.34]
}
```

`cx, cy, cz` is the luminosity-weighted centroid (ly).
