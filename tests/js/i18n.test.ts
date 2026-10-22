import { afterAll, describe, expect, it } from 'vitest';
import { jumpStatsText, setLang } from '../../src/i18n';

// setLang marks the page language
(globalThis as { document?: unknown }).document ??= { documentElement: {} };

describe('jump network status line', () => {
  afterAll(() => setLang('en'));

  it('uses singular forms in English', () => {
    setLang('en');
    expect(jumpStatsText(7, 1)).toBe('1 star or system in view, 7 links');
    expect(jumpStatsText(1, 2)).toBe('2 stars and systems in view, 1 link');
    expect(jumpStatsText(12345, 6789)).toBe('6,789 stars and systems in view, 12,345 links');
    expect(jumpStatsText(0, 0)).toBe('0 stars and systems in view, 0 links');
  });

  it('uses singular forms in German', () => {
    setLang('de');
    expect(jumpStatsText(7, 1)).toBe('1 Stern oder System sichtbar, 7 Verbindungen');
    expect(jumpStatsText(1, 2)).toBe('2 Sterne und Systeme sichtbar, 1 Verbindung');
    expect(jumpStatsText(12345, 6789)).toBe('6.789 Sterne und Systeme sichtbar, 12.345 Verbindungen');
  });
});
