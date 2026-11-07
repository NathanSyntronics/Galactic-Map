import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { daysPerSecond } from '../../src/settings';
import { formatClockDate, isoDay, jdOfPickedDay, msOfJd } from '../../src/ui/time-control';
import { TINT_BONUS, labelScore, mergeSystems, type LabelCandidate, type ScreenLabel } from '../../src/ui/labels';

describe('the planets clock', () => {
  it('runs one second per second in real time, else at the chosen speed', () => {
    expect(daysPerSecond(0) * 86_400).toBeCloseTo(1, 12);
    expect(daysPerSecond(30)).toBe(30);
  });

  it('takes a picked day at the time of day of now', () => {
    const now = new Date(2026, 10, 7, 20, 16, 5).getTime();
    const jd = jdOfPickedDay('2046-11-07', now)!;
    const d = new Date(msOfJd(jd));
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2046, 10, 7, 20, 16]);
    expect(isoDay(msOfJd(jd))).toBe('2046-11-07');
    expect(jdOfPickedDay('', now)).toBeNull();
    expect(jdOfPickedDay('7.11.2046', now)).toBeNull();
  });

  it('writes the date, with the time of day when asked', () => {
    const jd = 2461352.5; // 2026-11-07 00:00 UTC
    expect(formatClockDate(jd, false, 'en')).toMatch(/2026/);
    expect(formatClockDate(jd, true, 'de').length).toBeGreaterThan(formatClockDate(jd, false, 'de').length);
    expect(formatClockDate(Number.NaN, false, 'en')).toBe('');
  });
});

describe('marked star names', () => {
  const cand = (key: string, extra: Partial<LabelCandidate> = {}): LabelCandidate => ({ key, pos: new Vector3(), text: key, rank: 1, logL: 0, ...extra });
  const screen = (c: LabelCandidate, x = 0): ScreenLabel => ({ c, score: 0, x, y: 0, fade: 1, text: c.text });

  it('labels marked stars before others', () => {
    expect(labelScore(cand('a', { tint: 'planets' }), 10) - labelScore(cand('a'), 10)).toBe(TINT_BONUS);
  });

  it('keeps the colour of a component merged into its system label', () => {
    const a = screen(cand('Alpha Centauri A', { sys: 1 }));
    const p = screen(cand('Proxima Centauri', { sys: 1, tint: 'habitable' }), 1);
    const [only] = mergeSystems([a, p], null);
    expect(only.tint).toBe('habitable');
    const plain = mergeSystems([screen(cand('x', { sys: 2 }))], null);
    expect(plain[0].tint).toBeUndefined();
  });
});
