# Route planning

A route connects two stars through the jump network (see `JUMP_NETWORK.md`): a sequence of jumps,
each one a link of the network with the current settings. Routes can be long, e.g. from the Sun
to Betelgeuse (about 500 ly; with the default settings some 115 jumps and 770 ly, see
*Measurements*), far beyond the region in which the network is drawn around the view centre.

This document is the specification the implementation follows.

## Start and destination

* Any shown star can be start or destination; the route connects their **places** (a multiple
  system counts as one place, as in the network).
* The info card has the buttons **Route from here** and **Route to here**. Setting one end shows
  the route box; once both are set the route is computed. Choosing the star of the other end
  clears that end.
* Start, destination and mode are stored in the browser (designations and names, plus the node
  and index of the star) and the route is computed again after a reload, once the data is there.
  The node and index are checked against the designation first. If the star data was rebuilt,
  the star with that designation is looked for near the stored position (within 1 ly, or 2 % of
  its distance from the Sun, at most 10 ly; this finds every star), then by an exact lookup of the
  designation in the search index (named stars only). If neither finds it, the route box says that
  it could not be located; if the search index could not be loaded, it says so and offers to try
  again.

## What counts as the best route

* Mode **fewest jumps** (default): the smallest number of jumps; among those the shortest total
  distance.
