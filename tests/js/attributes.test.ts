import { describe, expect, it } from 'vitest';
import { AttributeStore } from '../../src/data/attributes';
import { csvLayout, decodeCsv, inferType, parseColumnHeader, parseCsv, parseNumber } from '../../src/data/csv';
import { DesignationMap, canonicalDesignation, parseDesignation } from '../../src/data/designation';
import { DesigCat, type NodeData } from '../../src/data/format';
import { exportCsv, importCsv, type StarResolver } from '../../src/data/importer';

function fakeNode(desigs: [number, number, number, string?][]): NodeData {
  const n = desigs.length;
  const desigCat = new Uint8Array(n);
  const desigId = new Uint32Array(2 * n);
  const designations = new Map<number, string>();
  desigs.forEach(([c, lo, hi, s], i) => {
    desigCat[i] = c;
    desigId[2 * i] = lo;
    desigId[2 * i + 1] = hi;
    if (s) designations.set(i, s);
  });
  return { count: n, desigCat, desigId, designations } as unknown as NodeData;
}

describe('designations', () => {
  it('parses catalogue numbers in any spelling and renders them like the node decoder', () => {
    expect(canonicalDesignation('hip  70890')).toBe('HIP 70890');
    expect(canonicalDesignation('HD48915')).toBe('HD 48915');
    expect(canonicalDesignation('tyc 9007-5848-1')).toBe('TYC 9007-5848-1');
    expect(canonicalDesignation('gaia dr3 5853498713190525696')).toBe('Gaia DR3 5853498713190525696');
    expect(canonicalDesignation(' WISE  J085510.83-071442.5 ')).toBe('WISE J085510.83-071442.5');
    expect(parseDesignation('Gaia DR3 5853498713190525696')).toEqual({
      cat: DesigCat.GAIA_DR3,
      lo: Number(5853498713190525696n & 0xffffffffn),
      hi: Number(5853498713190525696n >> 32n),
      str: null,
    });
  });

  it('finds the value of a star in a node without building its designation', () => {
    const g = 5853498713190525696n;
    const node = fakeNode([
      [DesigCat.HIP, 70890, 0],
      [DesigCat.GAIA_DR3, Number(g & 0xffffffffn), Number(g >> 32n)],
      [DesigCat.TYC, 9007 + 40000 * 65536, 1],
      [DesigCat.STRING, 0, 0, 'Sun'],
      [DesigCat.HD, 1, 0],
    ]);
    const m = new DesignationMap<number>();
    m.set('HIP 70890', 1);
    m.set(`gaia dr3 ${g}`, 2);
    m.set('TYC 9007-40000-1', 3);
    m.set('Sun', 4);
    expect([0, 1, 2, 3, 4].map((i) => m.get(node, i))).toEqual([1, 2, 3, 4, undefined]);
    m.delete('hip 70890');
    expect(m.get(node, 0)).toBeUndefined();
    expect(m.size).toBe(3);
  });
});

describe('CSV', () => {
  it('reads quoted fields, semicolons, tabs and a byte order mark', () => {
    const t = parseCsv('﻿designation;Fraktion;Wert\r\n"HIP 1";"Haus ""A""; Nord";"1,5"\r\nHD 2;B;2\r\n\r\n');
    expect(t.delimiter).toBe(';');
    expect(t.header).toEqual(['designation', 'Fraktion', 'Wert']);
    expect(t.rows).toEqual([
      ['HIP 1', 'Haus "A"; Nord', '1,5'],
      ['HD 2', 'B', '2'],
    ]);
    expect(parseCsv('a\tb\n1\t2').rows).toEqual([['1', '2']]);
    expect(parseCsv('a,b\n"x\ny",2').rows).toEqual([['x\ny', '2']]);
  });

  it('reads English and German numbers', () => {
    expect(parseNumber('1.5', false)).toBe(1.5);
    expect(parseNumber('1,5', true)).toBe(1.5);
    expect(parseNumber('1,5', false)).toBeNull();
    expect(parseNumber('1.234,5', true)).toBe(1234.5);
    expect(parseNumber('1,234.5', false)).toBe(1234.5);
    expect(parseNumber('-3e-4', false)).toBe(-3e-4);
    expect(parseNumber('12 000', true)).toBe(12000);
    expect(parseNumber('n/a', false)).toBeNull();
  });

  it('reads type and system tags from headers and infers types', () => {
    expect(parseColumnHeader('Faction [text, system]')).toEqual({ name: 'Faction', type: 'text', system: true });
    expect(parseColumnHeader('Wirtschaft [Zahl]')).toEqual({ name: 'Wirtschaft', type: 'number', system: null });
    expect(parseColumnHeader('Plain')).toEqual({ name: 'Plain', type: null, system: null });
    expect(inferType(['1', '', '2,5'], true)).toBe('number');
    expect(inferType(['#ff0000', '#0f0'], false)).toBe('color');
    expect(inferType(['red', '3'], false)).toBe('text');
  });

  it('reads files saved as Windows-1252 as well as UTF-8', () => {
    const latin1 = new Uint8Array([0x46, 0xfc, 0x72, 0x3b, 0xdf]).buffer; // "Für;ß"
    expect(decodeCsv(latin1)).toBe('Für;ß');
    expect(decodeCsv(new TextEncoder().encode('Für;ß').buffer as ArrayBuffer)).toBe('Für;ß');
  });

  it('finds the key column and skips the informational name column', () => {
    expect(csvLayout(['designation', 'name', 'A', 'B'])).toEqual({ keyColumn: 0, valueColumns: [2, 3] });
    expect(csvLayout(['A', 'Name', 'B'])).toEqual({ keyColumn: 1, valueColumns: [0, 2] });
    expect(csvLayout(['Stern', 'B'])).toEqual({ keyColumn: 0, valueColumns: [1] });
    expect(csvLayout(['designation', 'System'])).toEqual({ keyColumn: 0, valueColumns: [1] });
  });
});

