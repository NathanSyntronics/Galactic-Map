import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  STAR_SIZE_MAX,
  STAR_SIZE_MIN,
  parseStored,
  sliderToStarSize,
  starSizeText,
  starSizeToSlider,
  storedForm,
} from '../../src/settings';

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
      jumpRange: 9,
      jumpFaint: 2,
      jumpSun: 6,
      jumpBright: 12,
      jumpBy: '',
      jumpHub: 1,
      jumpConnect: true,
      jumpColor: 'length',
      jumpOpacity: 0.6,
    });
  });

  it('ignores unknown choices and clamps slider values when reading stored settings', () => {
    const raw = JSON.stringify({ v: 2, jumpColor: 'neon', quality: 'insane', jumpRange: 500, jumpOpacity: 0, jumpHub: 1.5, jumps: false });
    expect(parseStored(raw)).toEqual({ jumpRange: 25, jumpOpacity: 0.05, jumpHub: 1.5, jumps: false });
    expect(parseStored(JSON.stringify({ v: 2, jumpColor: 'stars', jumpBy: 'faction' }))).toEqual({ jumpColor: 'stars', jumpBy: 'faction' });
    expect(parseStored(JSON.stringify({ v: 2, starSize: 40 }))).toEqual({ starSize: 12 });
    expect(parseStored(JSON.stringify({ v: 2, starSize: 8 }))).toEqual({ starSize: 8 });
  });

  it('keeps a stored star size that differs from the defaults of the old range', () => {
    // the old slider ended at 4: such values stay valid
    expect(parseStored(JSON.stringify({ v: 2, starSize: 3.5 }))).toEqual({ starSize: 3.5 });
  });
});

describe('star size slider', () => {
  it('spans 0.2x to 12x logarithmically with the default near 40 %', () => {
    expect(STAR_SIZE_MIN).toBe(0.2);
    expect(STAR_SIZE_MAX).toBe(12);
    expect(sliderToStarSize(0)).toBe(0.2);
    expect(sliderToStarSize(1)).toBe(12);
    expect(starSizeToSlider(DEFAULT_SETTINGS.starSize)).toBeCloseTo(Math.log(5) / Math.log(60), 6);
    // the geometric middle of the range is in the middle of the slider
    expect(sliderToStarSize(0.5)).toBeCloseTo(Math.sqrt(0.2 * 12), 2);
  });

  it('maps every size back to itself (rounded as displayed)', () => {
    for (const size of [0.2, 0.25, 0.5, 0.85, 1, 1.5, 2, 3.4, 8, 10, 12]) {
      expect(sliderToStarSize(starSizeToSlider(size))).toBe(size);
    }
    expect(starSizeToSlider(100)).toBe(1);
    expect(starSizeToSlider(0.01)).toBe(0);
  });

  it('keeps small sizes easy to set: 0.2x to 1x take almost 40 % of the slider', () => {
    expect(starSizeToSlider(1)).toBeGreaterThan(0.39);
    // every size from 0.20 to 1.00 in steps of 0.01 can be reached with the slider's 0.001 steps
    const sizes = new Set<number>();
    for (let k = 0; k <= 1000; k++) sizes.add(sliderToStarSize(k / 1000));
    for (let c = 20; c <= 100; c++) expect(sizes.has(c / 100)).toBe(true);
  });

  it('shows two decimals below 2x and one from 2x up', () => {
    expect(starSizeText(1)).toBe('1.00×');
    expect(starSizeText(0.85)).toBe('0.85×');
    expect(starSizeText(8)).toBe('8.0×');
    expect(starSizeText(12)).toBe('12.0×');
  });
});
