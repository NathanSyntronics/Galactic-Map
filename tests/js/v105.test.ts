import { describe, expect, it } from 'vitest';
import { Flag, UNKNOWN_I16, type NodeData } from '../../src/data/format';
import { ECLIPTIC_NORTH, galacticLB } from '../../src/data/galactic';
import { linkParams, readLink } from '../../src/data/link';
import { SOLAR_RADIUS_LY, starRadiusLy } from '../../src/render/star-discs';
import { pickScore } from '../../src/controls/pick';

const params = (q: string) => new URLSearchParams(q.replace(/^[#&]/, ''));

describe('shared links with a date', () => {
  it('carries the planets date and speed', () => {
    const q = linkParams({ clock: { jd: 2468677.123456789, speed: 0 } });
    expect(q).toBe('&t=2468677.12346&ts=0');
    expect(readLink(params(q)).clock).toEqual({ jd: 2468677.12346, speed: 0 });
    expect(readLink(params('t=2461354.5')).clock).toEqual({ jd: 2461354.5 });
  });

  it('leaves out dates beyond the years 1000 to 3000 and bad speeds', () => {
    expect(readLink(params('t=99')).clock).toBeUndefined();
    expect(readLink(params('t=abc')).clock).toBeUndefined();
    expect(readLink(params('t=2461354.5&ts=-1')).clock).toEqual({ jd: 2461354.5 });
  });
});

describe('the ecliptic seen from above', () => {
  it('points to the north ecliptic pole (l 96.4°, b +29.8°)', () => {
    expect(ECLIPTIC_NORTH.length()).toBeCloseTo(1, 6);
    const { l, b } = galacticLB(ECLIPTIC_NORTH);
    expect(l).toBeCloseTo(96.38, 1);
    expect(b).toBeCloseTo(29.81, 1);
  });
});

describe('true star sizes', () => {
  const star = (logL: number, teff: number, flags = 0): NodeData =>
    ({ flags: new Uint16Array([flags]), logL: new Int16Array([logL]), absMag: new Int16Array([UNKNOWN_I16]), teff: new Uint16Array([teff]) }) as unknown as NodeData;

  it('from luminosity and temperature', () => {
    expect(starRadiusLy(star(0, 0, Flag.SUN), 0)).toBe(SOLAR_RADIUS_LY);
    expect(starRadiusLy(star(0, 5772), 0) / SOLAR_RADIUS_LY).toBeCloseTo(1, 3);
    // a red supergiant like Betelgeuse: several hundred solar radii
    const r = starRadiusLy(star(5000, 3600), 0) / SOLAR_RADIUS_LY;
    expect(r).toBeGreaterThan(600);
    expect(r).toBeLessThan(1000);
    expect(starRadiusLy(star(UNKNOWN_I16, 0, Flag.WHITE_DWARF), 0) / SOLAR_RADIUS_LY).toBeCloseTo(0.012, 4);
  });
});

describe('picking stars that stand out', () => {
  it('prefers a coloured star within the pick radius', () => {
    const grey = pickScore({ dist: 2, core: 2, named: true, logL: 2 }, 20)!;
    const coloured = pickScore({ dist: 15, core: 1, named: false, logL: -2, preferred: true }, 20)!;
    expect(coloured).toBeLessThan(grey);
    expect(pickScore({ dist: 25, core: 1, named: false, logL: 0, preferred: true }, 20)).toBeNull();
  });
});
