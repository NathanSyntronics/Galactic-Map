# Planets

The map shows the confirmed planets of the NASA Exoplanet Archive, 6,428 around 4,818 stars (all but
the 23 planets of the 21 hosts whose distance is unknown), and the eight planets of the Solar System, each on its orbit at its position for a date (now, or running
faster). Zoomed into a star, the orbits appear as ellipses and the planets as symbols; like the
stars and the galaxies, the symbols are larger than the planets are. This document is the
specification the implementation follows.

## Data (`pipeline/galmap/planets.py`)

    cd pipeline && python -m galmap.planets --data ../public/data

The step runs after the star build (`galmap.build`, which also counts the planets per star): it
reads the built stars and writes `planets.json` next to them.

### Sources

* **NASA Exoplanet Archive**, Planetary Systems Composite Parameters (`pscomppars`, one row per
  confirmed planet): period, semi-major axis, eccentricity, inclination, argument of periastron,
  time of periastron, transit midtime, radius, mass, equilibrium temperature, the host's mass,
  discovery method and year. Cached in `pipeline/cache/exoplanets/planets.csv`.
* **The Solar System:** Keplerian elements at J2000 relative to the ecliptic (E. M. Standish,
  *Keplerian Elements for Approximate Positions of the Major Planets*, JPL, table 1), sidereal
  periods, equatorial radii and masses.

### Hosts

The star build (`galmap.build`) matches the archive's hosts to the stars of the catalogues (Gaia
DR3, HIP, HD, else the position within 3″ and the distance within 20 %) and counts their planets.
**Hosts that no catalogue has** (about 2,670: Kepler, K2, TESS and CoRoT stars, the hosts of
microlensing planets up to 21,500 ly away, ...) are added as stars (`galmap/hosts.py`): at the
archive's position and distance, with its V and G magnitudes, temperature and spectral type,
flagged `SRC_EXOPLANET` (bit 14) and named by their archive name ("TOI-700", "OGLE-2005-BLG-390L")
unless the naming finds a better one ("Kepler-90" for KOI-351). The distances of microlensing hosts
come from models of the event: they are flagged as distances without a parallax. A host that has a
star of the map within 3″ plus 20 years of its proper motion is that star (LHS 1678, whose
catalogue position is of another epoch), unless that star hosts other planets already (then it is
a companion with planets of its own and is added). The added hosts do not take part in the
wide-binary heuristic (thousands of Kepler stars far behind would make the nearer stars of their
field look crowded).

The build writes each host's archive name into its node (field `h`, docs/DATA_FORMAT.md);
`galmap.planets` links the planets by it, exactly. (Without it: by designation, by name, else the
nearest host within 0.5° whose distance agrees within 30 %.) Each host is written with its node path
and index and its position exactly as the node stores it (float32), so the app draws a system
exactly on its star.

### Orbits

Every orbit is written as two unit vectors in the heliocentric galactic frame of the stars, **P**
towards the periapsis and **Q** 90° ahead in the orbital plane, with the semi-major axis a (AU), the
eccentricity e, the period (days) and the mean anomaly M0 at J2000. A planet's position relative to
its star at a date is a (cos E − e) P + a √(1 − e²) sin E Q, where E solves Kepler's equation for
M = M0 + 2π (t − J2000) / period.

