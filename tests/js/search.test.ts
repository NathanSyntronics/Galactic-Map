import { describe, expect, it } from 'vitest';
import { SearchIndex, normalize, type SearchTuple } from '../../src/ui/search';

describe('normalize', () => {
  it('folds superscript indices, diacritics, case and separators', () => {
    expect(normalize('Rho¹ Cancri')).toBe(normalize('Rho1 Cancri'));
    expect(normalize('Omicron² Eridani')).toBe('omicron2eridani');
    expect(normalize('Theta Boötis')).toBe('thetabootis');
    expect(normalize("Barnard's Star")).toBe(normalize('Barnard’s Star'));
    expect(normalize('Krüger 60')).toBe('kruger60');
  });

  it('removes all dash and minus variants', () => {
    const ascii = normalize('2MASS 1507-1627');
    for (const dash of ['−', '‐', '‑', '‒', '–', '—', '―', '－']) {
      expect(normalize(`2MASS 1507${dash}1627`)).toBe(ascii);
    }
    expect(normalize('LSR 1610−0040')).toBe(normalize('LSR 1610-0040'));
    expect(normalize('WD 0806−661')).toBe('wd0806661');
  });
});

describe('SearchIndex', () => {
  const tuples: SearchTuple[] = [
    ['Rho¹ Cancri', null, 'r1', 1, 0, 0, 0, 2, ['55 Cancri']],
    ['Alpha¹ Centauri', null, 'r1', 2, 0, 0, 0, 2],
    ['2MASS 1507−1627', null, 'r2', 3, 0, 0, 0, 7],
    ['LSR 1610−0040', null, 'r2', 4, 0, 0, 0, 7],
    ['Vega', 'Wega', 'r', 5, 0, 0, 0, 0],
    ['Mu¹ Herculis', null, 'r3', 6, 0, 0, 0, 2],
  ];
  const index = new SearchIndex();
  index.load(tuples);
  const first = (q: string) => index.query(q)[0]?.nameEn ?? null;

  it('finds names typed with ASCII indices and hyphens', () => {
    expect(first('Rho1 Cancri')).toBe('Rho¹ Cancri');
    expect(first('Alpha1 Centauri')).toBe('Alpha¹ Centauri');
    expect(first('Mu1 Herculis')).toBe('Mu¹ Herculis');
    expect(first('2MASS 1507-1627')).toBe('2MASS 1507−1627');
    expect(first('LSR 1610-0040')).toBe('LSR 1610−0040');
    expect(first('lsr1610')).toBe('LSR 1610−0040');
  });

  it('prefers a match on the displayed name over one on another designation', () => {
    const idx = new SearchIndex();
    idx.load([
      ['Proxima Centauri', null, 'r', 1, 0, 0, 0, 1, ['Alpha Centauri C', 'Gliese 551']],
      ['Alpha Centauri A', null, 'r', 2, 0, 0, 0, 2, ['Rigil Kentaurus', 'Gliese 559 A']],
    ]);
    expect(idx.query('alpha centauri')[0].nameEn).toBe('Alpha Centauri A');
    expect(idx.query('rigil kentaurus')[0].nameEn).toBe('Alpha Centauri A');
  });

  it('puts a name plus a generic word (Galaxy, Dwarf) before longer names', () => {
    const idx = new SearchIndex();
    idx.load([
      ['Andromeda I', null, 'g', 1, 0, 0, 0, 0, ['And I']],
      ['Andromeda II', null, 'g', 2, 0, 0, 0, 0],
      ['Andromeda Galaxy', 'Andromedagalaxie', 'g', 3, 0, 0, 0, 0, ['M 31', 'NGC 224']],
      ['Sculptor Dwarf Galaxy', 'Sculptor-Zwerggalaxie', 'g', 4, 0, 0, 0, 0, ['Sculptor']],
      ['Sculptor Galaxy', 'Sculptor-Galaxie', 'g', 5, 0, 0, 0, 0, ['NGC 253']],
      ['Fornax Dwarf', 'Fornax-Zwerggalaxie', 'g', 6, 0, 0, 0, 0],
      ['Fornax II', null, 'g', 7, 0, 0, 0, 0],
    ]);
    expect(idx.query('Andromeda').map((h) => h.nameEn).slice(0, 2)).toEqual(['Andromeda Galaxy', 'Andromeda I']);
    expect(idx.query('andromed')[0].nameEn).toBe('Andromeda I');
    expect(idx.query('Sculptor').map((h) => h.nameEn)).toEqual(['Sculptor Galaxy', 'Sculptor Dwarf Galaxy']);
    expect(idx.query('Fornax')[0].nameEn).toBe('Fornax Dwarf');
    expect(idx.query('Andromeda II')[0].nameEn).toBe('Andromeda II');
  });

  it('lists stars before the planets that share their name, but an exact planet name first', () => {
    const idx = new SearchIndex();
    idx.load([
      ['TRAPPIST-1 b', null, 'p', 0, 7.75, 20.968, -33.965, 0, null, 'TRAPPIST-1 b', -1],
      ['TRAPPIST-1 c', null, 'p', 1, 7.75, 20.968, -33.965, 0, null, 'TRAPPIST-1 c', -1],
      ['TRAPPIST-1', 'Trappist-1', 'r5222304747', 3885, 7.75, 20.968, -33.965, 7, ['2MASS J23062928-0502285'], 'TRAPPIST-1', -1],
      ['Earth', 'Erde', 'p', 2, 0, 0, 0, 0, null, 'Earth', -1],
      ['Erdeiland', null, 'r0', 5, 1, 1, 1, 7, null, 'Erdeiland', -1],
    ]);
    expect(idx.query('Trappist').map((h) => h.nameEn)).toEqual(['TRAPPIST-1', 'TRAPPIST-1 b', 'TRAPPIST-1 c']);
    expect(idx.query('Trappist-1')[0].nameEn).toBe('TRAPPIST-1');
    expect(idx.query('trappist-1 c')[0].nameEn).toBe('TRAPPIST-1 c');
    expect(idx.query('Erde')[0].nameEn).toBe('Earth');
  });

  it("lists a star's planets right after it, before longer star names", () => {
    const idx = new SearchIndex();
    idx.load([
      ['Kepler-900', null, 'r1', 1, 0, 0, 0, 7, null, 'Kepler-900', -1],
      ['Kepler-901', null, 'r1', 2, 0, 0, 0, 7, null, 'Kepler-901', -1],
      ['Kepler-90 b', null, 'p', 0, 0, 0, 0, 0, null, 'Kepler-90 b', -1],
      ['Kepler-90 h', null, 'p', 1, 0, 0, 0, 0, null, 'Kepler-90 h', -1],
      ['Kepler-90', null, 'r1', 3, 0, 0, 0, 7, null, 'Kepler-90', -1],
      ['Kepler-900 b', null, 'p', 2, 0, 0, 0, 0, null, 'Kepler-900 b', -1],
    ]);
    expect(idx.query('Kepler-90').map((h) => h.nameEn)).toEqual(['Kepler-90', 'Kepler-90 b', 'Kepler-90 h', 'Kepler-900', 'Kepler-901', 'Kepler-900 b']);
    expect(idx.at('r1', 3)?.[0]).toBe('Kepler-90');
    expect(idx.at('p', 0)).toBeNull();
    // a planet named after another name of its star (the archive's KOI-351 b), found by the map's
    idx.add([['KOI-351 c', null, 'p', 3, 0, 0, 0, 0, ['Kepler-90 c'], 'KOI-351 c', -1]]);
    const hits = idx.query('Kepler-90').map((h) => h.nameEn);
    expect(hits.indexOf('KOI-351 c')).toBeLessThan(hits.indexOf('Kepler-900'));
  });

  it('still finds German names and alternative designations', () => {
    expect(first('wega')).toBe('Vega');
    expect(first('55 Cnc'.replace('Cnc', 'Cancri'))).toBe('Rho¹ Cancri');
  });

  it('prefers the exact spelling when two designations share a normalised key', () => {
    const idx = new SearchIndex();
    idx.load([
      ['G 18-57', null, 'r1', 1, 0, 0, 0, 7, null, 'G 18-57', -1],
      ['G 185-7', null, 'r2', 2, 0, 0, 0, 7, null, 'G 185-7', -1],
      ['Star X', null, 'r3', 3, 0, 0, 0, 7, ['LP 131-33'], 'HIP 1', -1],
      ['LP 13-133', null, 'r4', 4, 0, 0, 0, 7, null, 'LP 13-133', -1],
    ]);
    expect(idx.find('G 18-57')?.[3]).toBe(1);
    expect(idx.find('G 185-7')?.[3]).toBe(2);
    // an alternative designation spelled exactly beats a primary that only normalises the same
    expect(idx.find('LP 131-33')?.[3]).toBe(3);
    expect(idx.find('LP 13-133')?.[3]).toBe(4);
    // other spellings still find the first (primary designations first)
    expect(idx.find('g18-57')?.[3]).toBe(1);
    expect(idx.find('lp 1313-3')?.[3]).toBe(4);
    expect(idx.byPrimary('G 185-7')?.[3]).toBe(2);
    expect(idx.byPrimary('G 1857')).toBeNull();
  });

  it('finds a catalogue number only on the star that has it', () => {
    const idx = new SearchIndex();
    idx.load([
      ['HD 143116', null, 'r1', 1, 0, 0, 0, 7, ['HIP 78372', 'TYC 7341-774-1'], 'HIP 78372', -1],
      ['Star Y', null, 'r2', 2, 0, 0, 0, 7, ['TYC 7341-775-1'], 'HD 2', -1],
    ]);
    expect(idx.find('TYC 7341-774-1')?.[3]).toBe(1);
    expect(idx.find('tyc 7341-774-1')?.[3]).toBe(1);
    // the same digits split differently are another star (not in the index)
    expect(idx.find('TYC 734-1774-1')).toBeNull();
    expect(idx.find('TYC 7341-77-51')).toBeNull();
    expect(idx.find('HIP 78372')?.[3]).toBe(1);
  });
});

describe('the primary designation', () => {
  it('finds a star by its designation also when the other designations do not repeat it', () => {
    const idx = new SearchIndex();
    idx.load([['Acamar', null, 'r1', 20, 0, 0, 0, 0, ['Theta¹ Eridani', 'HD 18622'], 'HR 897', 3198]]);
    expect(idx.query('HR 897')[0]?.nameEn).toBe('Acamar');
    expect(idx.query('HR 897')[0]?.matched).toBe('HR 897');
    expect(idx.find('HR 897')?.[0]).toBe('Acamar');
  });
});
