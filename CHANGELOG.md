# Changelog

Every round of changes that goes live raises the version by 0.01 (README, *Versions*).

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
