import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserAttributeStorage, LOCAL_STORAGE_KEY } from '../../src/data/attribute-storage';
import { AttributeStore } from '../../src/data/attributes';
import { NO_LOOKUP, importCsv, importCsvAsync } from '../../src/data/importer';

function sample(store: AttributeStore): void {
  const f = store.addDef('Faction', 'text', true);
  const e = store.addDef('Economy', 'number');
  const c = store.addDef('Flag', 'color');
  store.setLabels(f.id, { de: 'Fraktion' });
  store.setValueLabel(f.id, 'League of Vega', 'de', 'Liga von Wega');
  store.setScale(e.id, { palette: 'viridis', log: true });
  store.setValue(f.id, 'Sun', 'Sol');
  store.setValue(f.id, 'HR 7001', 'League of Vega');
  store.setValue(f.id, 'Gaia DR3 5853498713190525696', 'League of Vega');
  store.setValue(f.id, 'TYC 9007-5848-1', 'Sol');
  store.setValue(e.id, 'HIP 70890', 2.5);
  store.setValue(e.id, 'Gaia DR3 18446744073709551615', -1e-3);
  store.setValue(c.id, 'HD 48915', '#ff8800');
}

describe('packed state', () => {
  it('round-trips definitions, labels, scales and every kind of designation', () => {
    const a = new AttributeStore(false);
    sample(a);
    const packed = a.pack();
    expect(packed.v).toBe(2);
    expect(packed.values.faction.table).toEqual(['League of Vega', 'Sol']);
    expect(packed.values.faction.index).toBeInstanceOf(Uint32Array);
    expect(packed.values.economy.numbers).toBeInstanceOf(Float64Array);
    // what IndexedDB keeps: a structured clone
    const b = new AttributeStore(false);
    b.load(structuredClone(packed));
    expect(b.toJSON()).toEqual(a.toJSON());
    expect(b.getValue('faction', 'gaia dr3 5853498713190525696')).toBe('League of Vega');
  });

  it('drops values that do not fit the type when loading', () => {
    const a = new AttributeStore(false);
    sample(a);
    const packed = a.pack();
    packed.values.flag.table = ['not a colour'];
    const b = new AttributeStore(false);
    b.load(packed);
    expect(b.valueCount('flag')).toBe(0);
    expect(b.valueCount('faction')).toBe(4);
  });
});

describe('browser storage without IndexedDB', () => {
  const items = new Map<string, string>();
  beforeEach(() => {
    items.clear();
    Object.assign(globalThis, {
      window: globalThis,
      localStorage: {
        getItem: (k: string) => items.get(k) ?? null,
        setItem: (k: string, v: string) => void items.set(k, v),
        removeItem: (k: string) => void items.delete(k),
      },
    });
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('falls back to localStorage, reads it back and forgets it', async () => {
    const storage = new BrowserAttributeStorage();
    const a = new AttributeStore(storage);
    sample(a);
    await a.saveNow();
    expect(a.saveError).toBeNull();
    expect(JSON.parse(items.get(LOCAL_STORAGE_KEY)!).v).toBe(1);
    const b = new AttributeStore(storage);
    b.load((await b.readStored())!);
    expect(b.toJSON()).toEqual(a.toJSON());
    await b.clearStored();
    expect(await b.readStored()).toBeNull();
  });

  it('reports a failed save', async () => {
    const a = new AttributeStore(new BrowserAttributeStorage());
    sample(a);
    (globalThis as unknown as { localStorage: Storage }).localStorage.setItem = () => {
      throw new Error('quota');
    };
    let reported: unknown = null;
    a.onSaveError = (err) => (reported = err);
    await a.saveNow();
    expect(String(reported)).toContain('quota');
  });
});

describe('stepwise import', () => {
  it('gives the same result as the plain import and tells listeners once', async () => {
    const rows = ['designation [exact],Faction [text, system],Faction [de: Fraktion]'];
    for (let i = 0; i < 2500; i++) rows.push(`Gaia DR3 ${1000000 + i},F${i % 7},${i < 7 ? `G${i}` : ''}`);
    const csv = rows.join('\n');
    const a = new AttributeStore(false);
    const ra = importCsv(csv, a, NO_LOOKUP);
    const b = new AttributeStore(false);
    const events: string[] = [];
    b.subscribe((k) => events.push(k));
    const rb = await importCsvAsync(csv, b, NO_LOOKUP, false, 300);
    expect(rb).toEqual(ra);
    expect(b.toJSON()).toEqual(a.toJSON());
    expect(events).toEqual(['defs']);
    expect(b.def('faction')!.valueLabels!.F3).toEqual({ de: 'G3' });
  });
});
