# Spacecraft

The map shows the five spacecraft on their way out of the Solar System: Voyager 1 and 2, Pioneer 10
and 11 and New Horizons, each on its real trajectory and at its position for the date drawn (the
planets' clock: now, or running faster).

## Data (`pipeline/galmap/probes.py`)

    cd pipeline && python -m galmap.probes --out ../public/data

* **JPL Horizons** (`ssd.jpl.nasa.gov/api/horizons.api`): the heliocentric state vectors (ICRF, AU
  and AU/day) every 10 days from two days after launch to the end of each trajectory file (2100
  for the Voyagers, 2050 for the others), cached in `pipeline/cache/probes/`.
* Turned into the galactic frame of the map. Points that interpolating linearly in time between
  their neighbours reproduces to 0.001 AU are left out (about 160 of 4,500 points remain per
  probe); the velocity at the last point continues the trajectory in a straight line.
* `probes.json` (34 kB): per probe `key`, `name`, `launch` (UTC), `t` (Julian dates), `p` (galactic
  AU) and `v` (AU/day after the last point); `sources`.

Distances on 1 January 2026: Voyager 1 169 AU, Voyager 2 142 AU, Pioneer 10 140 AU, Pioneer 11
116 AU, New Horizons 64 AU.

## App (`src/data/probes.ts`, `src/render/probes.ts`, `src/ui/probe-card.ts`)

* Each probe's path from launch to its position at the date drawn, and a small diamond there;
  drawn while the Sun or the probe is in the visible sphere and its distance from the Sun is at
  least 12 px on screen (fading in to 40 px). Their labels come first (*Spacecraft*, settings,
  *Space*).
* A click picks a probe before a planet or a star; its card: launch, distance from the Sun, the
  time a radio signal takes, its speed relative to the Sun, the date drawn (these follow the
  planets' clock, docs/PLANETS.md), a short history and the NASA mission page. *Centre*
  flies to it far enough out to see the Sun too. While a probe is drawn, the clock is on the map.
* The search knows them ("Voyager 1"), and shared links carry them (`k=voyager1`).
