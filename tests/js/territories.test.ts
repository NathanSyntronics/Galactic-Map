import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { csvLayout, parseColumnHeader, parseCsv } from '../../src/data/csv';
import { borderLinks, growTerritories, territoryJumps, type TerritoryLinks } from '../../tools/territories';
import { FACTIONS } from '../../tools/factions';

/** Links from [a, b] pairs. */
function linksOf(pairs: [number, number][]): TerritoryLinks {
  return { count: pairs.length, a: pairs.map((p) => Math.min(...p)), b: pairs.map((p) => Math.max(...p)) };
}

/** Places on a line at the given x coordinates; distance = |x - x(capital)|. */
function line(xs: number[], capitals: number[]) {
  return (p: number, f: number) => Math.abs(xs[p] - xs[capitals[f]]);
}

describe('territories', () => {
  it('two factions on a chain meet halfway', () => {
    // 0 - 1 - 2 - 3 - 4 - 5 - 6, capitals at both ends
    const xs = [0, 1, 2, 3, 4, 5, 6];
    const links = linksOf([[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]);
    const t = growTerritories(7, links, [{ capital: 0, size: 10 }, { capital: 6, size: 10 }], line(xs, [0, 6]));
    // place 3 is equally far: the first faction wins the tie
    expect([...t.owner]).toEqual([0, 0, 0, 0, 1, 1, 1]);
    expect(t.members).toEqual([[0, 1, 2, 3], [6, 5, 4]]);
  });

  it('stops each faction at its size; the other one takes the rest', () => {
    const xs = [0, 1, 2, 3, 4, 5, 6];
    const links = linksOf([[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]);
    const t = growTerritories(7, links, [{ capital: 0, size: 2 }, { capital: 6, size: 4 }], line(xs, [0, 6]));
    expect([...t.owner]).toEqual([0, 0, -1, 1, 1, 1, 1]);
    expect(t.members.map((m) => m.length)).toEqual([2, 4]);
  });

  it('claims only places linked to the territory, nearest first', () => {
    // 0 is the capital; 1 is near but only linked to 3; 2 and 3 are farther away
    const xs = [0, 1, 2, 3];
    const links = linksOf([[0, 2], [2, 3], [3, 1]]);
    const t = growTerritories(4, links, [{ capital: 0, size: 3 }], line(xs, [0]));
    expect(t.members[0]).toEqual([0, 2, 3]);
    expect(t.owner[1]).toBe(-1);
  });

  it('orders claims by distance, not by the number of jumps', () => {
    // capital 0 links directly to a far place 1 (x = 8) and through 2 (x = 1) to 3 (x = 2)
    const xs = [0, 8, 1, 2];
    const links = linksOf([[0, 1], [0, 2], [2, 3]]);
    const t = growTerritories(4, links, [{ capital: 0, size: 3 }], line(xs, [0]));
    expect(t.members[0]).toEqual([0, 2, 3]);
  });

  it('keeps every territory connected and the result independent of the link order', () => {
    // a 6 x 6 grid with every other link removed in a pattern, three capitals
    const n = 36;
    const pairs: [number, number][] = [];
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < 6; x++) {
        const p = 6 * y + x;
        if (x < 5 && (y + x) % 3 !== 0) pairs.push([p, p + 1]);
        if (y < 5) pairs.push([p, p + 6]);
      }
    const pos = (p: number) => [p % 6, Math.floor(p / 6)];
    const caps = [0, 5, 33];
    const dist = (p: number, f: number) => Math.hypot(pos(p)[0] - pos(caps[f])[0], pos(p)[1] - pos(caps[f])[1]);
    const seeds = caps.map((capital, k) => ({ capital, size: [14, 10, 8][k] }));
    const t = growTerritories(n, linksOf(pairs), seeds, dist);
    const reversed = growTerritories(n, linksOf(pairs.slice().reverse()), seeds, dist);
    expect([...reversed.owner]).toEqual([...t.owner]);
    expect(t.members.map((m) => m.length)).toEqual([14, 10, 8]);
    caps.forEach((c, f) => {
      const jumps = territoryJumps(n, linksOf(pairs), t.owner, c);
      for (const p of t.members[f]) expect(jumps[p]).toBeGreaterThanOrEqual(0);
      for (let p = 0; p < n; p++) if (t.owner[p] !== f) expect(jumps[p]).toBe(-1);
    });
  });

  it('counts the links between territories', () => {
    const links = linksOf([[0, 1], [1, 2], [2, 3], [1, 3]]);
    const owner = Int32Array.from([0, 0, 1, 1]);
    expect(borderLinks(links, owner, 2)).toEqual([[0, 2], [0, 0]]);
    expect([...territoryJumps(4, links, owner, 2)]).toEqual([-1, -1, 0, 1]);
  });
});

describe('example factions (public/user/attributes.csv)', () => {
  const table = parseCsv(readFileSync(new URL('../../public/user/attributes.csv', import.meta.url), 'utf8'));
  const { keyColumn, exactKeys } = csvLayout(table.header);
  const col = (name: string) => table.header.findIndex((h) => parseColumnHeader(h).name === name);

  it('has a whole-system text column Faction and four factions of 10 to 100 systems', () => {
    // exact keys: applied without loading the search index
    expect(table.header[keyColumn]).toBe('designation [exact]');
    expect(exactKeys).toBe(true);
    const spec = parseColumnHeader(table.header[col('Faction')]);
    expect(spec).toMatchObject({ type: 'text', system: true });
    const sizes = new Map<string, number>();
    for (const r of table.rows) sizes.set(r[col('Faction')], (sizes.get(r[col('Faction')]) ?? 0) + 1);
    expect([...sizes.keys()].sort()).toEqual(FACTIONS.map((f) => f.name).sort());
    for (const f of FACTIONS) {
      expect(sizes.get(f.name)).toBe(f.size);
      expect(f.size).toBeGreaterThanOrEqual(10);
      expect(f.size).toBeLessThanOrEqual(100);
    }
  });

  it('marks one capital per faction and names every star once', () => {
    const capitals = table.rows.filter((r) => r[col('Capital')] === 'yes').map((r) => [r[1], r[col('Faction')]]);
    expect(capitals).toEqual([
      ['Sun', 'Commonwealth of Sol'],
      ['Vega', 'League of Vega'],
      ['Arcturus', 'Realm of Arcturus'],
      ['Pollux', 'Pact of Pollux'],
    ]);
    const keys = table.rows.map((r) => r[keyColumn]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives the attributes and every value a German name', () => {
    const de = (name: string) => table.header.findIndex((h) => {
      const spec = parseColumnHeader(h);
      return spec.name === name && spec.translation?.lang === 'de';
    });
    expect(parseColumnHeader(table.header[de('Faction')]).translation?.label).toBe('Fraktion');
    expect(parseColumnHeader(table.header[de('Capital')]).translation?.label).toBe('Hauptstadt');
    const german = new Map(FACTIONS.map((f) => [f.name, f.de]));
    for (const r of table.rows) {
      expect(r[de('Faction')]).toBe(german.get(r[col('Faction')]));
      expect(r[de('Capital')]).toBe(r[col('Capital')] === 'yes' ? 'ja' : '');
    }
  });
});