* Mode **shortest distance**: the smallest sum of jump lengths; among those the fewest jumps.
* Ties beyond that are broken deterministically (by the places' stable keys), so the same stars
  and settings always give the same route.

## The corridor

The network is only known where stars are loaded. A route is therefore searched in a corridor
around the straight line from start to destination:

* **Search corridor:** the places within distance `w` of the segment start–destination take
  part in the path search. `w` starts at `2 · jumpRange`.
* **Network corridor:** the network itself is computed from the shown stars within
  `w + 3 · jumpRange` of the segment, the same margin the view network uses. Links between places
  of the search corridor are then the same as in the network drawn around the view centre.
* **Widening:** if there is no path inside the search corridor, `w` is doubled and the search
  repeated, up to `w = 128 ly`. If there is still no path, the route box says that the destination
  cannot be reached with this jump range (and suggests a larger range); it names the place where
  the search got closest to the destination, and the path to that place is drawn fainter.
* **Data:** all octree nodes that intersect the network corridor are loaded completely, in
  addition to the nodes of the view (requested after them; the route box shows the loading
  progress by tiles and megabytes). The planner keeps the decoded data of the last corridor
  (decoded nodes are never changed) with sizes of its own, computed with the current settings, so
  the loader may evict the nodes again and a recomputation with other settings only loads what a
  wider corridor adds. Tiles that cannot be loaded (after the loader's retries) stop the
  computation; the route box offers to try again. A tile the loader had already given up on
  before the computation (e.g. while the view needed it on a bad connection) is asked for once
  more per computation; only a tile that fails during the computation stops it.
* **Limits:** the corridor computation is refused (with a message) if it would hold more places or
  candidate pairs than the network limits allow; a Sun–Betelgeuse route must stay well within them.
  A corridor whose nodes hold more than 64 MB is refused before loading (Sun–Betelgeuse at
  `w = 128`: 25 MB).
* Changing a network setting (range, capacities, hub preference, connection), a display filter
  (brown dwarfs, white dwarfs, distance uncertainty) or the hiding of stars by a data layer
  computes the route again, 400 ms after the last change (sliders change continuously). A start or
  destination that is hidden by the settings is not part of the network: the route box says so.

## Display

* The route is drawn as a thick line (a few pixels wide, a colour of its own that differs from
  the network colours) from star to star, **always visible**: it is not limited to the visible
  sphere, so zooming out shows the whole route.
* Small markers at the waypoints (rings, so the star stays visible; they shrink to 4 px when zoomed
  out), larger ones at start and destination (also at a destination the partial route of an
  unreachable one does not reach); start and destination are always labelled (also
  with names switched off, in a tint of the route colour). Every waypoint is a label candidate,
  also outside the visible sphere (the route is drawn there too), and waypoints are labelled
  before all other stars, named ones before catalogue designations; labels still never overlap, so
  zoomed out only some of them show. Route labels do not fade at the edge of the visible sphere.
  The labels of start and destination are never merged into the label of another member of their
  system (e.g. the selected one).
* **Only the route when zoomed out:** while a route is shown and the visible radius is larger than
  `3 · jumpRange`, the general network is not drawn (and not computed); zoomed in, the network is
  drawn as usual with the route on top. With *radius follows zoom* (the default) zooming out
  enlarges the visible radius, so this happens by zooming alone; with a fixed radius only the
  radius slider changes it.
* **Route box** (bottom left, above the legend; full width on phones): start → destination,
  status (loading, computing, result: number of jumps, total distance, straight-line distance),
  buttons for: swap, mode, the list of waypoints (name, jump length; a click selects the star and
  centres the view on it), **show whole route** (centres the view on the route and zooms out so it
  fits; it only moves the camera, and the visible radius follows when it follows the zoom) and
  remove.
  * Waypoints are listed by their system's name when they have one.
  * A waypoint click also zooms in to at most the default framing when the radius follows the
    zoom (radius at most min(20 ly, 3 · range)), so the network around the star shows.
  * *Show whole route* fits the route and both chosen stars (a partial route does not reach the
    destination) into the part of the screen below the top bar and, on phones, above the route box.
  * On phones the info card covers the lower half: while it is open, the route box moves under
    the top bar in short form (start → destination and the status), and the legend is left out.
  * While the old route is recomputed (other settings, mode, swap) it stays drawn; a new start or
    destination removes it at once.
* **Flyby** (`src/controls/tour.ts`, `Navigation.startTour`): *Fly the route* flies the camera
  along the route, one waypoint per 0.5, 1, 2.5 (default) or 5 seconds (the choice beside the
  button, stored with the settings, changeable during the flight).
  * The view centre moves on a smooth curve through the waypoints (centripetal Catmull-Rom, which
    makes no loops between jumps of uneven length); it speeds up over the first 0.6 step and brakes
    over the last 0.6 jump.
  * First it flies to the start (or, when the view centre is within two typical jumps of a
    waypoint and zoomed in to at most 20 of them, to that waypoint: a stopped flyby continues
    where it stopped); the camera then stays about three typical (median) jumps behind and 22°
    above the direction of travel, which it takes from the route one jump back to four ahead and
    follows smoothly, so the view turns gently where the route zigzags.
  * The user may zoom and pan during the flight (a pan stays as an offset from the route); once
    they turn the view, the camera no longer turns with the route. Any other flight (a search, a
    waypoint, *show whole route*, *Centre view here*), a new route and *Stop* end it.
  * The box shows the waypoint the flight is at ("Star 12 of 115: Gliese 250"), whose label is
    always shown. On phones an open star card is closed and the waypoint list folded at the start.

## Implementation

The pure core (no three.js, no DOM; tests in `tests/js/route.test.ts` and `tests/js/capsule.test.ts`):

* `src/network/capsule.ts`: distance of a point to the segment; exact distance between the
  segment and an axis-aligned box (`boxIntersectsCapsule`); `nodesInCapsule`, the octree nodes of
  all levels (parents first) whose cube meets a capsule, i.e. the nodes to load for a corridor. A
  segment with start = end is a sphere.
* `buildPlaces` / `computeNetwork` (`src/network/places.ts`) take an optional `to`: the region is
  then the capsule of `radius` around the segment centre–to, i.e. the network corridor.
* `src/network/route.ts`:
  * `findPath(graph, start, goal, { mode, corridor })`: Dijkstra with the lexicographic cost of
    the mode, over the links whose two ends lie in the search corridor (start and goal always take
    part). Exact ties: going back from the destination, the best predecessor with the smaller
    key. The search runs from the end with the smaller key, so swapping start and destination
    gives the same route reversed. Result: places, jump lengths, number of jumps, total; without a
    path, the path to the reached place closest (in a straight line) to the destination and its
    distance.
  * `corridorWidths(range)`: `2 · range`, doubled, the last one 128 ly (9 ly: 18, 36, 72, 128).
  * `planRoute(request, networkFor)`: the widening loop. `networkFor({ width, networkWidth })` is
    the app's part: it loads the nodes of the network corridor and computes its network, or
    refuses (too many places or pairs). The result is *found*, *unreachable* (with the path to the
    closest place of the widest search), *refused* (with the last narrower search), *missing*
    (start or destination star not part of the network) or *cancelled* (`AbortSignal`).

**In the app:**

* `src/network/planner.ts`, `RoutePlanner`: the ends, the mode and the status; the loading of the
  corridor nodes through a host interface (the app: octree, loader, current settings and data
  layers, search index, localStorage); the network of each corridor with `computeNetwork` and the
  same capacity rule and node keys as the view network; `planRoute`; the result with the waypoints
  (representative stars of the places), jumps, total, straight-line distance and timings. A new
  computation (another end, mode, setting) cancels a running one. Tests with a fake octree in
  `tests/js/planner.test.ts`.
* `src/render/route.ts`, `RouteLine`: the route as `Line2` (three's fat lines, 3 CSS px, magenta
  `rgb(255, 77, 214)`) over a 6 px dark casing, drawn after the network lines and before the stars,
  with ring markers drawn last; vertices relative to the route's centre (float32 precision); no
  fade, and the camera's far plane is extended to the whole route.
* `src/ui/route-box.ts`, the route box; `src/app.ts` wires it up: the corridor nodes are added to
  the loader's wanted list after the view's, the network is neither drawn nor computed (and its
  region not loaded) while only the route is shown, and the legend shows the route and that the
  network is hidden.

## Measurements

`npm run bench:route` (`tools/bench-route.mjs`), Node 22 in the 4-core container, default
network settings (9 ly, links 2 / 6 / 12, prefer big stars 1, connect on). Times in ms, varying
by about ±30 % between runs.

**Synthetic corridor**, 500 ly, uniform 0.003 places per ly³ (about the density within 200 ly of
the Sun), luminosities of a rough solar-neighbourhood mix:

| w | network width | places | pairs | network | search places | fewest jumps | shortest distance |
|---|---|---|---|---|---|---|---|
| 18 | 45 | 10,861 | 46,462 | 38–57 | 1,629 | no path | no path |
| 36 | 63 | 22,099 | 96,150 | 19–25 | 6,810 | 110 jumps, 721 ly | 114 jumps, 701 ly |
| 72 | 99 | 58,682 | 259,255 | 45–50 | 29,250 | 108 jumps, 719 ly | 114 jumps, 701 ly |
| 128 | 155 | 160,011 | 713,414 | 155–190 | 103,851 | over the place limit | |

The path search takes 2–6 ms at w ≤ 36, 15–30 ms at 72 and 80–110 ms over 100,000 places.

**Real data, Sun → Betelgeuse** (497.9 ly), corridor nodes from `nodesInCapsule`, stars styled
with the default settings, network by `computeNetwork` with `to`:

| w | network width | nodes | data | stars | places | pairs | network | fewest jumps | shortest distance |
|---|---|---|---|---|---|---|---|---|---|
| 18 | 45 | 57 | 11.6 MB | 151,475 | 6,958 | 19,296 | 77 | no path (98 ly short) | no path |
| 36 | 63 | 79 | 14.5 MB | 199,685 | 14,488 | 46,533 | 35–60 | 114 jumps, 772 ly | 116 jumps, 766 ly |
| 72 | 99 | 113 | 19.2 MB | 285,202 | 38,031 | 119,468 | 52–56 | 110 jumps, 767 ly | 112 jumps, 747 ly |
| 128 | 155 | 147 | 25.0 MB | 395,251 | 102,551 | 309,063 | 180–285 | 110 jumps, 767 ly | 112 jumps, 747 ly |

Whole runs of `planRoute` from the Sun (data already decoded): Vega (25 ly) 7 jumps, 53 ly, at
w = 18; Arcturus (37 ly) 7 jumps, 48 ly, at 18; Pollux (34 ly) 10 jumps, 69 ly, at 36;
Betelgeuse at 36, network 35 ms and search 3 ms in total over both widths.

Findings:
* The search is cheap; computing the corridor network costs more, and loading the corridor's
  nodes (12–15 MB for Betelgeuse) costs most.
* The network is sparse (about 3.9 links per place, mean link 5.9 ly), so routes are long: about
  1.5 times the straight distance, with about 4.4 ly of progress per jump.
* Inside the first corridor (`w = 18`) the links often do not connect a long route: Sun →
  Betelgeuse needs 36 in the real data and in the synthetic cloud (another random cloud found
  one at 18). The first try is not wasted for loading, since its nodes are part of the next
  corridor.
* The loop stops at the first width with a path, as specified; a wider corridor can give a
  slightly better route (Betelgeuse: 110 instead of 114 jumps at w = 72).
* At `w = 128` the real Betelgeuse corridor stays within the limits (102,551 places), but a
  corridor with a uniform 0.003 places per ly³ would be refused (160,011 places): where the data
  is dense, the widest try is refused rather than computed.

**In the browser** (dev server on localhost, headless Chromium with software rendering in the
same container, default settings, view at the Sun already loaded; whole runs from the click to
the result):

| route | result | widths | nodes | data | places | load | network | search | total |
|---|---|---|---|---|---|---|---|---|---|
| Sun → Betelgeuse | 114 jumps, 772 ly | 18, 36 | 79 | 14.5 MB | 14,488 | 160–310 ms | 130–160 ms | 15–30 ms | 0.37–0.50 s |
| the same, shortest distance (data kept) | 116 jumps, 766 ly | 18, 36 | 79 | | | 0 | 80–140 ms | 10 ms | 0.13–0.2 s |
| Sun → Vega | 7 jumps, 53.3 ly | 18 | 40 | 11.4 MB | 1,043 | 1 ms | 55–70 ms | 3–6 ms | 0.11–0.13 s |
| Sun → Vega, range 2 | unreachable (closest: the Sun, 25 ly short) | 4 … 128 | 80 | 15.8 MB | 23,276 | 440 ms | 100 ms | 20 ms | 0.56 s |
| Sun → Betelgeuse, range 7 | unreachable (closest: the Sun) | 14 … 128 | 141 | 23.7 MB | 93,668 | 550 ms | 400 ms | 16 ms | 1.0 s |

* With the data kept, mode changes, swaps and filter changes take 50–150 ms.
* After a reload the restored Sun–Betelgeuse route is there after about 3 s: the corridor's
  tiles load after the view's. From a zoomed-out view (the whole route, radius ≈ 300 ly) it takes
  about 8 s (measured with the production build), because the view's ~600,000 stars come first.
* On a simulated phone (390 × 844, pixel ratio 2) the Sun–Betelgeuse route took 1.7–2.2 s.
* At range 7 the Sun's group has only four places (the Sun, Alpha Centauri, Barnard's Star and
  one more), none of them closer to Betelgeuse than the Sun; checked independently in Node.
