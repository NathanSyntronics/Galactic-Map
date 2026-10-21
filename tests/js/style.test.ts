import { describe, expect, it } from 'vitest';
import { AttributeStore } from '../../src/data/attributes';
import { DesigCat, Flag, UNKNOWN_I16, type NodeData } from '../../src/data/format';
import { computeStyle, symbolRadius, starLogL } from '../../src/render/starfield';
import {
  MISSING_COLOR,
  MISSING_SIZE,
  buildPlan,
  categoryColors,
  hexToRgb,
  numericScale,
  scalePosition,
  sizeForPosition,
  valueGetter,
} from '../../src/render/style';
import { DEFAULT_SETTINGS, type Settings } from '../../src/settings';

/** Four stars: HR 1 (primary of system 5), HR 2 (member of system 5), HIP 3 (single, 2 planets), the Sun. */
function node(): NodeData {
  const n = 4;
  const desigCat = new Uint8Array([DesigCat.HR, DesigCat.HR, DesigCat.HIP, DesigCat.STRING]);
  const desigId = new Uint32Array([1, 0, 2, 0, 3, 0, 0, 0]);
  return {
    path: 'r',
    count: n,
    positions: new Float32Array([1, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0]),
    absMag: new Int16Array([100, 500, UNKNOWN_I16, 483]),
    logL: new Int16Array([1000, -500, UNKNOWN_I16, 0]),
    teff: new Uint16Array([9000, 4000, 0, 5772]),
    flags: new Uint16Array([Flag.IN_SYSTEM | Flag.SYSTEM_PRIMARY, Flag.IN_SYSTEM, 0, Flag.SUN]),
    distErr: new Uint8Array([2, 4, 255, 0]),
    spec: new Uint8Array([20, 50, 255, 42]),
    desigCat,
    desigId,
    names: new Map(),
    designations: new Map([[3, 'Sun']]),
    systems: new Map([
      [0, 5],
      [1, 5],
    ]),
    systemInfo: new Map([[5, { nameEn: 'Test', nameDe: null, members: 2, primary: 'HR 1' }]]),
    spectralTypes: new Map(),
    planets: new Map([[2, 2]]),
  };
}

const settings = (patch: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

function style(store: AttributeStore, patch: Partial<Settings>) {
  const d = node();
  const s = settings(patch);
  const colors = new Uint8Array(3 * d.count);
  const sizes = new Float32Array(d.count);
  computeStyle(d, s, buildPlan(s, store), colors, sizes);
  const rgb = (i: number) => [colors[3 * i], colors[3 * i + 1], colors[3 * i + 2]];
  return { d, colors, sizes, rgb };
}

describe('data layers', () => {
  it('keeps the natural look by default', () => {
    const store = new AttributeStore(false);
    const { d, sizes } = style(store, {});
    for (let i = 0; i < d.count; i++) expect(sizes[i]).toBeCloseTo(symbolRadius(starLogL(d, i)), 6);
  });

  it('colours by a whole-system category and inherits it on the members', () => {
    const store = new AttributeStore(false);
    const f = store.addDef('Faction', 'text', true);
    store.setValue(f.id, 'HR 1', 'Union');
    store.setValue(f.id, 'HIP 3', 'League');
    const get = valueGetter(f.id, store)!;
    const d = node();
    expect([0, 1, 2, 3].map((i) => get(d, i))).toEqual(['Union', 'Union', 'League', undefined]);
    const cats = categoryColors(f.id, store);
    expect([...cats.keys()]).toEqual(['League', 'Union']);
    const { rgb, sizes } = style(store, { colorBy: f.id });
    expect(rgb(0)).toEqual(hexToRgb(cats.get('Union')!));
    expect(rgb(1)).toEqual(hexToRgb(cats.get('Union')!));
    expect(rgb(2)).toEqual(hexToRgb(cats.get('League')!));
    // the Sun has no value but stays as it is
    expect(sizes[3]).toBeGreaterThan(MISSING_SIZE);
  });

  it('does not pass a star-only value on to the system', () => {
    const store = new AttributeStore(false);
    const f = store.addDef('Note', 'text', false);
    store.setValue(f.id, 'HR 1', 'x');
    const get = valueGetter(f.id, store)!;
    expect(get(node(), 1)).toBeUndefined();
  });

  it('dims, hides or keeps stars without a value', () => {
    const store = new AttributeStore(false);
    const e = store.addDef('Economy', 'number');
    store.setValue(e.id, 'HR 1', 5);
    let r = style(store, { colorBy: e.id, missingStyle: 'dim' });
    expect(r.rgb(1)).toEqual(hexToRgb(MISSING_COLOR));
    expect(r.sizes[1]).toBeCloseTo(MISSING_SIZE, 6);
    r = style(store, { colorBy: e.id, missingStyle: 'hide' });
    expect(r.sizes[1]).toBe(0);
    expect(r.sizes[0]).toBeGreaterThan(0);
    r = style(store, { colorBy: e.id, missingStyle: 'normal' });
    expect(r.sizes[1]).toBeCloseTo(symbolRadius(starLogL(r.d, 1)), 6);
  });

  it('maps numbers through the scale, also logarithmically and reversed', () => {
    expect(scalePosition(5, { min: 0, max: 10 })).toBe(0.5);
    expect(scalePosition(-3, { min: 0, max: 10 })).toBe(0);
    expect(scalePosition(100, { min: 1, max: 1e4, log: true })).toBeCloseTo(0.5, 9);
    expect(scalePosition(2, { min: 0, max: 10, reverse: true })).toBeCloseTo(0.8, 9);
    const store = new AttributeStore(false);
    const e = store.addDef('Economy', 'number');
    store.setValue(e.id, 'HR 1', 2);
    store.setValue(e.id, 'HR 2', 8);
    expect(numericScale(e.id, store)).toMatchObject({ min: 2, max: 8 });
    store.setScale(e.id, { max: 20 });
    expect(numericScale(e.id, store)).toMatchObject({ min: 2, max: 20 });
    const { sizes } = style(store, { sizeBy: e.id });
    expect(sizes[0]).toBeCloseTo(sizeForPosition(0), 6);
    expect(sizes[1]).toBeCloseTo(sizeForPosition(6 / 18), 6);
  });

  it('colours by the colour values themselves and by known planets', () => {
    const store = new AttributeStore(false);
    const c = store.addDef('Flag', 'color');
    store.setValue(c.id, 'HIP 3', '#123456');
    expect(style(store, { colorBy: c.id }).rgb(2)).toEqual([0x12, 0x34, 0x56]);
    const p = style(store, { colorBy: '@planets', missingStyle: 'hide' });
    expect([...p.sizes].map((x) => x > 0)).toEqual([false, false, true, true]); // HIP 3 and the Sun
  });
});
