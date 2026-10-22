# Route planning

A route connects two stars through the jump network (see `JUMP_NETWORK.md`): a sequence of jumps,
each one a link of the network with the current settings. Routes can be long, e.g. from the Sun
to Betelgeuse (about 500 ly, some 60–80 jumps), far beyond the region in which the network is
drawn around the view centre.

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
  drawn as usual with the route on top.
* **Route box** (bottom left, above the legend; full width on phones): start → destination,
  status (loading, computing, result: number of jumps, total distance, straight-line distance),
  buttons for: swap, mode, the list of waypoints (name, jump length; a click selects the star and
  centres the view on it), **show whole route** (centres the view on the route and zooms out so it
  fits) and remove.
