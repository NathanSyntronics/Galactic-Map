# Changelog

Every round of changes that goes live raises the version by 0.01 (README, *Versions*).

## 1.25 (2026-11-16)

* A faction no longer has a fixed region: it starts in 100 ly around its home, and once nothing is
  left within reach there, its region grows by a quarter (up to 500 ly) and it goes on. It stops
  at its *most colonies* (a new parameter, 50,000 by default, in place of the region) or when
  nothing is left within reach in 500 ly. The Solar Empire alone has 50,000 colonies in 2166.
* While a region grows, the faction's simulation waits; the panel says so.

## 1.24 (2026-11-16)

* Large factions no longer dim the other stars at any zoom: the stars shown only because a faction
  (or the filter) has them no longer count as stars in view, which made the faint stars of the
  whole view fainter (by up to half), nor for the exposure.
* Number fields (a faction's first year, region; the filter's radius) are shown without thousands
  separators: "2.026" was read back as 2.026 when the field was changed. A year typed as "2.030"
  is 2030.

## 1.23 (2026-11-16)

* Zoomed far out over large factions, the other stars no longer fade away: the automatic exposure
  measures the stars' own light, not the thousands of faction rims, and far away a faction's star
  (only a point there) takes its faction's colour instead of a rim. Faction and filter stars below
  the level of detail are drawn fainter.
* A faction's region can be up to 500 ly (before: 250 ly). Its network (900,000 places at 500 ly)
  is computed while the map goes on, partly in a background worker, and needs much less memory than
  before; the simulation also pauses within long route searches, so the map keeps running.
* Long faction names and figures in the legend wrap instead of being cut off.

## 1.22 (2026-11-16)

* Factions no longer freeze the map at a fast clock: their simulation is several hundred times
  faster (two factions in 150 ly regions until both are settled: about 0.1 s instead of nearly
  three minutes), it takes at most a few milliseconds per frame and catches up over the next
  frames (the panel says so meanwhile), and new colonies and stations are added to the drawing
  instead of drawing all again.
* Once a faction has settled everything within reach and all its colonies earn their maximum, its
  later years are not simulated one by one (its pool grows by the same income every year): the
  clock can run at any speed, up to two million years ahead.

## 1.21 (2026-11-16)

* The legend shows each faction's income per year ("+3,591.6 credits a year"), with the credits in
  the pool after it; colonies and stations on the line above.

## 1.20 (2026-11-16)

* New factions: *New faction* under Layers → Factions asks for a name and a home star (a named
  star, or the star selected on the map) and gives the Solar Empire's parameters and the next free
  colour; factions can be renamed and deleted. Several factions grow together, buying their jumps in
  turn, and a system one of them holds is closed to the others.
* The legend lists the factions with their colours and the year's colonies, stations and credits;
  a star's card shows under Attributes its faction, colony or station, and since when.
* Simpler parameters: a colony earns the income step in its first year and as much more each year
  (0.1 by default, at most 10 a year); the jump costs are those of the jump network for every
  faction (linear by default: exponential with k = 2 as before is set there).
* The Solar Empire is turquoise, and the factions are off until switched on (which shows the
  legend). Parameters stored by 1.19 are not read again.

## 1.19 (2026-11-16)

* Factions: the Solar Empire grows from the Sun along the jump network, for the date on the clock.
  Every colony earns credits (1 in its first year, 0.2 more each year, at most 100; the Sun from
  2027), and the pool pays for the jumps of the cheapest route to the next F, G or K single star
  (exponential costs, k = 2): a station on every system on the way, a colony at the end. With the
  clock at a year per second or faster you watch it spread: the first station at Alpha Centauri
  in 2033, the first colony at Pi³ Orionis in 2067, 15 colonies by 2100, and the 150 ly region
  settled by about 2213. Colonies get a wide rim in the faction's colour, stations a thin one, and
  the jumps are drawn as lines. All of it can be set under Layers → Factions.

## 1.18 (2026-11-16)

* Route costs simpler: a jump of d light years costs d^k (polynomial) or k^(d − 1) (exponential,
  a checkbox), with one slider for k. A jump of one light year costs 1 either way; k = 1 is the
  shortest way (polynomial, the default) or the fewest jumps (exponential), so the route box no
  longer needs its choice of fewest jumps or shortest distance. For k other than 1 it shows the
  route's total cost.
