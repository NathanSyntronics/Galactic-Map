# Galactic Map

An interactive 3-D map of the Sun's stellar neighbourhood, built from real star catalogues.

* **Correct positions.** Every star is placed at its measured position: sky coordinates plus
  a trigonometric parallax from Gaia DR3, Hipparcos or the 20 pc census. The positions are
  converted into a heliocentric galactic coordinate system (X towards the Galactic Centre,
  Z towards the North Galactic Pole).
* **As many stars as possible.** About 2.8 million stars are included:
  * every known object within 20 pc (65 ly), including brown dwarfs;
  * every star with good Gaia astrometry within 100 pc (326 ly);
  * all Tycho-2 stars, which are the brighter stars, out to several thousand light years.
* **The most common names first.** Each star is labelled with its most commonly used name:
  * the title of its English Wikipedia article, if that is a name or a designation up to a
    survey number ("Epsilon Eridani", "Gliese 436", "Luyten 726-8"); the IAU name, which then
    stays the first alternative, wins only over a title that is the IAU name plus a component
    letter ("Sirius A" -> "Sirius");
  * otherwise the IAU name;
  * otherwise a Bayer or Flamsteed designation, a historical catalogue name (Wolf 359,
    Lalande 21185), a variable-star name or a Gliese number;
  * catalogue numbers only when nothing else exists (survey numbers such as LHS, LP or the
    Luyten "L" numbers; a Wikipedia title that is an HR / HIP / HD number before them).

  Wikidata labels are only ordinary name candidates, never the Wikipedia tier. German names are
  the German article title when it is not a worse kind of name than the English one ("Lacaille
  9352" for "Gliese 887") or the German form of the English name ("Ny¹ Columbae", "Barnards
  Pfeilstern"). Components of a system are named after the primary ("Sirius B") unless they have
  a name of their own (Wikipedia, IAU, SIMBAD common name); the IAU name of a primary plus a
  letter becomes the primary's display name plus the letter ("Zeta Herculis B", not "Tianji B");
  no two stars carry the same display name (a resolved pair gets "CT Ceti A" / "CT Ceti B"), and
  a sub-component keeps its own letter ("Castor Ab", not "Castor A" next to "Castor Aa").
  The system label follows the primary's name, or the title of a Wikipedia article about the
  whole system ("Epsilon Lyrae"; its members keep their own names, "Epsilon² Lyrae A", or take
  the title with their letter, "40 Eridani A").
* **Explore by mouse, touch or keyboard.** Only stars within an adjustable radius around the
  view centre are shown (50 ly by default). Move the view centre and new stars stream in.
* **English and German**, switchable in the settings.

## Using the map

| | Mouse | Touch | Keyboard |
|---|---|---|---|
| Rotate | left drag | one finger | arrow keys |
| Move | right drag / Shift + left drag | two-finger drag | W A S D, R / F (up/down) |
| Zoom | wheel | pinch | + / − |
| Details | click a star | tap | |
| Centre on a star | double-click | double-tap | |
| Back to the Sun | | | H |
| Names / grid / search | | | L / G / / |

Hold Shift for faster keyboard movement.

The settings panel (☰) controls:
* the visible radius;
* brown dwarfs (off by default) and white dwarfs;
* a maximum distance uncertainty;
* labels, star size, brightness and colour saturation;
* the galactic grid and the height lines;
* the level of detail;
* the language.

Star colours follow the effective temperature. Symbol sizes follow the luminosity; true
stellar diameters would be invisibly small.

## Data sources

| Catalogue | Used for |
|---|---|
| [20 pc census](https://exoplanetarchive.ipac.caltech.edu/docs/20pcCensus.html) (Kirkpatrick et al. 2024, ApJS 271, 55) | everything within 20 pc: positions, parallaxes, spectral types, brown dwarfs, system hierarchy, names |
| [Gaia Catalogue of Nearby Stars](https://doi.org/10.1051/0004-6361/202039498) (Gaia Collaboration, Smart et al. 2021) | stars within 100 pc |
| [Gaia DR3](https://www.cosmos.esa.int/web/gaia/dr3) (Gaia Collaboration 2023), parallax zero point after Lindegren et al. 2021 | astrometry and colours of the Tycho-2 / Hipparcos stars |
| [AT-HYG v4.0](https://codeberg.org/astronexus/athyg) and [HYG v4.4](https://codeberg.org/astronexus/hyg) (D. Nash, CC BY-SA 4.0) | 2.5 million Tycho-2 / Hipparcos stars, classical designations, Gliese systems |
| [IAU Catalog of Star Names](https://exopla.net/star-names/modern-iau-star-names/) (WGSN) | official proper names |
| [SIMBAD](https://simbad.cds.unistra.fr/) (Wenger et al. 2000, CDS Strasbourg) | identifiers, common names, object types and spectral types within 100 pc |
| [Wikidata](https://www.wikidata.org/) (CC0), queried via [QLever](https://qlever.dev/) | English and German Wikipedia article titles, the reference for the most common name |
| [Mamajek's dwarf sequence](https://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt) (Pecaut & Mamajek 2013) | colour → temperature, bolometric corrections |

The generated star data contains data derived from HYG / AT-HYG and is therefore published
under **CC BY-SA 4.0**. The rest of the code is under the MIT licence.

## How it works

```
pipeline/   Python: download catalogues → cross-match → positions → physics → systems
            → names → LOD octree (public/data/)
src/        TypeScript + three.js web app
docs/       DATA_FORMAT.md – the binary format shared by both sides
```

### Merging the catalogues

The pipeline (`pipeline/galmap/merge.py`) gives the sources this precedence:
1. the 20 pc census;
2. Gaia DR3;
3. Hipparcos / Gliese.

It handles the following cases:
* **Matching.** Stars are matched by Gaia source_id, then by HIP number, then by position with
  proper-motion propagation.
* **Bad cross-identifications.** A Gaia link is rejected when the Gaia G magnitude is
  inconsistent with V.
* **Phantom neighbours.** Stars that old catalogues place within 19 pc but that the census
  does not confirm are removed. These are the result of bad Hipparcos or Gliese distances.
* **Quality cut.** Stars with a parallax error above 100 % or beyond 15 kpc are dropped. The
  app can additionally hide stars by distance uncertainty (20 % by default).

Multiple systems (`systems.py`) are grouped from three sources:
* the census hierarchy;
* the Gliese system grouping;
* a wide-binary search on Gaia data, using projected separation, parallax agreement and the
  escape velocity.

### Level of detail

The stars are stored in an octree (`pipeline/galmap/octree.py`):
* Each node keeps the most luminous stars of its cube that are not already in an ancestor.
* Distant regions therefore show their brightest stars first.
* Nodes are bundled into a few pack files that the app reads with HTTP range requests.

## Building

Requirements: Python ≥ 3.11 and Node ≥ 20.

```bash
# star data (downloads ~600 MB of catalogues on the first run, ~15 min)
python -m venv .venv && .venv/bin/pip install -r pipeline/requirements.txt
cd pipeline && ../.venv/bin/python -m galmap.build --out ../public/data
../.venv/bin/python -m galmap.verify ../public/data    # sanity checks against known stars
cd ..

# web app
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

Tests: `npm test` (decoder, cross-checked against a fixture written by the Python writer)
and `cd pipeline && python -m pytest`.

### Deployment

`.github/workflows/pages.yml` builds the star data and the app and deploys them to
GitHub Pages on every push to `main`. To enable it, set *Settings → Pages → Source* to
*GitHub Actions*. The catalogue downloads are cached between runs.
