# Jump network

Stage 3 of the Galactic Map: stars that have neighbours within a jump range (9 ly by default)
are connected with some of them. Bigger stars get more connections than small ones, e.g. Sirius
about 11, the Sun about 6, a brown dwarf 2. Everything is adjustable in the settings.

This document is the specification the implementation follows.

## Places

* The network connects **places**: a multiple system (all stars with the same system id in the
  node data, `NodeData.systems`) or a single star. Stars of one system are never linked to each
  other.
* Only stars that are currently **shown** take part: what the display filters (brown dwarfs, white
  dwarfs, maximum distance uncertainty) and the data layers ("stars without a value: hide") leave
  visible, i.e. stars whose symbol size in the starfield is > 0. Hiding stars therefore changes the
  network, which is what one sees.
* A place is represented by its **most luminous shown member** (by `starLogL`): links start and end
  at that star, its luminosity sets the place's capacity.
* Places closer than **0.1 ly** (about 6,300 AU, `MERGE_DISTANCE`), measured between their
  representatives, are merged into one place before linking (transitively), again represented by
  the most luminous member. This covers binaries without a system id in the data (CD-40 407 /
  CD-40 407 B, 0.004 ly; G 202-59 A / B) and duplicates; with the real data about 170 such
  places within 130 ly of the Sun. The shortest possible link is therefore 0.1 ly.

## Capacity: how many links a place wants

* **By luminosity** (default), piecewise linear in log10 L/L☉ of the representative star:
  * log L ≤ −4.5 (brown dwarfs): `jumpFaint` links (default 2);
  * log L = 0 (the Sun): `jumpSun` links (default 6);
  * log L ≥ 1.5 (about 30 L☉) and brighter: `jumpBright` links (default 12; Sirius, 18.5 L☉ in
    the data, gets 11);
  * linear in between, rounded to the nearest integer.
* **By a numeric attribute** (a user attribute or a built-in one such as known planets; same
  attribute machinery as the data layers): `k = round(jumpFaint + t · (jumpBright − jumpFaint))`
  where `t` (0…1) is the value's position on the attribute's scale (`scalePosition` with
  `numericScale`: the same range and log settings as for colours). The scale's *reverse* setting
  is ignored, so a higher value always gives more links and the sliders "lowest value" and
  "highest value" mean what they say (the built-in temperature and absolute magnitude scales
  are reversed for the colours). A place whose
  representative has no value takes the value of another member that has one; without any value it
  gets `jumpFaint`. Whole-system attributes are read with `valueGetter`, so they apply to every
  member.

## Which links

Candidates are all pairs of places at most `jumpRange` apart (default 9 ly). The selection is
deterministic: the same stars and settings always give the same links, whatever the order in
which the data arrived.

1. **Capacity links.** Candidates are sorted by the cost
   `d · (kSun² / (k_a · k_b))^h`, where `d` is the distance, `k_a`, `k_b` are the capacities,
   `kSun` is `jumpSun` (at least 1) and `h` is the hub preference (`jumpHub`, default 1; 0 = pure
   distance). Ties are broken by distance, then by a stable key of the two places (their
   coordinates). Going through the list, a candidate is accepted if both places still have a free
   capacity. Each place ends with at most its capacity; big places (high capacity) are served first
   when `h > 0`, so they reach their capacity before small neighbours fill up with each other.
2. **Nobody alone.** A place that has a candidate but no link gets a link to its nearest
   candidate, even if that partner is already full.
3. **Connected** (`jumpConnect`, default on). The accepted links are merged into components
   (union–find); the remaining candidates are then taken by increasing distance and accepted
   whenever they join two different components (Kruskal). The network then connects every place
   that the jump range connects at all, with as few extra links as possible.

Links carry their kind (capacity, nobody alone, connection) so that tests and the display can tell
them apart.

## Computation region

* The network is computed from the loaded, shown stars within `R + M` of the view centre, where `R`
  is the visible radius and `M = 3 · jumpRange` a margin. Measured with the real data: computing
  the same region from two centres 0.3 `R` apart gives the same links inside both spheres
  (`R` = 20, 50, 100 and 200 ly, several directions: no differing link except 1 of 2,063 at 50 ly
  and 1 of 135,000 at 200 ly). It cannot be exactly 0 for every margin, because the connection
  step is not local.
* Drawn are all links of the region. Their opacity fades towards the edge of the visible sphere
  like the stars (smoothstep from `0.85 R` to `R`, per fragment, around the current view centre),
  so a link to a star outside the sphere ends at its edge and links outside it are not seen. The
  view can therefore move by up to `M − jumpRange` (two ranges) between computations without
  links missing at the leading edge of the sphere.
* While the network is on, the level-of-detail selection uses the radius `R + M` instead of `R`
  (same point budget), so that the stars just outside the visible sphere are loaded too; they stay
  invisible because the star shader fades them out at `R`. This wider selection is used only when
  it is complete (every node that touches the region fits the budget, `selectWithMargin`);
  otherwise the selection is exactly the one for `R` alone, so the network never costs stars inside
  the visible sphere. (A complete wider selection holds every node that touches the sphere, which is
  what `R` alone selects then too.) Checked with the real tiles (camera at 2.2 `R`, 800 px, `R`
  from 20 to 1,000 ly, low and medium detail, two centres): the stars inside `R` are the same with
  the network on and off; always using `R + M` had cost up to 45 % of them.