* New defaults: distance uncertainty up to 5 % (named stars stay), brown dwarfs shown, jump lines
  at 50 % opacity.
* Filter: "Systems" with only single stars, only multiple systems, or both.
* The example factions are removed (the site's attribute dataset): factions are being redesigned.

## 1.17 (2026-11-16)

* "Always show named stars" (Stars, under the distance uncertainty; on by default): with the
  uncertainty set to 1 %, Betelgeuse, Rigel, Deneb and the other named stars stay on the map.
* Route costs: a new slider under the jump network sets how a jump's length counts when routes are
  compared: linear (as before), polynomial (with an exponent) or exponential (with a factor). The
  dearer long jumps are, the more short jumps a route takes: from the Sun to Vega 7 jumps
  linear, 9 polynomial (exponent 3), 11 exponential (factor 6). The distances shown stay the real
  ones.

## 1.16 (2026-11-16)

* Multiple systems cleaned up: a double-star catalogue pair counts as a system only if the proper
  motions allow an orbit, not only the distances (with a very uncertain distance, almost any
  distance agreed). "Aldebaran C", a background star 2.7 times as far away, is no longer a member
  of the Aldebaran system. Every member is also checked against its system's best-measured star,
  so that chains of links no longer join stars that do not belong together.
* Double stars beyond 100 pc are recognised from the catalogue too: Beta¹ and Beta² Scorpii
  (Acrab and Acrab B) form one system now.

## 1.15 (2026-11-15)

* Zooming out is smooth again: since 1.13 most stars vanished for a moment and came back, because
  the parts of the view still loading counted as incomplete for the whole view. Nodes on their way
  no longer count.
* Filter list: the buttons (CSV export, remove marks) are above the list; with an attribute among
  the criteria (distance uncertainty, say) every star shows its value; the list sorts by distance,
  name, spectral class, planets or the attribute, ascending or descending, and the CSV export
  follows the order shown and includes the attribute.

## 1.14 (2026-11-15)

* Filter: a new tab in the settings lists the stars around the Sun or the view centre that meet
  criteria (spectral classes, brown and white dwarfs, known or potentially habitable planets, names,
  multiple systems, any attribute by value or range), nearest first. "All M dwarfs with planets
  within 30 ly" gives 43 stars. The stars found get a gold rim on the map (also where the view's
  detail would leave them out), the others can be dimmed; a tap on a row flies to the star; the
  list can be exported as CSV.
