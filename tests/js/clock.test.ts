import { describe, expect, it } from 'vitest';
import { daysPerSecond } from '../../src/settings';
import { formatClockDate, isoDay, jdOfPickedDay, msOfJd } from '../../src/ui/time-control';

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