* If the region holds more than 150,000 places or 1.5 million candidate pairs, the network is not
  computed and the settings show a hint to reduce the radius. Measured in a browser (4-core
  container, software rendering, with the earlier defaults: range 10 ly, 3 / 7 / 12 links):
  20 ly about 15 ms, 100 ly 25–35 ms, 150 ly 65–95 ms, 200 ly (105,000 places) 150–200 ms,
  occasionally up to 0.45 s. With the default detail level the limit is reached at about 230 ly.
  After such a result the level-of-detail selection goes back to `R` alone (the region's extra
  stars are of no use) until the network is switched on again, the jump range or the shown stars
  change, the radius drops below 90 % of the one that failed (not on every step of a zoom: each try
  loads the whole region and computes in vain), or the view centre has moved by more than `R`;
  then it tries again.
* If the point budget cuts the level-of-detail selection inside the region (not every node that
  touches the region is selected), the network is not computed either, because its links would
  change with the camera position; the settings ask to reduce the radius or raise the detail
  level. With the default detail level this happens beyond about 250 ly (the place limit comes
  first), with the phone default (low) beyond about 150 ly.
* Recomputed (throttled, at most every 250 ms and spaced by 4× the last computation time) when the
  view centre has moved by more than 5 % of `R`, when nodes are loaded or evicted, when a setting
  that affects the network changes, and when attributes change (capacity by attribute, hidden
  stars). A computation that took more than 50 ms waits until the view has rested for 300 ms (or
  the centre has moved by `min(0.3 R, M − jumpRange)`, where the drawn links stop covering the
  sphere), so that moving the view stays smooth.
* **Zooming.** The radius follows the zoom by default (radius = camera distance / 2.2, updated in
  steps of 1 %). While the radius changes (and for 300 ms after) and the drawn links still cover
  the visible sphere (`offset + R ≤ R₀ + M − jumpRange`, `R₀` the radius of the last
  computation), no computation runs at all, however fast: zooming in never needs one, zooming
  out only once the sphere grows beyond the drawn links (and then a slow one still waits for the
  view to rest). After the zoom, too, a radius change (or a level of detail that only drops nodes)
  computes nothing while the network is complete and its region holds the one the view needs
  (`offset + R + M ≤ R₀ + M`) without being more than 1.5 times as large (`networkServes` in
  `src/network/places.ts`); so zooming in tick by tick from 160 ly to 98 ly computes nothing (it
  used to compute after each tick: 40–200 ms), and the next tick computes the smaller region once. Measured in a browser (software rendering): a 6 s wheel zoom out and back in
  around 40 ly ran no computation instead of 17 of about 25 ms; a 3 s zoom out from 20 to 59 ly ran
  two; zooming from 150 ly out past the limit (235 ly) and back to 150 ly ran none during the zoom
  and one after it. A 2.9 s wheel zoom from 20 to 300 ly (with the drawing switched off, so that
  frames come at a real rate) ran two computations (at 40 and 61 ly, 40–55 ms), the zoom back in
  none; the app's own work per frame was 3 ms (median) and 24 ms (95th percentile) out, 1.3 and
  10 ms back in.

## Display

* Thin lines (`THREE.LineSegments`, vertex colours with alpha), positioned relative to an origin
  near the view centre so that float32 precision is not lost far from the Sun.
* Colour (`jumpColor`): `stars` – each end takes the current colour of its star (temperature or
  data layer, so faction colours show), `uniform` – a calm teal (apart from the blue grid and
  height lines), `length` – short to long links on a palette. Opacity: `jumpOpacity`, lowered
  automatically when many stars are in view (factor `√(1500 / stars in view)`, at least 0.2), like
  the faint stars, so that dense regions stay readable.
* The links of the selected star's place are highlighted (accent colour, full opacity); the other
  links are dimmed to 45 % meanwhile, but only while the selected place lies within `R` of the view
  centre (outside, its links are faded out and nothing would explain the dimming).
* The info card lists the selected star's links: partner name (or designation) and distance,
  sorted by distance. Clicking one selects that star and centres the view on it; the keyboard
  focus moves to the new card's title, so one can walk the network with Tab and Enter.
* The status line in the settings counts the places inside the visible sphere and their links,
  with singular forms ("1 star or system in view, 7 links").
* The legend shows a line sample "Jump link ≤ 9 ly" while the network is on.
* Keyboard: **J** toggles the network.
* While a route is shown (`ROUTES.md`) and the visible radius is larger than `3 · range`, the
  network is neither drawn nor computed, and its margin is not loaded; the legend and the status
  line in the settings say so, and the info card lists no links. Zoomed in again, it is computed
  for the current view.

## Settings

| key | default | control |
|---|---|---|
| `jumps` | `true` | checkbox "Jump network" |
| `jumpRange` | `9` | slider 2–25 ly |
| `jumpFaint`, `jumpSun`, `jumpBright` | `2`, `6`, `12` | sliders 0–20 ("faint stars", "Sun-like stars", "bright stars (from about 30 L☉)"; by attribute: "lowest value", "highest value") |
| `jumpBy` | `''` (luminosity) | select: luminosity or a numeric attribute |
| `jumpHub` | `1` | slider 0–2 "prefer big stars" |
| `jumpConnect` | `true` | checkbox "connect everything in range" |
| `jumpColor` | `'length'` | select |
| `jumpOpacity` | `0.6` | slider |

Settings are stored as differences from the defaults (see `src/settings.ts`), English and German
texts in `src/i18n.ts`.