* Prepared for Gaia DR4 (due on 2 December 2026): one setting takes the stars beyond 200 pc from
  DR4 instead of DR3, with DR4's parallax bias, its epoch J2017.5 and the DR3 designations of the
  same stars (the archive's DR3 neighbourhood table), so that names, SIMBAD links, planets and
  your attributes stay with their stars. A check tells when the archive has the release. About 7
  million instead of 4.4 million stars with parallaxes better than 1 % are expected
  (docs/GAIA_DR4.md).

## 1.13 (2026-11-15)

* No more square structures in large views at low detail: only the stars bright enough to be
  loaded everywhere in view are drawn, so the density is even (the parts of the view are loaded in
  the order that brings this limit down furthest).
* Many stars in view no longer merge into one white blob: the stars' light is added up in a
  half-float buffer and compressed softly, faint stars are dimmed more in crowded views, and an
  exposure meter darkens the picture when large parts of it would be overexposed.

## 1.12 (2026-11-11)

* 3.6 million more stars: every Gaia DR3 star beyond 200 pc whose parallax is better than 1 %
  (4.4 million, the others were on the map already), half of them within 1,400 ly, nine in ten
  within 2,200 ly, the farthest at 4,100 ly. The map holds 7.9 million stars now; zoomed out to a
  few thousand light years the disk of the Milky Way around the Sun shows. These stars are named by
  their Gaia DR3 number; the star data grew from 203 to 331 MB (loaded only where you look).

## 1.11 (2026-11-10)

* Zoomed in to a moon (Naiad, say), its planet and the moons no longer vanish once the planet lies
  outside the visible sphere: a planet or moon is drawn while its surface lies within about the
  screen's height of the view centre.
* A tap on a galaxy picks that galaxy also far out with another galaxy at the view centre (the
  sizes on screen were computed with a scaled depth, so that every galaxy seemed to cover the
  screen); the galaxy under the finger wins, else the nearest. Star picking close up (a star drawn
  at its true size) had the same fault.

## 1.10 (2026-11-10)

* Galaxies from NED-D, the NASA/IPAC Extragalactic Database's list of redshift-independent
  distances: 158,881 galaxies instead of 56,521, out to 3 billion light years (102,350 more, among
  them 1,234 NGC and 429 IC galaxies and 7 Messier objects that had no distance on the map so far).
  Positions and PGC numbers come from HyperLEDA. Cosmicflows-4 stays the reference for its
  galaxies; NED-D replaces a distance only with a better method (supernovae or Cepheids for a
  Tully-Fisher distance, say). The galaxy card names NED-D among its sources.

## 1.09 (2026-11-10)

* Planets keep the size of their symbol while zooming in until their true size is larger (Jupiter
  no longer jumps to a small disc when its moons appear); the moons appear only once their orbits
  lie well outside the planet's symbol, and their orbits are fainter.
* *Monde mit unbekanntem Radius anzeigen* (settings, *Space*, off by default): the many small
  outer moons of Jupiter and Saturn only on request (41 of the 456 moons have a known radius).
* Large stars close up (Betelgeuse) no longer turn half transparent or vanish when the view centre
  moves off their middle: they stay while any part of them is in the visible sphere.
* *Zentrieren* on a planet's or moon's card centres the view on it and follows it (it used to fly
  to its star).
* A route begun with *Ziel*: every double tap chooses a new start; begun with *Start*: a new
  destination.
* The *Sprünge* tab is no longer empty: zoomed out with a route shown, the stars near the route
  list their links from the route's corridor; otherwise it says why there are none, with a button
  to zoom in (or to switch the jump network on).

## 1.08 (2026-11-10)

* Close to a planet, it stays on its orbit line: the line was a polygon whose corners lay up to
  17,000 km off the ellipse (Mars); now it runs exactly through the planet (and each moon).
* Close to a far star (Barnard's Star, say), the star is no longer drawn twice and its label no
  longer jumps: discs, labels, picking and the jump lines use the star's exact position, not one
  rounded by up to a millionth of a light year.
* With only a destination set, a double tap on a star makes it the start.
* The star card's buttons have short labels (*Zentrieren*, *Planeten*, *Start*, *Ziel*, *SIMBAD*)
  and fit in one row; the long text shows as a tooltip.

## 1.07 (2026-11-09)

* Moons: the Solar System's 456 known moons (JPL), on their orbits around their planets, down to
  19,000 km (Phobos); in the search, with a card each. The view follows the planet it is centred on.
* The star card has tabs: *Kurz* (distance, change of distance, luminosity: a small card),
  *Position* (with speed and change of distance to the Sun, km/s), *Stern*, *Attribute*, *Sprünge*;
  the last one chosen stays.
* A route is planned again when the date changes and the stars have moved.
* With a route started, a double tap on a star makes it the destination.
* The clock's speed in short ("10.000 Jahre/s"): the slider keeps its size.
* Spacecraft far out: their distance in light years, the signal time in days or years.

## 1.06 (2026-11-09)

* The stars move: from their measured velocities (proper motion, distance and, for most stars
  within 650 ly, the radial velocity), in straight lines, up to two million years into the past or
  future. The clock is on the map whenever stars are, with speeds up to 100,000 years per second;
  a tap on the date lets you type a year. The view follows the star it is centred on (planetary
  systems move with their star), and the star card's distance follows too.
* Galaxies whose catalogue names no distance method show the paper the distance comes from (the
  Large Magellanic Cloud: Pietrzynski 2019), with a link.
* The *Known planets* legend: the Sun first, short texts.
* *Luminosity* and *Absolute magnitude* without the explanations in brackets (no line break on
  phones).

## 1.05 (2026-11-09)

* Shared links carry the date the planets are drawn for (and the clock's speed).
* The Sun has a height line to the grid, like the other stars.
* *Earth* and *Sun* (View tab) are fixed views: the Sun in the centre, straight down onto the
  ecliptic, the Galactic Centre to the left; *Earth* shows the inner Solar System (2 AU).
* The Milky Way's name is yellow, like the Sun's.
* Stars with planets: instead of coloured names, an optional thin rim right around the star
  (blue, green with a potentially habitable planet); the labels stay as they are.
* Colour by *Known planets*: blue, green, the Sun yellow, no colour scale; a tap prefers the
  coloured (and rimmed) stars over the grey ones nearby.
* *Distance from the Sun* left out of the layer menus; *Luminosity (all wavelengths)* and
  *Absolute magnitude (visible light)* say how they differ.
* Close up, stars are drawn at their true size once that is larger than their symbol.
* The explanation of the habitable zone moved into the help.

## 1.04 (2026-11-07)

* Fixed: close to planets (below about a hundred million kilometres) some phone graphics chips drew
  the planets, orbits and grid in place while their labels moved on. The picture now reaches the
  graphics chip in units of the camera distance, which those chips handle.
* The clock of the planets and spacecraft: its date is shown on the map (and on the planet and
  spacecraft cards, which now follow it); real time runs one second per second from any date;
  *Now* goes back to the present date (the speed stays), and a calendar button sets any date.
* Stars with potentially habitable planets: their names in green instead of the rings, only for
  stars that are on the map anyway; optionally the names of all stars with planets in blue.
* The habitable zone stands out more: lines along its edges, its outer band brighter.
* View tab: *Earth* (2 AU around it), *Sun* (10 light years) and *Galaxy* (the Milky Way from above)
  instead of *Back to the Sun*.
* Phones: the clock and the route box move above the planet, spacecraft and galaxy cards too.

## 1.03 (2026-11-07)

* Habitable zones: around every planet host whose temperature and luminosity are known, a green
  band (Kopparapu et al. 2013); the planet card says where a planet's orbit lies relative to it and
  tags potentially habitable planets (79); a switch marks their stars on the map.
* Spacecraft: Voyager 1 and 2, Pioneer 10 and 11 and New Horizons on their real trajectories (JPL
  Horizons), with a card each, in the search and in shared links.
* The level of detail is a slider like the other settings.

## 1.02 (2026-11-07)

* The search field says what it finds: stars, planets and galaxies (shorter on narrow screens).
* The last five searches instead of three.
* Stars four times larger by default.
* Settings: a new tab *Info* with the version, the controls, *About & sources*, the language and
  the reset; the data layers and the jump network together under *Layers*; the level of detail
  under *Stars*.
* About & sources: the text as whole sentences; star colours and sizes follow temperature and
  luminosity by default, and can follow other properties.

## 1.01 (2026-11-07)

* Shared links: the address holds the view, the selected star, planet or galaxy and the route;
  the new share button at the top sends or copies it. Opening a link restores all of it, also
  after a data update.
* The settings in five tabs: View, Stars, Space, Data, Jumps.
* Planet motion: one month per second by default, a slider from real time to ten years per
  second, and the same slider on the map when zoomed into a planetary system.
* About & sources: a longer text on the map being a map (sizes, colours and the Milky Way
  abstracted, assumed orbit values marked), and the sources of the planets and galaxies.

## 1.00 (2026-11-07)

The first public version, online at https://nathansyntronics.github.io/Galactic-Map/ since
2026-11-02:

* 4,266,557 stars from Gaia DR3, Hipparcos, the 20 pc census and AT-HYG out to about 650 light
  years, 101,846 of them named; systems and close pairs separated by their orbits.
* Data layers (colour and size by attribute, CSV import and export, factions), the jump network
  and route planning with a flyby along the route.
* All 6,428 confirmed planets with known host distance on their orbits, down to a zoom of a
  hundredth of an AU (distances below 1 AU in millions of kilometres).
* The Milky Way as a model and 55,877 galaxies out to about 1.5 billion light years.
* Search for stars, planets and galaxies; English and German.
* The version, shown at the bottom of the settings panel and in *About & sources*.
