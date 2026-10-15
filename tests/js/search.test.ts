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

  it('still finds German names and alternative designations', () => {
    expect(first('wega')).toBe('Vega');
    expect(first('55 Cnc'.replace('Cnc', 'Cancri'))).toBe('Rho¹ Cancri');
  });
});
