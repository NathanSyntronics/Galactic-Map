import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CRITERIA,
  MAX_FILTER_RADIUS,
  attrMatches,
  classKeyOf,
  hasCriteria,
  hitSet,
  readCriteria,
  scanStars,
  sortRows,
  sphereNodes,
  starMatcher,
  starsCsv,
  type FilterCriteria,
  type StarContext,
} from '../../src/data/filter';
import { DesigCat, Flag, UNKNOWN_I16, type NodeData } from '../../src/data/format';
import { Octree, type Manifest, type NodeRow, type SubManifest } from '../../src/data/octree';
import { FILTER_DIM, MARK_FILTER, computeStyle } from '../../src/render/starfield';
import { buildPlan } from '../../src/render/style';
import { AttributeStore } from '../../src/data/attributes';
import { DEFAULT_SETTINGS } from '../../src/settings';

/**
 * Six stars: an M dwarf with planets 3 ly away (named), a K star in a system 8 ly away, a white
 * dwarf, a brown dwarf (L), an A star 40 ly away, and one of unknown class.
 */
function node(): NodeData {
  const n = 6;
  const pos = new Float32Array([3, 0, 0, 0, 8, 0, 0, 0, 12, -5, 0, 0, 40, 0, 0, 0, -2, 0]);
  return {
    path: 'r0',
    count: n,
    positions: pos,
    absMag: new Int16Array(n).fill(UNKNOWN_I16),
    logL: new Int16Array([-2000, -500, -3000, -4000, 1200, UNKNOWN_I16]),
    teff: new Uint16Array([3100, 4500, 9000, 1800, 8500, 0]),
    flags: new Uint16Array([Flag.NAMED, Flag.IN_SYSTEM, Flag.WHITE_DWARF, 0, 0, 0]),
    distErr: new Uint8Array(n).fill(2),
    spec: new Uint8Array([65, 52, 255, 75, 21, 255]),
    desigCat: new Uint8Array([DesigCat.HIP, DesigCat.HIP, DesigCat.HIP, DesigCat.HIP, DesigCat.HIP, DesigCat.HIP]),
    desigId: new Uint32Array([1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0]),
    names: new Map([[0, { rank: 1, en: 'Red One', de: 'Roter Eins', alt: [] }]]),
    designations: new Map(),
    systems: new Map([[1, 9]]),
    systemInfo: new Map(),
    spectralTypes: new Map(),
    planets: new Map([[0, 2]]),
    base: pos,
    vel: null,
    vmax: 0,
    movedTo: 0,
  };
}

const crit = (patch: Partial<FilterCriteria>): FilterCriteria => ({ ...DEFAULT_CRITERIA, ...patch });
const noPlanets: StarContext = { planetClass: (d, i) => (d.planets.get(i) ? 'planets' : undefined) };
const pos = (d: NodeData, i: number, out: Vector3) => out.set(d.positions[3 * i], d.positions[3 * i + 1], d.positions[3 * i + 2]);

