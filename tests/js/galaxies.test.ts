import { afterAll, describe, expect, it } from 'vitest';
import {
  GALAXY_RECORD_BYTES,
  GalaxyFlag,
  decodeGalaxies,
  galaxyDesignation,
  galaxyDistance,
  galaxyName,
  galaxyRank,
  loadGalaxies,
  type GalaxyMeta,
} from '../../src/data/galaxies';
import { formatLy, setLang } from '../../src/i18n';
import { galaxyBrightness, galaxyCrowdFactor, galaxyDensityFactor, galaxyScale, galaxySymbolFactor, milkyWayOpacity } from '../../src/render/galaxies';
import { scientific } from '../../src/ui/galaxy-card';

// setLang marks the page language
(globalThis as { document?: unknown }).document ??= { documentElement: {} };

interface Rec {
  x: number;
  y: number;
  z: number;
  diam: number;
  major: [number, number, number];
  normal: [number, number, number];
  q: number;
  cls: number;
  logL: number | null;
  derr: number | null;
  method: number;
  flags: number;
  pgc: number;
}

/** Records in the layout of docs/GALAXIES.md (as galmap.galaxies writes them). */
function records(recs: Rec[]): ArrayBuffer {
  const buf = new ArrayBuffer(recs.length * GALAXY_RECORD_BYTES);
  const v = new DataView(buf);
  recs.forEach((r, k) => {
    const o = k * GALAXY_RECORD_BYTES;
    [r.x, r.y, r.z, r.diam].forEach((x, j) => v.setFloat32(o + 4 * j, x, true));
    r.major.forEach((x, j) => v.setInt8(o + 16 + j, Math.round(x * 127)));
    r.normal.forEach((x, j) => v.setInt8(o + 19 + j, Math.round(x * 127)));
    v.setUint8(o + 22, Math.round(r.q * 255));
    v.setUint8(o + 23, r.cls);
    v.setInt16(o + 24, r.logL === null ? -32768 : Math.round(r.logL * 1000), true);
    v.setUint8(o + 26, r.derr === null ? 255 : Math.round(r.derr * 200));
    v.setUint8(o + 27, r.method);
    v.setUint8(o + 28, r.flags);
    v.setUint32(o + 32, r.pgc, true);
  });
  return buf;
}

const meta = (count: number): GalaxyMeta => ({
  format: 'galmap-galaxies',
  version: 1,
  count,
  recordBytes: GALAXY_RECORD_BYTES,
  data: 'galaxies.wasm',
  classes: ['spiral', 'lenticular', 'elliptical', 'irregular', 'spheroidal', 'milkyway'],
  methods: ['', 'TRGB', 'Cep'],
  names: [
    [0, 'Milky Way', 'Milchstraße', 0, 'Milky Way'],
    [1, 'Andromeda Galaxy', 'Andromedagalaxie', 0, 'PGC 2557', ['M 31', 'NGC 224']],
    [3, 'Fornax', null, 4, 'Fornax'],
  ],
  sources: [],
});

const RECS: Rec[] = [
  { x: 26673, y: -26.07, z: -21.41, diam: 1e5, major: [1, 0, 0], normal: [0, 0, 1], q: 1, cls: 5, logL: 10.8, derr: 0.02, method: 0, flags: GalaxyFlag.MODEL | GalaxyFlag.LOCAL_GROUP, pgc: 0 },
  { x: -1.17e6, y: 1.94e6, z: -8.96e5, diam: 135008, major: [-0.76, -0.17, 0.63], normal: [-0.61, -0.17, -0.77], q: 0.47, cls: 0, logL: 10.73, derr: 0.0207, method: 1, flags: GalaxyFlag.CF4 | GalaxyFlag.NAMED, pgc: 2557 },
  { x: 1e8, y: 0, z: 0, diam: 3e4, major: [0, 1, 0], normal: [0, 0, 1], q: 0.8, cls: 2, logL: null, derr: null, method: 2, flags: GalaxyFlag.CF4, pgc: 12345 },
  { x: 0, y: 0, z: 4.6e5, diam: 2400, major: [1, 0, 0], normal: [0, 1, 0], q: 0.7, cls: 4, logL: 7.5, derr: 0.02, method: 0, flags: GalaxyFlag.LVDB, pgc: 0 },
];

