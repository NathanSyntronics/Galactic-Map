# Factions

A faction grows from its home star along the jump network, year by year, and the map shows it for
the date on the clock. The **Solar Empire** (*Solares Imperium*) starts from the Sun in 2027; more
factions can be made with any home star. Several factions grow together, and a system belongs to
one of them at most. The example factions of earlier versions (a dataset of fixed territories)
were removed in 1.18.

Switch them on under *Layers → Factions* (off by default; switching them on also shows the
legend), and set the clock (top left) to a year per second or faster to watch them grow.

## Rules

* **Income.** Every colony earns credits each year: in its first year the *income step* (0.1
  credits), and each year after that as much more (0.2, 0.3, …), up to the *maximum* (10 credits a
  year, reached after 100 years). The home system's first year is the *first year* (2027); a
  colony founded during a year earns from the next one. All credits go into one pool per faction.
* **Route.** The faction looks for the place it reaches at the lowest cost: a star of one of its
  *classes* (F, G, K) that is not part of a multiple system (*only single stars*). The route can
  start at any of its systems, colonies and stations alike. It runs through the jump network, and
  a jump costs what the jump network's route costs say (*Layers → Jump network*, the same for
  every faction): d light years cost d^k (polynomial, default k = 1: the distance) or k^(d − 1)
  (exponential); see docs/ROUTES.md, "Jump costs".
* **Building.** As soon as the pool holds the cost of the route's next jump, the jump is paid. The
  system reached gets a **station**, or a **colony** at the end of the route. Stations earn
  nothing. Then the faction looks for the next route. Several jumps can be paid in one year.
* **Several factions.** Each year all factions get their income first; then they buy their jumps
  in turn, one each, round and round, as long as any of them can, so that none is served first. A
  system one faction holds (colony or station) is closed to all others: their routes go around it,
  and a route that it cuts is planned anew. A faction whose home system another one already holds
  never starts.
* **End.** When no suitable place is left in the faction's region, it stops growing (*nothing left
  to settle within the region*); its credits keep adding up.

Ties (equal costs) go to the place with the smaller stable key, so the same stars and settings
always give the same history.

## New factions

*New faction* asks for a name and a home star: a named star by its name or designation
("Vega", "HR 7001"), or any star selected on the map. A new faction gets the Solar Empire's
parameters and the next free colour (turquoise, red, yellow, purple, green, orange, blue, pink); its
name, first year, income, classes, region and colour can be changed under *Parameters*, where it
can also be deleted. At most eight factions. They are stored in the browser.

## The region

The faction grows in the jump network of the stars within its *region* around its home: 150 ly by
default, at most 250 ly. The network is computed with the settings of the jump network (range,
links per star, hubs, connecting groups) and from the stars shown (brown and white dwarfs,
distance uncertainty). Changing them computes it again. Its size:

| region | places | loading and network (desktop) |
|---|---|---|
| 100 ly | 8,600 | 1.4 s |
| 150 ly | 28,700 | 2.6 s |
| 200 ly | 66,900 | 5.8 s |
| 250 ly | 128,600 | 10.9 s |

The Solar Empire alone in its 150 ly region, with the default parameters:

| jump costs | first steps | 2100 | 2200 | region settled |
|---|---|---|---|---|
| linear (default) | station Lalande 21185 (2039), colony Groombridge 1618 (2044), Epsilon Eridani (2051), Tau Ceti (2052) | 335 colonies, 240 stations | (all) | 2128 |
| exponential, k = 2 | stations Alpha Centauri (2040), Luhman 16 (2044), Sirius (2076), …, colony Pi³ Orionis (2089) | 4 colonies, 11 stations | 96 colonies, 188 stations | 2319 |

## On the map

Colonies get a wide rim in the faction's colour, stations a thin, fainter one, and the jumps by
which they were reached are drawn as lines in the same colour (a station's fainter). Like the stars
the filter finds, the factions' systems are drawn whatever the level of detail. The legend lists
the factions with their colours and the year's figures: colonies and stations, then the year's
income and the credits in the pool. A star's card shows under *Attributes* the faction it belongs to: colony
or station, and since when.

## Implementation

* `src/factions/sim.ts`: `FactionSim`, one faction's simulation on a graph of places and links;
  `FactionsSim` runs several together, year by year as far as the clock asks (`advanceTo`), and
  closes a system taken by one to the others (by the stable key of its brightest star, so also in
  their own networks). Each faction keeps one Dijkstra search running over the whole simulation:
  a new system enters its frontier at cost 0, and the search goes on only as far as the next
  route needs (costs only fall, so no place is searched again unless its cost fell). A place
  closed by another faction leaves some costs too low; they are lower bounds, so a chosen route
  without a closed place is still the cheapest, and only a route through a closed place makes the
  faction search again from all its systems. The colonies' income is summed in constant time
  (their first years are in order, those at the maximum are a prefix).
* Speed (1.22): two factions with 150 ly regions are simulated from 2027 until both regions are
  settled in about 0.1 s in all (two 250 ly regions, 35,000 systems: 0.4 s); version 1.20 took
  minutes for that, as every closed place made the other faction search its whole network again
  from each of its systems. The app gives the simulation at most about 6 ms per frame and draws
  the last year simulated meanwhile (*catching up with the clock*), so even a clock at 100,000
  years a second or a jump far ahead never freezes the map; the rims and links of new systems are
  added to what is drawn, not drawn again.
  Once a faction has nothing left to settle and every colony earns its maximum, its later years
  follow from a formula (the pool grows by the same income each year) instead of being simulated.
* `src/factions/world.ts`: the faction's graph from a jump network (which places it settles, the
  stars of each place), and the stored parameters (`localStorage`, `galactic-map:factions`).
* `src/app.ts` (*factions*): loads the region's nodes, computes the network and runs the
  simulation; draws the rims (`MARK_FACTION` codes in the star shader) and the lines
  (`src/render/faction-lines.ts`).
* `src/ui/faction-box.ts`: the panel section.