describe('filter criteria', () => {
  it('sorts stars into the filter classes', () => {
    const d = node();
    expect([0, 1, 2, 3, 4, 5].map((i) => classKeyOf(d, i))).toEqual(['M', 'K', 'WD', 'BD', 'A', undefined]);
  });

  it('matches classes, planets, names, systems', () => {
    const d = node();
    const all = (c: FilterCriteria, ctx = noPlanets) => [0, 1, 2, 3, 4, 5].filter((i) => starMatcher(c, ctx)(d, i));
    expect(all(crit({}))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(all(crit({ classes: ['M', 'K'] }))).toEqual([0, 1]);
    expect(all(crit({ classes: ['WD', 'BD'] }))).toEqual([2, 3]);
    expect(all(crit({ planets: 'planets' }))).toEqual([0]);
    // a potentially habitable one: the planet catalogue says which
    expect(all(crit({ planets: 'habitable' }))).toEqual([]);
    expect(all(crit({ planets: 'habitable' }), { planetClass: (_d, i) => (i === 0 ? 'habitable' : undefined) })).toEqual([0]);
    expect(all(crit({ named: true }))).toEqual([0]);
    expect(all(crit({ multiple: true }))).toEqual([1]);
    expect(all(crit({ classes: ['M'], planets: 'planets', named: true }))).toEqual([0]);
  });

  it('matches an attribute by text or range', () => {
    expect(attrMatches('Federation', { id: 'a', text: ' federation ' })).toBe(true);
    expect(attrMatches('Empire', { id: 'a', text: 'Federation' })).toBe(false);
    expect(attrMatches('Empire', { id: 'a' })).toBe(true); // any value
    expect(attrMatches(undefined, { id: 'a' })).toBe(false);
    expect(attrMatches(5, { id: 'a', min: 1, max: 5 })).toBe(true);
    expect(attrMatches(5.1, { id: 'a', min: 1, max: 5 })).toBe(false);
    expect(attrMatches(-3, { id: 'a', max: 0 })).toBe(true);
    const d = node();
    const value = (_d: NodeData, i: number) => [4000, 6000, undefined, 3000, 9000, undefined][i];
    const m = starMatcher(crit({ attr: { id: '@teff', min: 3500, max: 8000 } }), { ...noPlanets, value });
    expect([0, 1, 2, 3, 4, 5].filter((i) => m(d, i))).toEqual([0, 1]);
    expect(hasCriteria(crit({}))).toBe(false);
    expect(hasCriteria(crit({ multiple: true }))).toBe(true);
  });

  it('reads stored criteria defensively', () => {
    expect(readCriteria(null)).toEqual(DEFAULT_CRITERIA);
    expect(readCriteria({ radius: 1e9, classes: ['M', 'X', 'BD'], planets: 'many', centre: 'view', attr: { id: '@teff', min: 'x', max: 5 } })).toEqual({
      ...DEFAULT_CRITERIA,
      radius: MAX_FILTER_RADIUS,
      classes: ['M', 'BD'],
      centre: 'view',
      attr: { id: '@teff', max: 5 },
    });
  });
});

describe('filter search', () => {
  it('finds the stars within the radius, nearest first', () => {
    const d = node();
    const hits = scanStars([d], new Vector3(), 10, () => true, pos, new Vector3());
    expect(hits.map((h) => h.index)).toEqual([5, 0, 3, 1]);
    expect(hits[1].dist).toBeCloseTo(3, 6);
    // around another centre
    const near = scanStars([d], new Vector3(40, 0, 0), 1, () => true, pos, new Vector3());
    expect(near.map((h) => h.index)).toEqual([4]);
    expect(hitSet(hits).get('r0')).toEqual(new Set([5, 0, 3, 1]));
  });

  it('takes the sphere coarse to fine, nearest first, within a budget', async () => {
    const dir = new URL('./fixtures/sub/', import.meta.url);
    const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as T;
    const t = new Octree(read<Manifest>('manifest.json'));
    const centre = t.root.worldCenter.clone();
    // before the sub-manifests are loaded the sphere is not complete
    expect(sphereNodes(t.root, centre, t.root.halfSize, Infinity).complete).toBe(false);
    await t.expandWhere(() => true, async (file: string): Promise<NodeRow[]> => read<SubManifest>(file).nodes);
    const r = t.root.halfSize * 0.3;
    const all = sphereNodes(t.root, centre, r, Infinity);
    expect(all.complete).toBe(true);
    expect(all.nodes[0]).toBe(t.root);
    // every node that reaches into the sphere, and no other
    const want = [...t.nodes.values()].filter((n) => n.box.distanceToPoint(centre) <= r);
    expect(new Set(all.nodes)).toEqual(new Set(want));
    // coarse to fine
    for (let k = 1; k < all.nodes.length; k++) expect(all.nodes[k].level).toBeGreaterThanOrEqual(all.nodes[k - 1].level);
    // a budget keeps the coarser (more luminous) nodes
    const some = sphereNodes(t.root, centre, r, all.bytes / 2);
    expect(some.complete).toBe(false);
    expect(some.bytes).toBeLessThanOrEqual(all.bytes / 2);
    expect(all.nodes.slice(0, some.nodes.length)).toEqual(some.nodes);
  });

  it('writes the list as CSV with the designation as the key', () => {
    const rows = [{ designation: 'HIP 1', name: 'Red One', dist: 3.14159, spec: 'M5V', planets: 2 }, { designation: 'Gaia DR3 7', name: '', dist: 8, spec: null, planets: 0 }];
    const en = starsCsv(rows, ['designation', 'name', 'distance (ly)', 'spectral type', 'planets'], 'en');
    expect(en.replace('﻿', '').split('\r\n')).toEqual(['designation,name,distance (ly),spectral type,planets', 'HIP 1,Red One,3.142,M5V,2', 'Gaia DR3 7,,8.000,,', '']);
    const de = starsCsv(rows, ['Bezeichnung', 'Name', 'Entfernung (Lj)', 'Spektraltyp', 'Planeten'], 'de');
    expect(de.split('\r\n')[1]).toBe('HIP 1;Red One;3,142;M5V;2');
    // with the filter attribute's values
    const att = starsCsv(rows, ['Bezeichnung', 'Name', 'Entfernung (Lj)', 'Spektraltyp', 'Planeten'], 'de', { header: 'Entfernungsunsicherheit', value: (k) => ['12,5', ''][k] });
    expect(att.split('\r\n').slice(0, 3)).toEqual(['\ufeffBezeichnung;Name;Entfernung (Lj);Spektraltyp;Planeten;Entfernungsunsicherheit', 'HIP 1;Red One;3,142;M5V;2;12,5', 'Gaia DR3 7;;8,000;;;']);
  });

  it('sorts the list, rows without a value last', () => {
    const rows = [
      { name: 'Wolf 359', dist: 7.9, specCode: 66, planets: 0, valueKey: 0.5 },
      { name: 'alpha', dist: 4.3, specCode: 42, planets: 2 },
      { name: 'Barnard', dist: 6.0, specCode: 255, planets: 4, valueKey: 2 },
      { name: 'Wolf 1061', dist: 14, specCode: 63, planets: 3, valueKey: 0.5 },
    ];
    const names = (key: Parameters<typeof sortRows>[1], desc = false) => sortRows(rows, key, desc, 'en').map((r) => r.name);
    expect(names('dist')).toEqual(['alpha', 'Barnard', 'Wolf 359', 'Wolf 1061']);
    expect(names('dist', true)).toEqual(['Wolf 1061', 'Wolf 359', 'Barnard', 'alpha']);
    // ignoring case, numbers by value
    expect(names('name')).toEqual(['alpha', 'Barnard', 'Wolf 359', 'Wolf 1061']);
    // hot to cool; no class last, also descending
    expect(names('spec')).toEqual(['alpha', 'Wolf 1061', 'Wolf 359', 'Barnard']);
    expect(names('spec', true)).toEqual(['Wolf 359', 'Wolf 1061', 'alpha', 'Barnard']);
    expect(names('planets', true)).toEqual(['Barnard', 'Wolf 1061', 'alpha', 'Wolf 359']);
    // the attribute: ties by distance, no value last
    expect(names('value')).toEqual(['Wolf 359', 'Wolf 1061', 'Barnard', 'alpha']);
    expect(names('value', true)).toEqual(['Barnard', 'Wolf 359', 'Wolf 1061', 'alpha']);
    expect(sortRows([{ name: 'b', dist: 1, specCode: 0, planets: 0, valueKey: 'Empire' }, { name: 'a', dist: 2, specCode: 0, planets: 0, valueKey: 'Alliance' }], 'value', false).map((r) => r.name)).toEqual(['a', 'b']);
  });
});

describe('filter marks', () => {
  it('rims the stars found and dims the others', () => {
    const d = node();
    const s = { ...DEFAULT_SETTINGS, planetMarks: true };
    const plan = buildPlan(s, new AttributeStore());
    const colors = new Uint8Array(3 * d.count);
    const sizes = new Float32Array(d.count);
    const marks = new Uint8Array(d.count);
    computeStyle(d, s, plan, colors, sizes, marks);
    const plain = colors.slice();
    expect(marks[0]).toBe(1); // planets
    computeStyle(d, s, { ...plan, highlight: { has: (_n, i) => i === 1 || i === 0, dim: true } }, colors, sizes, marks);
    expect(marks[0]).toBe(MARK_FILTER);
    expect(marks[1]).toBe(MARK_FILTER);
    expect([...colors.slice(3, 6)]).toEqual([...plain.slice(3, 6)]);
    expect(colors[3 * 4]).toBe(Math.round(plain[3 * 4] * FILTER_DIM));
    // without dimming the others keep their colour
    computeStyle(d, s, { ...plan, highlight: { has: (_n, i) => i === 1, dim: false } }, colors, sizes, marks);
    expect([...colors]).toEqual([...plain]);
    expect(marks[0]).toBe(1);
  });
});
