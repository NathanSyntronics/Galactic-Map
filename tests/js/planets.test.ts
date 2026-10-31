import { afterAll, describe, expect, it } from 'vitest';
import {
  AU_PER_LY,
  EARTH_RADIUS_LY,
  J2000,
  PlanetFlag,
  decodePlanets,
  eccentricAnomaly,
  julianDate,
  planetKind,
  planetName,
  planetOffset,
  type PlanetFile,
} from '../../src/data/planets';
import { distanceUnit, distanceUnitScale, formatLy, setLang } from '../../src/i18n';
import { planetDrawRadius, planetSymbolFactor } from '../../src/render/planets';

(globalThis as { document?: unknown }).document ??= { documentElement: {} };

const FILE: PlanetFile = {
  format: 'galmap-planets',
  version: 1,
  epoch: J2000,
  methods: ['Transit', 'Radial Velocity', 'Solar System'],
  hosts: [
    ['r', 0, 'Sun', [0, 0, 0], 1],
    ['r5', 12, 'Proxima Cen', [2.944215, -3.056768, -0.142107], 1],
  ],
  planets: [
    // a circular orbit in the galactic x-y plane, 1 AU, a year, at periapsis at J2000
    [0, 'Earth', 'Erde', 1, 0, 365.25, 0, [1, 0, 0], [0, 1, 0], 1, 1, null, 2, null, PlanetFlag.SOLAR_SYSTEM, 0],
    [1, 'Proxima Cen b', null, 0.0485, 0.3, 11.19, 1, [0, 0, 1], [1, 0, 0], null, 1.07, 234, 1, 2016, PlanetFlag.RADIUS_ESTIMATED, null],
  ],
  sources: [],
};

describe('planets', () => {
  const cat = decodePlanets(FILE);
  afterAll(() => setLang('en'));

  it('decodes hosts and planets into the world frame', () => {
    expect(cat.hosts[1].key).toBe('r5:12');
    expect(cat.byStar.get('r5:12')).toBe(1);
    // galactic (x, y, z) -> world (x, z, -y), as float32 like the stars
    expect(cat.hosts[1].pos.toArray()).toEqual([Math.fround(2.944215), Math.fround(-0.142107), Math.fround(3.056768)]);
    expect(cat.planets[0].Q.toArray()).toEqual([0, 0, -1]);
    expect(cat.hosts[1].planets).toEqual([1]);
    expect(cat.hosts[1].reach).toBeCloseTo((0.0485 * 1.3) / AU_PER_LY, 12);
    expect(cat.planets[1].radius).toBeNaN();
    expect(cat.planets[1].method).toBe('Radial Velocity');
  });

  it("solves Kepler's equation", () => {
    for (const e of [0, 0.3, 0.95]) {
      for (const m of [0.2, 2, 5, -1, 40]) {
        const E = eccentricAnomaly(m, e);
        const mm = ((m % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        expect(E - e * Math.sin(E)).toBeCloseTo(mm, 10);
      }
    }
  });

  it('moves a planet along its orbit', () => {
    const earth = cat.planets[0];
    const at = (days: number) => planetOffset(earth, J2000 + days).multiplyScalar(AU_PER_LY);
    expect(at(0).x).toBeCloseTo(1, 9);
    // a quarter of the year later: 90 degrees on, towards Q
    const q = at(365.25 / 4);
    expect(q.x).toBeCloseTo(0, 9);
    expect(q.z).toBeCloseTo(-1, 9);
    // an eccentric orbit: periapsis a (1 - e), apoapsis a (1 + e)
    const b = cat.planets[1];
    const d = (m: number) => planetOffset(b, J2000 + ((m - b.m0) / (2 * Math.PI)) * b.period).length() * AU_PER_LY;
    expect(d(0)).toBeCloseTo(0.0485 * 0.7, 9);
    expect(d(Math.PI)).toBeCloseTo(0.0485 * 1.3, 9);
    expect(julianDate(Date.UTC(2000, 0, 1, 12))).toBe(J2000);
  });

  it('names and sorts the planets', () => {
    expect(planetName(cat.planets[0], 'de')).toBe('Erde');
    expect(planetName(cat.planets[1], 'de')).toBe('Proxima Cen b');
    expect(planetKind(cat.planets[0])).toBe('rocky');
    expect(planetKind(cat.planets[1])).toBe('rocky'); // 1.07 Earth masses
  });

  it('draws planets as symbols: larger than they are, but within their orbits', () => {
    expect(planetSymbolFactor(11.2)).toBeGreaterThan(planetSymbolFactor(1));
    const earth = cat.planets[0];
    // close up: its true size
    expect(planetDrawRadius(earth, 1e-12)).toBeCloseTo(EARTH_RADIUS_LY, 20);
    // at the scale of its orbit: a symbol of 1.4 % of the view
    const view = 2 / AU_PER_LY;
    expect(planetDrawRadius(earth, view)).toBeCloseTo(view * 0.014, 15);
    // zoomed far out: no larger than a third of its orbit
    expect(planetDrawRadius(earth, 1)).toBeCloseTo(1 / AU_PER_LY / 3, 15);
  });

  it('writes distances within planetary systems in AU', () => {
    setLang('en');
    expect(formatLy(23.4 / AU_PER_LY)).toBe('23.4 AU');
    expect(formatLy(1 / AU_PER_LY)).toBe('1.00 AU');
    expect(formatLy(1500 / AU_PER_LY)).toBe('1,500 AU');
    expect(formatLy(4.24)).toBe('4.24 ly');
    expect(formatLy(0)).toBe('0.00 ly');
    setLang('de');
    expect(formatLy(23.4 / AU_PER_LY)).toBe('23,4 AE');
  });

  it('writes distances below 1 AU in millions of kilometres', () => {
    setLang('en');
    expect(formatLy(0.387 / AU_PER_LY)).toBe('57.9 million km');
    expect(formatLy(0.0485 / AU_PER_LY)).toBe('7.26 million km');
    expect(formatLy(0.9 / AU_PER_LY)).toBe('135 million km');
    expect(formatLy(1e-7)).toBe('946,000 km');
    expect(formatLy(2e6 / 9.4607304725808e12)).toBe('2 million km');
    setLang('de');
    expect(formatLy(0.0115 / AU_PER_LY)).toBe('1,72 Mio. km');
    expect(formatLy(1e-8)).toBe('94.600 km');
  });

  it('writes the rings of the grid in the unit of its radius', () => {
    setLang('en');
    // a radius of 2 AU: all rings in AU, also the one below 1 AU
    expect(formatLy(0.5 / AU_PER_LY, 2 / AU_PER_LY)).toBe('0.500 AU');
    expect(distanceUnit(2 / AU_PER_LY)).toBe('au');
    expect(distanceUnit(1e-6)).toBe('km');
    expect(distanceUnit(0.2)).toBe('ly');
    expect(distanceUnitScale(1e-6)).toBeCloseTo(9.4607304725808e12, 0);
  });
});
