# Galactic Map

An interactive 3-D map of the Sun's stellar neighbourhood, built from real star catalogues.

* **Correct positions.** Every star is placed at its measured position: sky coordinates plus
  a trigonometric parallax from Gaia DR3, Hipparcos or the 20 pc census. The positions are
  converted into a heliocentric galactic coordinate system (X towards the Galactic Centre,
  Z towards the North Galactic Pole).
* **As many stars as possible.** About 4.3 million stars are included:
  * every known object within 20 pc (65 ly), including brown dwarfs;
  * every star with good Gaia astrometry within 100 pc (326 ly);
  * every Gaia DR3 star between 100 and 200 pc (650 ly) whose parallax is better than 10 %;
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
  view centre are shown (20 ly by default). The radius follows the zoom, so zooming out shows a
  larger region. Move the view centre and new stars stream in.
* **Your own data on the map.** Give stars attributes of your own (a faction, an economy value,
  a colour …), edit them on the map or as a CSV file, and colour or size the stars by them or by
  catalogue data such as the number of known exoplanets or the spectral class.
* **A jump network.** Stars up to a jump range apart (9 ly by default) are linked; bright stars
  get more links than faint ones. Every rule is adjustable.
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
| Names / grid / jump network / search | | | L / G / J / / |

Hold Shift for faster keyboard movement.

The search finds stars by name or catalogue designation; while the field is empty it lists the
last three stars picked from the search (newest first, kept in the browser). A click or tap next
to the open settings panel, or on the backdrop of a dialog, closes it; that click does not select
or deselect a star, and a drag still turns the view.

The settings panel (☰) controls:
* the visible radius, and whether it follows the zoom (on by default: radius = camera distance
  / 2.2, the framing of the start view; the radius slider then moves the camera; switched off,
  the radius stays where it is);
* brown dwarfs (off by default) and white dwarfs;
* a maximum distance uncertainty;
* labels, star size (0.2× to 12×), brightness and colour saturation;
* the galactic grid and the height lines;
* the level of detail (how many stars may be loaded at once; it matters only for view radii of a few hundred light years and more);
* the data layers (below);
* the jump network (below);
* the language.

Star colours follow the effective temperature. Symbol sizes follow the luminosity; true
stellar diameters would be invisibly small.

### Data layers and your own attributes

Under *Data layers* in the settings, the star colours and sizes can follow any attribute:
* **catalogue data**: known exoplanets (NASA Exoplanet Archive), spectral class, temperature,
  luminosity, absolute magnitude, distance from the Sun, distance uncertainty;
* **your own attributes**.

Numbers are drawn on a colour scale (four palettes, adjustable range, optionally logarithmic or
reversed) and can set the symbol size; text values get one colour per value; colour attributes
(`#rrggbb`) colour each star directly. Stars without a value are drawn grey and small, hidden, or
as usual. A legend explains the colours.

