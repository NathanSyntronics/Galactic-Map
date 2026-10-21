# Jump network

Stage 3 of the Galactic Map: stars that have neighbours within a jump range (10 ly by default)
are connected with some of them. Bigger stars get more connections than small ones, e.g. Sirius
about 11, the Sun about 7, a brown dwarf 3. Everything is adjustable in the settings.

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

## Capacity: how many links a place wants

* **By luminosity** (default), piecewise linear in log10 L/L☉ of the representative star:
  * log L ≤ −4.5 (brown dwarfs): `jumpFaint` links (default 3);
  * log L = 0 (the Sun): `jumpSun` links (default 7);
  * log L ≥ 1.5 (Sirius, 25 L☉, and brighter): `jumpBright` links (default 12);
  * linear in between, rounded to the nearest integer.
* **By a numeric attribute** (a user attribute or a built-in one such as known planets; same
  attribute machinery as the data layers): `k = round(jumpFaint + t · (jumpBright − jumpFaint))`
  where `t` (0…1) is the value's position on the attribute's scale (`scalePosition` with
  `numericScale`, the same range, log and reverse settings as for colours). A place whose
  representative has no value takes the value of another member that has one; without any value it
  gets `jumpFaint`. Whole-system attributes are read with `valueGetter`, so they apply to every
  member.

## Which links

Candidates are all pairs of places at most `jumpRange` apart (default 10 ly). The selection is
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
* Drawn are the links with at least one end within `R`. Their opacity fades towards the edge of the
  visible sphere like the stars (smoothstep from `0.85 R` to `R`, per fragment, so a link to a
  star outside the sphere ends at its edge).
* While the network is on, the level-of-detail selection uses the radius `R + M` instead of `R`
  (same point budget), so that the stars just outside the visible sphere are loaded too; they stay
  invisible because the star shader fades them out at `R`.
* If the region holds more than 150,000 places or 1.5 million candidate pairs, the network is not
  computed and the settings show a hint to reduce the radius. Measured in a browser (4-core
  container, software rendering): 20 ly about 15 ms, 100 ly 25–35 ms, 150 ly 65–95 ms, 200 ly
  (105,000 places) 150–200 ms, occasionally up to 0.45 s. With the default detail level the
  limit is reached at about 230 ly.
* If the point budget cuts the level-of-detail selection inside the region (not every node that
  touches the region is selected), the network is not computed either, because its links would
  change with the camera position; the settings ask to reduce the radius or raise the detail
  level. With the default detail level this happens beyond about 200 ly, with the phone default
  (low) beyond about 150 ly.
* Recomputed (throttled, at most every 250 ms and spaced by 4× the last computation time) when the
  view centre has moved by more than 5 % of `R`, when nodes are loaded or evicted, when a setting
  that affects the network changes, and when attributes change (capacity by attribute, hidden
  stars). A computation that took more than 50 ms waits until the view has rested for 300 ms (or
  the centre has moved by 0.3 `R`), so that moving the view stays smooth.

## Display

* Thin lines (`THREE.LineSegments`, vertex colours with alpha), positioned relative to an origin
  near the view centre so that float32 precision is not lost far from the Sun.
* Colour (`jumpColor`): `stars` – each end takes the current colour of its star (temperature or
  data layer, so faction colours show), `uniform` – a calm teal (apart from the blue grid and
  height lines), `length` – short to long links on a palette. Opacity: `jumpOpacity`, lowered
  automatically when many stars are in view (factor `√(1500 / stars in view)`, at least 0.2), like
  the faint stars, so that dense regions stay readable.
* The links of the selected star's place are highlighted (accent colour, full opacity); the other
  links are dimmed to 45 % meanwhile.
* The info card lists the selected star's links: partner name (or designation) and distance,
  sorted by distance. Clicking one selects that star and centres the view on it.
* The legend shows a line sample "Jump link ≤ 10 ly" while the network is on.
* Keyboard: **J** toggles the network.

## Settings

| key | default | control |
|---|---|---|
| `jumps` | `true` | checkbox "Jump network" |
| `jumpRange` | `10` | slider 2–25 ly |
| `jumpFaint`, `jumpSun`, `jumpBright` | `3`, `7`, `12` | sliders 0–20 ("faint stars", "Sun-like stars", "bright stars") |
| `jumpBy` | `''` (luminosity) | select: luminosity or a numeric attribute |
| `jumpHub` | `1` | slider 0–2 "prefer big stars" |
| `jumpConnect` | `true` | checkbox "connect everything in range" |
| `jumpColor` | `'stars'` | select |
| `jumpOpacity` | `0.6` | slider |

Settings are stored as differences from the defaults (see `src/settings.ts`), English and German
texts in `src/i18n.ts`.
