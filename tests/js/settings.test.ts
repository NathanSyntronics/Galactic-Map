import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLang } from '../../src/i18n';
import {
  AUTO_RADIUS_RATIO,
  DEFAULT_SETTINGS,
  RADIUS_MAX,
  RADIUS_MIN,
  SAVE_DELAY_MS,
  STAR_SIZE_MAX,
  STAR_SIZE_MIN,
  SettingsStore,
  distanceForRadius,
  followZoom,
  parseStored,
  radiusForDistance,
  sliderToStarSize,
  starDetail,
  starDimming,
  starLabelMode,
  starsHidden,
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

  it('hides the legend by default', () => {
    expect(DEFAULT_SETTINGS.legend).toBe(false);
  });

  it('dims the stars and drops their labels at galaxy scales', () => {
    expect(starDimming(20)).toBe(1);
    expect(starDimming(12_000)).toBe(1);
    expect(starDimming(24_000)).toBeCloseTo(Math.pow(0.5, 2.5), 6);
    expect(starDimming(150_000)).toBeLessThan(0.002);
    expect(starDimming(2_000_000)).toBeLessThan(1e-5);
    expect(starLabelMode(20)).toBe('all');
    expect(starLabelMode(30_000)).toBe('all');
    expect(starLabelMode(150_000)).toBe('sun');
    expect(starLabelMode(2_000_000)).toBe('none');
  });

  it('loads fewer stars while they fade and none once they are gone', () => {
    expect(starDetail(12_000)).toBe(1);
    expect(starDetail(20_000)).toBeCloseTo(Math.sqrt(starDimming(20_000)), 6);
    expect(starDetail(40_000)).toBe(0.25);
    expect(starsHidden(50_000)).toBe(false);
    expect(starsHidden(60_000)).toBe(true);
    // stars are hidden before the Sun's label stands alone, and the Sun keeps it beyond
    expect(starLabelMode(60_000)).toBe('sun');
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

  it('writes the star size with a decimal comma in German', () => {
    // setLang marks the page language
    vi.stubGlobal('document', { documentElement: {} });
    setLang('de');
    try {
      expect(starSizeText(1)).toBe('1,00×');
      expect(starSizeText(12)).toBe('12,0×');
    } finally {
      setLang('en');
      vi.unstubAllGlobals();
    }
  });
});

describe('radius follows zoom', () => {
  it('is on by default and matches the default view (radius 20 ly at 44 ly distance)', () => {
    expect(DEFAULT_SETTINGS.autoRadius).toBe(true);
    expect(AUTO_RADIUS_RATIO).toBe(2.2);
    expect(radiusForDistance(44)).toBe(20);
    expect(distanceForRadius(20)).toBeCloseTo(44, 10);
  });

  it('clamps to the radius range and keeps three significant digits', () => {
    expect(radiusForDistance(0.5)).toBe(RADIUS_MIN);
    expect(radiusForDistance(1e10)).toBe(RADIUS_MAX);
    expect(radiusForDistance(1e7)).toBe(4_550_000);
    expect(radiusForDistance(100)).toBe(45.5);
    expect(radiusForDistance(12345)).toBe(5610);
    expect(radiusForDistance(7)).toBe(3.18);
  });

  it('maps a radius set on the slider to a distance that gives the same radius back', () => {
    // the slider rounds to two significant digits
    for (const r of [2, 2.5, 9.9, 20, 47, 130, 1200, 50_000]) expect(radiusForDistance(distanceForRadius(r))).toBe(r);
    for (const r of [2, 20, 130, 50_000]) expect(followZoom(r, distanceForRadius(r))).toBeNull();
  });

  it('changes the radius only when it is off by more than 1 %', () => {
    expect(followZoom(20, 44.3)).toBeNull();
    expect(followZoom(20, 43.7)).toBeNull();
    expect(followZoom(20, 45)).toBe(20.5);
    expect(followZoom(20, 43)).toBe(19.5);
    // closer than the smallest radius allows: stays at the minimum
    expect(followZoom(RADIUS_MIN, 1)).toBeNull();
  });

  it('follows a continuous zoom in small, regular steps', () => {
    let radius = 20;
    let changes = 0;
    let maxStep = 0;
    // zoom out from 44 to 4400 ly in 0.2 % steps (about 2,300 frames), then back in
    const frames: number[] = [];
    for (let d = 44; d < 4400; d *= 1.002) frames.push(d);
    for (let d = 4400; d > 44; d /= 1.002) frames.push(d);
    for (const d of frames) {
      const r = followZoom(radius, d);
      if (r === null) continue;
      maxStep = Math.max(maxStep, Math.abs(Math.log(r / radius)));
      radius = r;
      changes++;
    }
    // about one change per 1 % of zoom, never a jump
    expect(changes).toBeGreaterThan(600);
    expect(changes).toBeLessThan(1000);
    expect(maxStep).toBeLessThan(0.02);
    expect(Math.abs(radius / 20 - 1)).toBeLessThan(0.0151);
  });
});

describe('settings store', () => {
  let writes: string[];
  let narrow = false;
  let handlers: Record<string, () => void>;
  beforeEach(() => {
    vi.useFakeTimers();
    writes = [];
    handlers = {};
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => {
        items.set(k, v);
        writes.push(v);
      },
      removeItem: (k: string) => items.delete(k),
    });
    narrow = false;
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: () => void) => (handlers[type] = fn),
      matchMedia: () => ({ matches: narrow }),
    });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: (type: string, fn: () => void) => (handlers[type] = fn),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('writes the settings once the changes pause, not on every change', () => {
    const store = new SettingsStore();
    const seen: number[] = [];
    store.subscribe((s) => seen.push(s.radius));
    // a zoom: 60 radius changes, one per frame
    for (let k = 1; k <= 60; k++) {
      store.set({ radius: 20 + k });
      vi.advanceTimersByTime(16);
    }
    expect(seen.length).toBe(60);
    expect(writes.length).toBe(0);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(writes.length).toBe(1);
    expect(JSON.parse(writes[0])).toEqual({ v: 2, radius: 80 });
    vi.advanceTimersByTime(5000);
    expect(writes.length).toBe(1);
  });

  it('writes a pending change when the page is hidden or left', () => {
    const store = new SettingsStore();
    store.set({ grid: false });
    (document as { visibilityState: string }).visibilityState = 'hidden';
    handlers.visibilitychange();
    expect(writes.map((w) => JSON.parse(w))).toEqual([{ v: 2, grid: false }]);
    store.set({ grid: true });
    handlers.pagehide();
    expect(writes.length).toBe(2);
    expect(JSON.parse(writes[1])).toEqual({ v: 2 });
    // nothing pending: nothing written
    handlers.pagehide();
    vi.advanceTimersByTime(SAVE_DELAY_MS * 2);
    expect(writes.length).toBe(2);
  });

  it('reads back what it wrote', () => {
    const store = new SettingsStore();
    store.set({ autoRadius: false, radius: 130 });
    store.flush();
    expect(new SettingsStore().get()).toMatchObject({ autoRadius: false, radius: 130 });
  });

  it('never stores the defaults of a narrow window, so a zoom does not keep them for wide ones', () => {
    narrow = true;
    const phone = new SettingsStore();
    expect(phone.get()).toMatchObject({ quality: 'low', labelCount: 25 });
    phone.set({ radius: 24.2 });
    phone.flush();
    expect(JSON.parse(writes.at(-1)!)).toEqual({ v: 2, radius: 24.2 });
    narrow = false;
    expect(new SettingsStore().get()).toMatchObject({ quality: 'medium', labelCount: 30, radius: 24.2 });
    // a chosen value is stored, also on a phone
    narrow = true;
    const again = new SettingsStore();
    expect(again.get()).toMatchObject({ quality: 'low', radius: 24.2 });
    again.set({ quality: 'medium' });
    again.flush();
    expect(JSON.parse(writes.at(-1)!)).toEqual({ v: 2, radius: 24.2, quality: 'medium' });
    narrow = false;
    expect(new SettingsStore().get().quality).toBe('medium');
  });

  it('writes only its own changes, so an older tab keeps what another tab changed', () => {
    const tabB = new SettingsStore();
    const tabA = new SettingsStore();
    tabA.set({ starSize: 8, lang: 'de' });
    tabA.flush();
    // tab B, opened before, only zooms
    tabB.set({ radius: 437 });
    tabB.flush();
    expect(JSON.parse(writes.at(-1)!)).toEqual({ v: 2, starSize: 8, lang: 'de', radius: 437 });
    // a value set back to the default is removed
    tabB.set({ radius: 20 });
    tabB.flush();
    expect(JSON.parse(writes.at(-1)!)).toEqual({ v: 2, starSize: 8, lang: 'de' });
  });

  it('turns a stored first-format record into a diff when writing', () => {
    localStorage.setItem('galactic-map:settings:v1', JSON.stringify({ ...DEFAULT_SETTINGS, grid: false }));
    const store = new SettingsStore();
    store.set({ starSize: 2 });
    store.flush();
    expect(JSON.parse(writes.at(-1)!)).toEqual({ v: 2, grid: false, starSize: 2 });
  });

  it('resets every setting but the language and tells listeners about all of them', () => {
    const store = new SettingsStore();
    store.set({ autoRadius: false, radius: 20, starSize: 3, lang: 'de' });
    store.flush();
    let changed: string[] = [];
    store.subscribe((_, c) => (changed = c));
    store.reset();
    expect(store.get()).toEqual({ ...DEFAULT_SETTINGS, lang: 'de' });
    // the radius was already the default: still reported, so the camera goes back to 44 ly
    expect(changed).toContain('radius');
    expect(changed).toContain('autoRadius');
    expect(changed).not.toContain('lang');
    store.flush();
    expect(JSON.parse(writes.at(-1)!)).toEqual({ v: 2, lang: 'de' });
  });
});
