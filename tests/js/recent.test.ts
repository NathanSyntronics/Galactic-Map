import { describe, expect, it } from 'vitest';
import { RECENT_MAX, addRecent, parseRecent, resolveRecent, sameRecent, type RecentSearch } from '../../src/ui/recent';
import { SearchIndex, hitOf, type SearchTuple } from '../../src/ui/search';

const vega: RecentSearch = { designation: 'HR 7001', nameEn: 'Vega', nameDe: 'Wega' };
const sirius: RecentSearch = { designation: 'HR 2491', nameEn: 'Sirius A', nameDe: null };
const sun: RecentSearch = { designation: 'Sun', nameEn: 'Sun', nameDe: 'Sonne' };
const arcturus: RecentSearch = { designation: 'HR 5340', nameEn: 'Arcturus', nameDe: 'Arktur' };

describe('recent searches', () => {
  it('keeps the last three, newest first', () => {
    let list: RecentSearch[] = [];
    for (const e of [vega, sirius, sun, arcturus]) list = addRecent(list, e);
    expect(RECENT_MAX).toBe(3);
    expect(list.map((e) => e.nameEn)).toEqual(['Arcturus', 'Sun', 'Sirius A']);
  });

  it('moves a star picked again to the front instead of listing it twice', () => {
    let list = [arcturus, sun, sirius];
    list = addRecent(list, { ...sirius });
    expect(list.map((e) => e.designation)).toEqual(['HR 2491', 'HR 5340', 'Sun']);
    list = addRecent(list, arcturus);
    expect(list.map((e) => e.designation)).toEqual(['HR 5340', 'HR 2491', 'Sun']);
  });

  it('reads the stored list and drops invalid entries and duplicates', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent('not json')).toEqual([]);
    expect(parseRecent('{"designation":"Sun"}')).toEqual([]);
    const raw = JSON.stringify([
      vega,
      { designation: '', nameEn: 'Empty' },
      { designation: 'HR 7001', nameEn: 'Vega again', nameDe: null },
      { nameEn: 'No designation' },
      null,
      { designation: 'HR 2491', nameEn: 'Sirius A', nameDe: 5 },
      sun,
      arcturus,
    ]);
    expect(parseRecent(raw)).toEqual([vega, sirius, sun]);
    expect(parseRecent(JSON.stringify([vega, sun]))).toEqual([vega, sun]);
  });

  it('looks the entries up in the search index: current names, missing stars dropped', () => {
    const tuples: SearchTuple[] = [
      ['Vega', 'Wega', 'r1', 5, 9, 21, 8, 0, ['Alpha Lyrae'], 'HR 7001', -1],
      ['Sun', 'Sonne', 'r', 0, 0, 0, 0, 0, null, 'Sun', -1],
      ['Sirius', null, 'r2', 7, -5, -2, 1, 0, null, 'HR 2491', 12],
    ];
    const index = new SearchIndex();
    index.load(tuples);
    const resolved = resolveRecent([arcturus, sirius, vega], (d) => index.byPrimary(d));
    // Arcturus is not in this index; Sirius A is called Sirius now
    expect(resolved.map((r) => r.entry)).toEqual([{ designation: 'HR 2491', nameEn: 'Sirius', nameDe: null }, vega]);
    expect(resolved[1].tuple[2]).toBe('r1');
    expect(sameRecent(resolved.map((r) => r.entry), [sirius, vega])).toBe(false);
    expect(sameRecent([vega, sun], [{ ...vega }, { ...sun }])).toBe(true);
  });
});

describe('hitOf', () => {
  it('builds a search hit from an index entry', () => {
    const hit = hitOf(['Vega', 'Wega', 'r1', 5, 0, 0, 0, 0, ['Alpha Lyrae'], 'HR 7001', -1]);
    expect(hit).toMatchObject({ nameEn: 'Vega', nameDe: 'Wega', path: 'r1', index: 5, matched: 'Vega', designation: 'HR 7001' });
    expect(hit.pos.length()).toBe(0);
    expect(hitOf(['X', null, 'r', 1, 3, 4, 0, 9]).designation).toBeNull();
    expect(hitOf(['X', null, 'r', 1, 3, 4, 0, 9]).pos.length()).toBeCloseTo(5, 9);
  });

  it('carries the designation in query results', () => {
    const index = new SearchIndex();
    index.load([['Vega', 'Wega', 'r1', 5, 0, 0, 0, 0, ['Alpha Lyrae'], 'HR 7001', -1]]);
    expect(index.query('alpha lyrae')[0]).toMatchObject({ designation: 'HR 7001', matched: 'Alpha Lyrae' });
  });
});
