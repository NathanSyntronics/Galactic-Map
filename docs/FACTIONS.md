# Factions

A faction grows from its home star along the jump network, year by year, and the map shows it for
the date on the clock. Version 1.19 has one faction: the **Solar Empire** (*Solares Imperium*),
starting from the Sun in 2027. The example factions of earlier versions (a dataset of fixed
territories) were removed in 1.18.

Set the clock (top left) to a year per second or faster to watch the faction grow. The settings
are under *Layers → Factions*.

## Rules

* **Income.** Every colony earns credits each year. In its first year it earns the *starting
  income* (1 credit), and each year after that it earns *the increase* (0.2 credits) more, up to the
  *maximum* (100 credits a year). The home system's first year is the *first year* (2027); a
  colony founded during a year earns from the next one. All credits go into one pool per faction.
* **Route.** The faction looks for the place it reaches at the lowest cost: a star of one of its
  *classes* (F, G, K) that is not part of a multiple system (*only single stars*). The route can
  start at any of its systems, colonies and stations alike. It runs through the jump network, and
  a jump of d light years costs `k^(d − 1)` credits (exponential, k = 2) or `d^k` (polynomial). These
  are the route costs of the jump network (docs/ROUTES.md, "Jump costs"); the faction has its own k.
* **Building.** As soon as the pool holds the cost of the route's next jump, the jump is paid. The
  system reached gets a **station**, or a **colony** at the end of the route. Stations earn
  nothing. Then the faction looks for the next route. Several jumps can be paid in one year.
* **End.** When no suitable place is left in the faction's region, the faction stops growing
  (*nothing left to settle within the region*); its credits keep adding up.

Ties (equal costs) go to the place with the smaller stable key, so the same stars and settings
always give the same history.

## The region

The faction grows in the jump network of the stars within its *region* around its home: 150 ly by
default, at most 250 ly. The network is computed with the settings of the jump network (range,
links per star, hubs, connecting groups) and from the stars shown (brown and white dwarfs,
distance uncertainty). Changing them computes it again. Its size:

| region | places | loading and network (desktop) | everything settled by |
|---|---|---|---|
| 100 ly | 8,600 | 1.4 s | 2192 |
| 150 ly | 28,700 | 2.6 s | 2213 |
| 200 ly | 66,900 | 5.8 s | 2227 |
| 250 ly | 128,600 | 10.9 s | 2239 |

(With the default parameters; the growth is about exponential once there are a few dozen colonies,
so a larger region is filled only a few decades later.)

The Solar Empire's first steps with the default settings: a station at Alpha Centauri (2033),
at Luhman 16 (2035) and at Sirius (2058), more stations towards Orion, and the first colony at
Pi³ Orionis (2067, 26 ly). By 2100 it has 15 colonies and 37 stations.

## On the map

Colonies get a wide rim in the faction's colour, stations a thin, fainter one, and the jumps by
which they were reached are drawn as lines in the same colour (a station's fainter). Like the stars
the filter finds, the faction's systems are drawn whatever the level of detail. The panel shows the
year's state: colonies, stations, the credits in the pool and the income of the year.

## Implementation

* `src/factions/sim.ts`: `FactionSim`, the simulation on a graph of places and links, year by year
  as far as the clock asks (`advanceTo`). The cheapest cost from the faction's systems to every
  place is kept up to date as systems are added (costs only fall, a Dijkstra search from each new
  system), so finding the next route needs no search over the whole network; the colonies' income
  is summed in constant time (their first years are in order, those at the maximum are a prefix).
  The 250 ly region (46,000 systems settled) is simulated in well under a second.
* `src/factions/world.ts`: the faction's graph from a jump network (which places it settles, the
  stars of each place), and the stored parameters (`localStorage`, `galactic-map:factions`).
* `src/app.ts` (*factions*): loads the region's nodes, computes the network and runs the
  simulation; draws the rims (`MARK_FACTION` codes in the star shader) and the lines
  (`src/render/faction-lines.ts`).
* `src/ui/faction-box.ts`: the panel section.
