import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseStored, storedForm } from '../../src/settings';

describe('stored settings', () => {
  it('stores only the values that differ from the defaults', () => {
    const s = { ...DEFAULT_SETTINGS, lang: 'de' as const, radius: 75 };
    expect(storedForm(s)).toEqual({ v: 2, lang: 'de', radius: 75 });
    expect(parseStored(JSON.stringify(storedForm(s)))).toEqual({ lang: 'de', radius: 75 });
  });

  it('lets the old defaults of the first stored format give way to the current ones', () => {
    const legacy = { ...DEFAULT_SETTINGS, radius: 50, labelCount: 60, lang: 'de', grid: false };
    expect(parseStored(JSON.stringify(legacy))).toEqual({ ...DEFAULT_SETTINGS, lang: 'de', grid: false, radius: undefined, labelCount: undefined });
    const changed = { ...legacy, radius: 120 };
    expect(parseStored(JSON.stringify(changed)).radius).toBe(120);
  });

  it('defaults to a 20 ly radius and 30 labels', () => {
    expect(DEFAULT_SETTINGS.radius).toBe(20);
    expect(DEFAULT_SETTINGS.labelCount).toBe(30);
  });

  it('has the jump network defaults of the specification', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      jumps: true,
      jumpRange: 10,
      jumpFaint: 3,
      jumpSun: 7,
      jumpBright: 12,
      jumpBy: '',
      jumpHub: 1,
      jumpConnect: true,
      jumpColor: 'stars',
      jumpOpacity: 0.6,
    });
  });

  it('ignores unknown choices and clamps slider values when reading stored settings', () => {
    const raw = JSON.stringify({ v: 2, jumpColor: 'neon', quality: 'insane', jumpRange: 500, jumpOpacity: 0, jumpHub: 1.5, jumps: false });
    expect(parseStored(raw)).toEqual({ jumpRange: 25, jumpOpacity: 0.05, jumpHub: 1.5, jumps: false });
    expect(parseStored(JSON.stringify({ v: 2, jumpColor: 'length', jumpBy: 'faction' }))).toEqual({ jumpColor: 'length', jumpBy: 'faction' });
  });
});
