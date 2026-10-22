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
  the route box; once both are set the route is computed.
* Start, destination and mode are stored in the browser (designations and names) and the route
  is computed again after a reload, once the data is there.

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
  the search got closest to the destination.
* **Data:** all octree nodes that intersect the network corridor are loaded completely, in
  addition to the nodes of the view (the route box shows the loading progress). Once loaded, the
  shown stars of the corridor are copied, so the nodes may be evicted again.
* **Limits:** the corridor computation is refused (with a message) if it would hold more places or
  candidate pairs than the network limits allow; a Sun–Betelgeuse route must stay well within them.
* Changing a network setting (range, capacities, hub preference, connection), a display filter
  (brown dwarfs, white dwarfs, distance uncertainty) or the hiding of stars by a data layer
  computes the route again.

## Display

* The route is drawn as a thick line (a few pixels wide, a colour of its own that differs from
  the network colours) from star to star, **always visible**: it is not limited to the visible
  sphere, so zooming out shows the whole route.
* Small markers at the waypoints; start and destination are always labelled; the names of
  waypoints inside the visible sphere are labelled by the usual label logic.
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