* **Exoplanets** are given in the sky frame of their star (north, east, away from us; Heintz): the
  inclination i of the orbit to the sky plane, the longitude of the ascending node Ω and the star's
  argument of periastron ω (radial-velocity convention; the planet's is ω + 180°). A body at
  u = ω + f lies north cos Ω cos u − sin Ω sin u cos i, east sin Ω cos u + cos Ω sin u cos i, away
  sin u sin i.
* **What is not measured is chosen, and marked** (flags in the file, a note on the planet's card):
  * Ω (how the orbit is turned about the line of sight) is known for almost no planet: a fixed
    pseudo-random angle per system (all its planets share it).
  * an unknown inclination: the median of the system's measured ones (a flat system), else a fixed
    pseudo-random one per system, isotropic (cos i uniform).
  * an unknown eccentricity: 0 (circular); an unknown ω: 90°.
  * the phase: from the time of periastron, else from the transit midtime (the planet then lies
    in front of its star: true anomaly 90° − ω), else a fixed pseudo-random one.
  * a missing semi-major axis or period: from the other by Kepler's third law with the star's mass
    (1 M☉ if unknown).
  * a missing radius: from the mass (Chen & Kipping 2017: R ∝ M^0.279 below 2.04 M⊕, ∝ M^0.589 up to
    132 M⊕, ∝ M^−0.044 above).
* **The Solar System:** P and Q from i, Ω and ω = ϖ − Ω relative to the ecliptic, turned to the
  equator (obliquity 23.43928°) and to the galactic frame; M0 = L − ϖ.

### File

`planets.json`: `epoch` (J2000), `methods`, `fields`, `flags` (1 radius estimated, 2 inclination
assumed, 4 phase assumed, 8 eccentricity assumed, 16 Solar System, 32 circumbinary, 64 in the
habitable zone, 128 in its narrower limits, 256 potentially habitable), `hosts`
(`[node path, index, archive name, [x, y, z] galactic ly, number of planets, habitable zone or
null, [vX, vY, vZ] as the star tile stores them (km/s × 50) or null]`: the systems move with their
stars, docs/DATA_FORMAT.md) and `planets`
(`[host, name, German name, a, e, period, M0, P, Q, radius R⊕, mass M⊕, Teq K, method, year,
flags, inclination]`), `sources`, `stats`.

### Habitable zones

Each host's habitable zone after Kopparapu et al. 2013 (ApJ 765, 131, with the erratum ApJ 770, 82;
one Earth mass): the stellar flux S_eff = S0 + a t + b t² + c t³ + d t⁴ (t = Teff − 5780 K, Teff
clamped to 2,600–7,200 K) at which a planet crosses each limit lies at √(L / S_eff) AU. Four edges
are written: recent Venus and early Mars (the wider, optimistic limits), runaway and maximum
greenhouse (the narrower, conservative ones); for the Sun 0.75, 0.98, 1.69 and 1.77 AU. Teff and L
come from the archive (L from the radius and Teff where it gives no luminosity); for 302 hosts one
of them is unknown and no zone is drawn.

A planet is *in the zone* when its semi-major axis lies within the wider limits, *potentially
habitable* when it is moreover at most 2.5 Earth radii (without a measured radius: at most 10 Earth
masses). 297 planets lie in a zone, 79 are potentially habitable (Proxima Cen b, TRAPPIST-1 d to
g, TOI-700 d, LHS 1140 b, Teegarden's Star b, ...). The Solar System's planets get the zone flags
(Earth and Mars lie in it) but not the tag.

In the app the zone is drawn as two green bands in the plane of the planet nearest to it (the
wider limits fainter, with a line along their inner and outer edge), fading in with its size on
screen (*Show habitable zones*, settings, *Space*). The planet card says where the orbit lies
(inside, at the edge, too hot, too cold) with the narrower limits, and tags potentially habitable
planets. *Rim around stars with planets* (settings, *Space*) draws a thin ring just outside each
planet host's star symbol, whatever its size on screen: blue, green with a potentially habitable
planet (not the Sun). It is part of the star shader (a per-star mark from the star tiles' planet
counts and the planet catalogue's potentially habitable hosts), so it changes no label and adds
no star. The data layer *Known planets* colours the same way (blue, green, the Sun yellow, the
others grey); a tap prefers the rimmed and coloured stars over the others nearby.

### Moons (`pipeline/galmap/moons.py`)

No exomoon is confirmed (Kepler-1625 b I and Kepler-1708 b I are disputed candidates). The Solar
System's planets have 456 known moons (Earth 1, Mars 2, Jupiter 115, Saturn 292, Uranus 30, Neptune
16; Pluto's 5 are left out with Pluto): JPL's planetary satellite mean elements
(ssd.jpl.nasa.gov/sats/elem) give a, e, ω, M, i and the node at an epoch, relative to the ecliptic,
the planet's equator (its IAU pole) or the moon's local Laplace plane (its pole given); the node is
counted from that plane's ascending node on the ICRF equator. They become P and Q (galactic) and a
mean anomaly at J2000 like the planets' (no apsidal or nodal precession). Mean radii from JPL's
physical parameters (41 of the moons on the map); the others a few km (flag 1, radius estimated).

In `planets.json` a moon is a row of `planets` with flag 512 and its planet's index as a 17th field
(`parent`); its orbit is around that planet. The app draws a planet's moons in a group at the
planet, fading in with their orbits' size on screen and once their periapsis lies 1.5 to 3 times
outside the planet's symbol (its share of the view: zoomed out they do not cover it); orbits far
larger than the view, the outer irregular moons, are left out. Moon orbits are fainter than the
planets' (30 % instead of 45 %). The planet's symbol keeps its share of the view until its true
size is larger, like the stars. The moons of unknown radius (415 of 456: most of Jupiter's and
Saturn's small outer moons) are drawn only with *Show moons of unknown radius* (settings, *Space*,
off by default), or the one selected. Labels after the planets (the larger moons first), the card says
"Moon of Jupiter", the radius in km and the semi-major axis in km; the search finds them ("Titan",
"Mond").

### Close pairs (`pipeline/galmap/binaries.py`, in the star build)

The 20 pc census lists the components of some systems at one common position (Alpha Centauri A and
B at the system's, from Akeson et al. 2021): about 800 stars in 390 groups share a position, so no
zoom could separate them. Where the Sixth Catalog of Orbits of Visual Binary Stars (ORB6, USNO /
Georgia State University; about 3,950 orbits) has the orbit of such a pair, found by the HIP or HD
number of one of its stars and the component letters ("AB", "Aa,Ab", "BC"), the secondary is placed
where the orbit puts it relative to the primary at the map's epoch J2016.0: on the sky from the
visual orbit (P, T, e, a, i, Ω, ω; Thiele-Innes), along the line of sight from its inclination
(the sign of that offset is not known from a visual orbit), scaled by the primary's distance. The
primary stays. Pairs without an orbit stay together. Alpha Centauri B: 4.0″ at position angle 302°
from A in 2016 (ORB6, Akeson 2021).

## App

### Zoom

* The visible radius reaches down to 2e-9 ly (19,000 km: Phobos' orbit), the camera to 4.4e-9 ly.
  A system is drawn while its star or one of its planets is in the visible sphere (close up to a
  planet and its moons the star is far outside). The view follows the star, planet or moon it is
  centred on (or flies to) as the clock runs. Distances below
  0.05 ly (3,162 AU) are written in AU (AE in German), below 1 AU in millions of kilometres
  ("57.9 million km", "1,72 Mio. km"), below a million kilometres in kilometres.
* Below a visible radius of 2 ly the star symbols shrink a little faster than the view
  (radius^1.15, `starCloseScale`): close pairs separate (Alpha Centauri A and B, 28 AU apart on the
  map) and planetary orbits stay visible around their star.
* The camera's near plane follows the distance (1e-4 of it); a system's objects sit in a group at
  its star's position, so three.js combines their matrices with the camera's in double precision
  and orbits of a hundredth of an AU stay sharp anywhere.

### Drawing (`src/render/planets.ts`)

* The planet file (0.6 MB) is loaded the first time the visible radius falls below 2 ly, or with
  the search index.
* Systems whose star lies in the visible sphere and whose largest orbit is at least 2 px on screen
  are drawn (the 16 nearest to the camera): each orbit as an ellipse in the planet's colour, fading
  in from 3 to 14 px, each planet as a shaded disk at its position, fading in from 2 to 8 px.
* **Orbit lines** are polygons of 256 points. With even steps their corners would lie up to
  a/40,000 off the ellipse (17,000 km for Mars), and close up the planet would drift off its line
  and back. The first point lies exactly at the planet and the others crowd around it (eccentric
  anomaly E₀ + u − 0.95 sin u for even steps of u: twenty times denser at the planet); the line is
  drawn again around the planet once it would be half a pixel off (close up, every frame while the
  clock runs fast). The same for the moons.
* **Symbols:** a planet is drawn with a radius of 1.4 % of the visible radius times its radius in
  Earth radii^0.33 (Jupiter 3.1 %), at least its true size, at most a third of its periapsis.
* **Colours:** the Solar System's planets their own; the others by kind (rocky below 1.6 R⊕, mini-
  Neptune below 4, ice giant below 8, gas giant), hot ones (Teq above 1,300 K) red-orange.
* **Time:** the planets and the spacecraft are drawn for the date of a clock that starts at now
  when the map opens and runs at the speed of *Planet motion* (settings, *Space*): a slider with the
  stops real time (one second per second, from whatever date the clock shows), an hour, a day, a
  week, a month (the default) and a year and ten years per second; a new speed runs on from the
  date reached. The clock appears on the map (on top of the bottom-left stack; on a phone with a
  card open, at the top) while planets or spacecraft can be made out: when a planet's orbit is at
  least 16 px on screen and its symbol has faded in (it goes again below 10 px), or a spacecraft is
  drawn. It shows the date drawn (with the time of day at real time and an hour per second), *Now*
  (back to the present, the speed stays; hidden while the clock is within half a minute of now), a
  calendar button that opens the device's date picker (years 1000 to 3000, at the present time of
  day) and the speed slider.

### Labels, picking, card, search

* Planets whose orbit is at least 16 px on screen are labelled (with their German name in the
  Solar System); their labels follow them.
* A click picks a planet (its label or its symbol, within 8 px, 14 px by touch) before a star.
  A double click centres the view on it.
* The planet card: name, star, kind, semi-major axis (below 1 AU also in kilometres), eccentricity, period, radius (marked when
  estimated), mass, equilibrium temperature, inclination (when measured), discovery (method,
  year), what the map chose, the date drawn (it follows the clock); *Centre* (centres the view
  on the planet or moon and follows it, like a double tap) and a link to the NASA Exoplanet
  Archive.
* The star card of a planet host (and of the Sun) has *Planets*: it flies to the star, close
  enough to show all orbits.
* The search knows every planet ("Proxima Cen b", "Erde"); picking one flies to its star close
  enough to show its orbit.
  Planets come after the stars and galaxies that match as well ("Trappist" lists the star
  TRAPPIST-1 before its planets), but an exact planet name before a star's longer name, and a
  star's planets right after it ("Kepler-90": the star, its planets, then Kepler-900, ...). A
  planet the archive names after another name of its star is also found by the map's name
  (KOI-351 b as "Kepler-90 b").
* The grid's rings are spaced in the unit their labels use (2, 4, 6 million km rather than
  0.0000002 ly).