describe('galaxy records', () => {
  const cat = decodeGalaxies(records(RECS), meta(RECS.length));

  it('converts galactic (x, y, z) to the world frame (x, z, -y)', () => {
    expect(cat.count).toBe(4);
    expect(cat.pos[3]).toBeCloseTo(-1.17e6, -1);
    expect(cat.pos[4]).toBeCloseTo(-8.96e5, -1);
    expect(cat.pos[5]).toBeCloseTo(-1.94e6, -1);
    // directions too, as unit vectors
    expect([cat.normal[3], cat.normal[4], cat.normal[5]].map((x) => Math.round(x * 100) / 100)).toEqual([-0.61, -0.77, 0.17]);
    expect(Math.hypot(cat.major[3], cat.major[4], cat.major[5])).toBeCloseTo(1, 6);
    expect(galaxyDistance(cat, 2)).toBeCloseTo(1e8, -2);
  });

  it('reads sizes, classes, luminosities and errors (unknown as NaN)', () => {
    expect(cat.diam[1]).toBeCloseTo(135008, -1);
    expect(cat.q[1]).toBeCloseTo(0.47, 2);
    expect(Array.from(cat.cls)).toEqual([5, 0, 2, 4]);
    expect(cat.logL[1]).toBeCloseTo(10.73, 3);
    expect(cat.logL[2]).toBeNaN();
    expect(cat.distErr[1]).toBeCloseTo(0.02, 2);
    expect(cat.distErr[2]).toBeNaN();
    expect(cat.methods[cat.method[2]]).toBe('Cep');
    expect(cat.flags[0] & GalaxyFlag.MODEL).toBeTruthy();
    expect(Array.from(cat.pgc)).toEqual([0, 2557, 12345, 0]);
  });

  it('names a galaxy in each language; without a name by its PGC number', () => {
    expect(galaxyName(cat, 1, 'de')).toBe('Andromedagalaxie');
    expect(galaxyName(cat, 1, 'en')).toBe('Andromeda Galaxy');
    expect(galaxyName(cat, 3, 'de')).toBe('Fornax');
    expect(galaxyName(cat, 2, 'de')).toBe('PGC 12345');
    expect(galaxyDesignation(cat, 1)).toBe('PGC 2557');
    expect(galaxyDesignation(cat, 2)).toBe('PGC 12345');
    expect(cat.names.get(1)?.alt).toEqual(['M 31', 'NGC 224']);
    expect([galaxyRank(cat, 1), galaxyRank(cat, 3), galaxyRank(cat, 2)]).toEqual([0, 4, 99]);
  });

  it('loads the records from the file galaxies.json names', async () => {
    const asked: string[] = [];
    const fake = (async (url: string) => {
      asked.push(url);
      if (url.endsWith('galaxies.json')) return new Response(JSON.stringify(meta(RECS.length)));
      if (url.endsWith('galaxies.wasm')) return new Response(records(RECS));
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const loaded = await loadGalaxies('data/', fake);
    expect(asked).toEqual(['data/galaxies.json', 'data/galaxies.wasm']);
    expect(loaded.count).toBe(4);
    await expect(loadGalaxies('none/', (async () => new Response('', { status: 404 })) as typeof fetch)).rejects.toThrow('404');
  });

  it('drops records the file is too short for', () => {
    const short = decodeGalaxies(records(RECS).slice(0, 2 * GALAXY_RECORD_BYTES), meta(RECS.length));
    expect(short.count).toBe(2);
    expect(short.names.has(3)).toBe(false);
  });
});

describe('galaxy scales', () => {
  afterAll(() => setLang('en'));

  it('writes millions and billions of light years', () => {
    setLang('en');
    expect(formatLy(2_435_712)).toBe('2.44 million ly');
    expect(formatLy(30_607_360)).toBe('30.6 million ly');
    expect(formatLy(1_234_000_000)).toBe('1.23 billion ly');
    expect(formatLy(161_743)).toBe('161,743 ly');
    setLang('de');
    expect(formatLy(2_435_712)).toBe('2,44 Mio. Lj');
    expect(formatLy(250_000_000)).toBe('250 Mio. Lj');
    expect(formatLy(1_234_000_000)).toBe('1,23 Mrd. Lj');
  });

  it('writes luminosities as powers of ten', () => {
    setLang('en');
    expect(scientific(5.37e10)).toBe('5.4 × 10¹⁰');
    expect(scientific(3.5e7)).toBe('3.5 × 10⁷');
    expect(scientific(250)).toBe('250');
    expect(scientific(NaN)).toBe('–');
  });

  it('fades the Milky Way model in from 4,000 to 30,000 ly and brightens galaxies with luminosity', () => {
    expect(milkyWayOpacity(3000)).toBe(0);
    expect(milkyWayOpacity(30000)).toBe(1);
    expect(milkyWayOpacity(17000)).toBeGreaterThan(0.4);
    expect(galaxyBrightness(11.5)).toBe(1);
    expect(galaxyBrightness(3)).toBe(0.35);
    expect(galaxyBrightness(7.5)).toBeCloseTo(0.5, 6);
    expect(galaxyBrightness(NaN)).toBeGreaterThan(0);
  });

  it('draws galaxies as symbols larger than they are at large scales, the luminous ones larger', () => {
    // a fraction of the visible radius: 9 % for the Milky Way and Andromeda, less for dwarfs
    expect(galaxySymbolFactor(10.8)).toBeCloseTo(0.09, 2);
    expect(galaxySymbolFactor(10.8)).toBeGreaterThan(galaxySymbolFactor(9.4));
    expect(galaxySymbolFactor(5)).toBeLessThan(0.01);
    expect(galaxySymbolFactor(NaN)).toBe(galaxySymbolFactor(8));
    // Andromeda (radius 67,500 ly) in a view of 2 million ly: about 2.6 times its size
    const k = galaxyScale(67_500, galaxySymbolFactor(10.73), 2_000_000 * galaxyDensityFactor(80));
    expect(k).toBeGreaterThan(2.3);
    expect(k).toBeLessThan(3);
    // close up: its true size
    expect(galaxyScale(67_500, galaxySymbolFactor(10.73), 100_000)).toBe(1);
    // thousands of galaxies in view: the symbols shrink
    expect(galaxyDensityFactor(50)).toBe(1);
    expect(galaxyDensityFactor(300)).toBe(1);
    expect(galaxyDensityFactor(4800)).toBeCloseTo(0.125, 6);
    expect(galaxyDensityFactor(56_000)).toBeCloseTo(0.0197, 3);
    expect(galaxyDensityFactor(1e6)).toBe(0.01);
    // and the small glows dim
    expect(galaxyCrowdFactor(800)).toBe(1);
    expect(galaxyCrowdFactor(10_000)).toBeCloseTo(0.5, 6);
    expect(galaxyCrowdFactor(56_000)).toBe(0.22);
  });
});