**Attributes** are managed under *Attributes & CSV…*: each has a name, a type (text, number,
colour) and optionally *whole system*: a value given to one star then applies to all stars of its
multiple system (it is stored on the system's primary star). Values are edited on a star's info
card or imported from a CSV file.

**CSV files** have one row per star. The star is named in the first column, or in a column
called `designation`, `Bezeichnung` or `name`: a name ("Sirius", "Barnards Pfeilstern") or a
catalogue designation ("HIP 32349", "HD 48915", "TYC 9007-5848-1", "Gaia DR3 …"). Every other
column is an attribute. A tag in the header sets the type and the system flag:
`Faction [text, system]`, `Economy [number]`, `Flag colour [color]` (German: `[Zahl]`, `[Farbe]`,
`[Text]`); without a tag the type follows the values. Comma, semicolon and tab separated files
and decimal commas are recognised. The export writes the same format: English with `,`, German
with `;` and decimal commas, so that spreadsheet programs open it directly. Try
[`docs/example-attributes.csv`](docs/example-attributes.csv).

Every star has a primary designation (shown under its name on the info card) that is unique in
the dataset; attribute values are stored under it, so they survive rebuilds of the star data.

The attributes are stored in the browser (localStorage). A site can ship a dataset of its own
as `public/user/attributes.csv`: visitors see it until they change something, and *Back to the
site's dataset* returns to it.

### Jump network

The jump network links stars that are at most the *jump range* apart (9 ly by default). It is
specified in [`docs/JUMP_NETWORK.md`](docs/JUMP_NETWORK.md):
* **Places.** A multiple system counts as one place; its members are never linked to each other.
  Stars closer than 0.1 ly (about 6,300 AU) to each other count as one place too, which covers
  binaries the catalogues do not mark as a system. Only the stars that are shown take part, so
  hiding brown dwarfs or stars without a value changes the network. A place is represented by its
  most luminous shown star.
* **Capacity.** Each place wants a number of links. By default it follows the luminosity:
  2 for brown dwarfs (log L ≤ −4.5), 6 for Sun-like stars, 12 for stars from about 30 L☉ up
  (log L ≥ 1.5), linear in log L in between (Sirius, 18.5 L☉, gets 11). It can instead follow a
  numeric attribute (yours or catalogue data) along the range of the attribute's colour scale;
  a higher value always gives more links, even when the colour scale is reversed.
* **Which links.** All pairs within the range are candidates.
  1. They are taken in order of the distance, weighted by `(kSun² / (k₁ · k₂))^h`, where `k₁` and
     `k₂` are the two capacities and `h` is *prefer big stars*. A link is accepted while both
     places still have free capacity. With `h > 0` big stars are served first.
  2. A place that has a neighbour within range but no link gets one to its nearest neighbour.
  3. *Connect everything in range* then adds the shortest links that join separate groups, so
     that every star the range can connect is connected.

  The selection is deterministic: the same stars and settings give the same links, whatever
  the order in which the data arrived.
* **Region.** The network is computed from the stars within the visible radius plus a margin of
  three jump ranges around the view centre, so links inside the visible sphere do not change
  when the view moves. The stars of the margin are loaded only when all of them fit the detail
  level's point budget, so the network never thins out the stars in the visible sphere. More
  than 150,000 places or 1.5 million candidate pairs are not computed, and neither is a region
  whose stars do not all fit the detail level (the settings then ask for a smaller radius); with
  the default detail level this allows radii up to about 230 ly. The default view (20 ly) takes
  about 15 ms, 100 ly about 30 ms, 200 ly about 0.2 s; a slow computation waits until the view
  rests.
* **Display.** Lines coloured by their length (or in the stars' colours, or one teal) end at the
  edge of the visible sphere, fading out like the stars, and get fainter when many stars are in
  view. The selected star's links are highlighted (the others dimmed while it is inside the
  visible sphere), and its info card lists them with distances; a click on one (or Enter) goes
  there and keeps the keyboard focus in the card. **J** switches the network on and off.

Settings (section *Jump network*): jump range (2–25 ly), number of links by luminosity or by an
attribute, links of faint, Sun-like and bright stars (0–20), prefer big stars (0–2), connect
everything in range, line colour and opacity.

## Data sources

| Catalogue | Used for |
|---|---|
| [20 pc census](https://exoplanetarchive.ipac.caltech.edu/docs/20pcCensus.html) (Kirkpatrick et al. 2024, ApJS 271, 55) | everything within 20 pc: positions, parallaxes, spectral types, brown dwarfs, system hierarchy, names |
| [Gaia Catalogue of Nearby Stars](https://doi.org/10.1051/0004-6361/202039498) (Gaia Collaboration, Smart et al. 2021) | stars within 100 pc |
| [Gaia DR3](https://www.cosmos.esa.int/web/gaia/dr3) (Gaia Collaboration 2023), parallax zero point after Lindegren et al. 2021 | astrometry and colours of the Tycho-2 / Hipparcos and GCNS stars; all stars between 100 and 200 pc |
| [Hipparcos new reduction](https://doi.org/10.1051/0004-6361:20078357) (van Leeuwen 2007) | parallaxes of bright stars whose Gaia solution is poor |
| [AT-HYG v4.0](https://codeberg.org/astronexus/athyg) and [HYG v4.4](https://codeberg.org/astronexus/hyg) (D. Nash, CC BY-SA 4.0) | 2.5 million Tycho-2 / Hipparcos stars, classical designations, Gliese systems |
| [IAU Catalog of Star Names](https://exopla.net/star-names/modern-iau-star-names/) (WGSN) | official proper names |
| [SIMBAD](https://simbad.cds.unistra.fr/) (Wenger et al. 2000, CDS Strasbourg) | identifiers, common names, object types and spectral types within 100 pc |
| [Wikidata](https://www.wikidata.org/) (CC0), queried via [QLever](https://qlever.dev/) | English and German Wikipedia article titles, the reference for the most common name |
| [NASA Exoplanet Archive](https://exoplanetarchive.ipac.caltech.edu/) (Planetary Systems Composite Parameters, DOI 10.26133/NEA13) | number of known planets per host star |
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
2. Gaia DR3 (parallaxes corrected for the zero point of Lindegren et al. 2021);
3. the Hipparcos new reduction, where it is more precise than a poor Gaia solution (bright,
   saturated stars; Gaia errors are inflated by the RUWE before comparing);
4. Gliese distances for the few stars without either.

It handles the following cases:
* **Matching.** Stars are matched by Gaia source_id, then by HIP number, then by position with
  proper-motion propagation (one-to-one, closest pairs first).
* **Bad cross-identifications.** A Gaia link is rejected when the Gaia G magnitude is
  inconsistent with V; the rejected source then never supplies the distance.
* **Duplicates.** A catalogue entry without Gaia astrometry that coincides with a Gaia star in
  position, parallax and brightness is merged into it, with its names and identifiers.
* **Phantom neighbours.** Stars that old catalogues place certainly inside 20 pc but that the
  census does not confirm are removed. These are the result of bad Hipparcos or Gliese distances.
* **Multiple systems.** Components of a tight census system share one distance (individual
  parallaxes of close pairs are perturbed by the orbit); a faint companion with a noisy parallax
  is placed at its system's distance if that lies within its own error bars.
* **Gaia field stars.** Between 100 and 200 pc, every Gaia DR3 source with a five- or six-parameter
  solution whose corrected parallax is better than 10 % (errors inflated by the RUWE) is added,
  unless it is already in the catalogue: 1.5 million stars.
* **Quality cut.** Stars with a parallax error above 100 % or beyond 15 kpc are dropped. The
  app can additionally hide stars by distance uncertainty (20 % by default).

Multiple systems (`systems.py`) are grouped from four sources:
* the census hierarchy;
* the Gliese system grouping;
* the Washington Double Star catalogue (via SIMBAD), checked for consistent distances;
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
# star data (downloads ~900 MB of catalogues on the first run, ~30 min)
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