const resolver: StarResolver = {
  star(key) {
    const k = key.toLowerCase();
    if (k === 'sirius' || k === 'hip 32349') return { designation: 'HR 2491', system: 7 };
    if (k === 'sirius b') return { designation: 'Gaia DR3 2947050466531873024', system: 7 };
    if (k === 'vega') return { designation: 'HR 7001', system: -1 };
    return null;
  },
  systemPrimary: (s) => (s === 7 ? 'HR 2491' : null),
};

describe('import and export', () => {
  it('creates attributes, resolves names and puts whole-system values on the primary', () => {
    const store = new AttributeStore(false);
    const csv = 'name,Faction [system],Economy,Colour\nSirius B,Union,"3,5",#F00\nVega,League,2,\nBetelgeuse,X,1,\nTYC 1-2-1,,7,';
    const r = importCsv(csv, store, resolver);
    expect(r.rows).toBe(4);
    expect(r.matched).toBe(2);
    expect(r.unverified).toBe(1);
    expect(r.unresolved).toEqual(['Betelgeuse']);
    const faction = store.defByName('faction')!;
    expect(faction).toMatchObject({ type: 'text', system: true });
    expect(store.getValue(faction.id, 'HR 2491')).toBe('Union');
    expect(store.getValue(faction.id, 'Gaia DR3 2947050466531873024')).toBeUndefined();
    const econ = store.defByName('Economy')!;
    expect(econ.type).toBe('text'); // "3,5" in a comma-separated file is not a number
    const colour = store.defByName('Colour')!;
    expect(colour.type).toBe('color');
    expect(store.getValue(colour.id, 'Gaia DR3 2947050466531873024')).toBe('#ff0000');
    expect(store.getValue(econ.id, 'TYC 1-2-1')).toBe('7');
  });

  it('round-trips through the export in both languages', () => {
    for (const lang of ['en', 'de'] as const) {
      const a = new AttributeStore(false);
      const eco = a.addDef('Economy', 'number');
      const fac = a.addDef('Faction', 'text', true);
      a.setValue(eco.id, 'HR 7001', 2.5);
      a.setValue(eco.id, 'HR 2491', -1e-3);
      a.setValue(fac.id, 'HR 2491', 'Union; "North"');
      const csv = exportCsv(a, { name: (d) => (d === 'HR 7001' ? 'Vega' : null) }, lang);
      const b = new AttributeStore(false);
      const r = importCsv(csv, b, { star: () => null, systemPrimary: () => null });
      expect(r.unresolved).toEqual([]);
      expect(b.toJSON().defs).toEqual(a.toJSON().defs);
      expect(b.toJSON().values).toEqual(a.toJSON().values);
    }
  });

  it('tells listeners about an import once', () => {
    const store = new AttributeStore(false);
    const events: string[] = [];
    store.subscribe((k) => events.push(k));
    importCsv('designation,A,B,C\nHR 1,1,x,#fff', store, resolver);
    expect(events).toEqual(['defs']);
    expect(store.defs.map((d) => d.name)).toEqual(['A', 'B', 'C']);
  });

  it('replaces old values only when asked to', () => {
    const store = new AttributeStore(false);
    importCsv('designation,Economy\nHR 1,1\nHR 2,2', store, resolver);
    importCsv('designation,Economy\nHR 1,5', store, resolver);
    const id = store.defByName('Economy')!.id;
    expect(store.valueCount(id)).toBe(2);
    importCsv('designation,Economy\nHR 1,6', store, resolver, true);
    expect(store.valueCount(id)).toBe(1);
    expect(store.getValue(id, 'HR 1')).toBe(6);
  });

  it('converts values when the type of an attribute changes', () => {
    const store = new AttributeStore(false);
    const d = store.addDef('Level', 'text');
    store.setValue(d.id, 'HR 1', '3');
    store.setValue(d.id, 'HR 2', 'high');
    expect(store.updateDef(d.id, { type: 'number' })).toBe(1);
    expect(store.getValue(d.id, 'HR 1')).toBe(3);
    expect(store.setValue(d.id, 'HR 3', 'x')).toBe(false);
    expect(() => store.addDef('level', 'number')).toThrow();
  });
});
