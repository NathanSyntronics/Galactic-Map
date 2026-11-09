import { formatNumber, getLang, t } from '../i18n';
import { PLANET_SPEED_KEYS, PLANET_SPEEDS, planetSpeedStop } from '../settings';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Julian date of a JavaScript time (ms since 1970). */
const jdOfMs = (ms: number) => ms / 86_400_000 + 2440587.5;
/** JavaScript time (ms since 1970) of a Julian date. */
export const msOfJd = (jd: number) => (jd - 2440587.5) * 86_400_000;

/** The dates the picker offers (beyond, a year can be typed; the planets' orbits are approximations beyond a few centuries). */
export const DATE_MIN = '0001-01-01';
export const DATE_MAX = '9999-12-31';

/** How far the clock goes: two million years either way (the stars move in straight lines). */
export const CLOCK_YEARS = 2_000_000;
export const CLOCK_MIN_JD = 2451545 - CLOCK_YEARS * 365.25;
export const CLOCK_MAX_JD = 2451545 + CLOCK_YEARS * 365.25;

/** The (astronomical) year of a Julian date: 0 is 1 BC. */
export function yearOfJd(jd: number): number {
  return Math.floor(2000 + (jd - 2451545) / 365.25);
}

/**
 * A typed year: "52026", "52.026", "-50000" (astronomical), "50000 v. Chr." or "50000 BC" (1 BC is
 * year 0); null if there is no number in it.
 */
export function parseYear(text: string): number | null {
  const s = text.toLowerCase().replace(/[−–]/g, '-');
  const bc = /v\.?\s*chr|\bbce?\b|v\.?\s*u\.?\s*z/.test(s);
  const m = /(-?)\s*([\d.,'’\s]*\d)/.exec(s);
  if (!m) return null;
  const n = Number(m[2].replace(/[^\d]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (bc) return 1 - n;
  return m[1] ? -n : n;
}

/** "2026-11-07" of a date, in local time (the picker's format). */
export function isoDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The Julian date of a picked day ("2026-11-07") at the time of day of `nowMs` (local); null if invalid. */
export function jdOfPickedDay(value: string, nowMs: number): number | null {
  const m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const now = new Date(nowMs);
  const d = new Date(nowMs);
  d.setFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);
  return Number.isFinite(d.getTime()) ? jdOfMs(d.getTime()) : null;
}

/** "10.000 Jahre pro Sekunde" -> "10.000 Jahre/s" (the clock's short form of a speed). */
export function shortSpeed(text: string): string {
  return text.replace(/ (pro Sekunde|per second)$/, '/s');
}

const formats = new Map<string, Intl.DateTimeFormat>();

/**
 * A date as the map shows it ("7. Nov. 2026", with the time of day: "7. Nov. 2026, 20:16"); far
 * from now only the year ("Jahr 52.026", "50.000 v. Chr.").
 */
export function formatClockDate(jd: number, withTime: boolean, lang = getLang()): string {
  const year = yearOfJd(jd);
  if (!Number.isFinite(year)) return '';
  if (year < 1) return t('yearBC', { n: formatNumber(1 - year) });
  if (year > 9999) return t('yearN', { n: formatNumber(year) });
  const key = `${lang}:${withTime}`;
  let f = formats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(lang, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
    formats.set(key, f);
  }
  const ms = msOfJd(jd);
  return Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? f.format(new Date(ms)) : '';
}

/**
 * The clock of the stars, planets and spacecraft on the map: the date drawn (a tap on it lets a
 * year be typed), a button back to now, a date picker and the speed (a slider with the stops of
 * the setting, from real time, one second per second, to 100,000 years per second).
 */
export class PlanetTimeControl {
  readonly root = el('div', 'time-control hidden');
  private readonly date = el('button', 'time-date');
  private readonly year = el('input', 'time-year hidden');
  private readonly now = el('button', 'btn subtle time-now');
  private readonly pickWrap = el('span', 'btn subtle time-pick');
  private readonly picker = el('input');
  private readonly input = el('input');
  private readonly value = el('span', 'time-value');
  private readonly icon = el('span', 'time-icon', '⏱');
  private shown = false;
  private atNow = true;
  private jd = jdOfMs(Date.now());
  /** A stop of PLANET_SPEEDS was chosen. */
  onChange: (speed: number) => void = () => {};
  /** Back to the present (the speed stays). */
  onNow: () => void = () => {};
  /** A date was picked (Julian date). */
  onDate: (jd: number) => void = () => {};
  /** A year was typed (astronomical: 0 is 1 BC). */
  onYear: (year: number) => void = () => {};

  constructor(parent: HTMLElement) {
    const dateRow = el('div', 'time-row');
    this.date.setAttribute('aria-live', 'off');
    this.date.type = 'button';
    // a tap on the date: a year to type (also far in the past or future)
    this.year.type = 'text';
    this.year.inputMode = 'text';
    this.year.autocomplete = 'off';
    let editing = false;
    const close = (apply: boolean) => {
      if (!editing) return;
      editing = false;
      const y = parseYear(this.year.value);
      this.year.classList.add('hidden');
      this.date.classList.remove('hidden');
      if (apply && y !== null) this.onYear(y);
    };
    this.date.addEventListener('click', () => {
      editing = true;
      this.year.value = String(yearOfJd(this.jd));
      this.date.classList.add('hidden');
      this.year.classList.remove('hidden');
      this.year.focus();
      this.year.select();
    });
    this.year.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(true);
      else if (e.key === 'Escape') close(false);
    });
    this.year.addEventListener('blur', () => close(true));
    this.now.type = 'button';
    this.now.classList.add('hidden');
    this.now.addEventListener('click', () => this.onNow());
    // the picker lies over its button: a tap opens the device's own date picker
    this.picker.type = 'date';
    this.picker.min = DATE_MIN;
    this.picker.max = DATE_MAX;
    this.picker.className = 'time-picker';
    this.pickWrap.append(el('span', '', '📅'), this.picker);
    // it opens at the date drawn
    const preset = () => {
      const day = isoDay(msOfJd(this.jd));
      this.picker.value = day < DATE_MIN ? DATE_MIN : day > DATE_MAX ? DATE_MAX : day;
    };
    this.picker.addEventListener('pointerdown', preset);
    this.picker.addEventListener('focus', preset);
    this.picker.addEventListener('click', () => {
      try {
        this.picker.showPicker?.();
      } catch {
        // not allowed here: the browser opens it its own way
      }
    });
    this.picker.addEventListener('change', () => {
      const jd = jdOfPickedDay(this.picker.value, Date.now());
      if (jd !== null) this.onDate(jd);
    });
    dateRow.append(this.date, this.year, this.now, this.pickWrap);

    const speedRow = el('div', 'time-row');
    this.input.type = 'range';
    this.input.min = '0';
    this.input.max = String(PLANET_SPEEDS.length - 1);
    this.input.step = '1';
    this.input.className = 'time-speed';
    this.input.addEventListener('input', () => this.onChange(PLANET_SPEEDS[Number(this.input.value)]));
    this.icon.setAttribute('aria-hidden', 'true');
    speedRow.append(this.icon, this.input, this.value);
    this.root.append(dateRow, speedRow);
    parent.prepend(this.root);
    this.updateTexts();
  }

  /** The speed shown (days per second). */
  set(speed: number): void {
    const k = planetSpeedStop(speed);
    if (this.input.value !== String(k)) this.input.value = String(k);
    // short ("10.000 Jahre/s"), in a box of fixed width: the slider keeps its size
    const text = shortSpeed(t(PLANET_SPEED_KEYS[k]));
    this.value.title = t(PLANET_SPEED_KEYS[k]);
    if (this.value.textContent !== text) this.value.textContent = text;
  }

  /**
   * The date drawn (per frame; the text changes only when it does): `atNow` hides the button back
   * to now; the time of day is shown while the clock runs slowly enough to read it.
   */
  update(jd: number, atNow: boolean, speed: number): void {
    this.jd = jd;
    if (!this.shown) return;
    const text = formatClockDate(jd, speed <= 1 / 24);
    if (this.date.textContent !== text) this.date.textContent = text;
    if (atNow !== this.atNow) {
      this.atNow = atNow;
      this.now.classList.toggle('hidden', atNow);
    }
  }

  updateTexts(): void {
    this.input.setAttribute('aria-label', t('planetSpeed'));
    this.root.title = t('planetSpeed');
    this.now.textContent = t('timeNow');
    this.now.title = t('timeNowHint');
    this.pickWrap.title = t('timePick');
    this.picker.setAttribute('aria-label', t('timePick'));
    this.date.title = t('timeYear');
    this.year.placeholder = t('timeYear');
    this.year.setAttribute('aria-label', t('timeYear'));
    this.date.textContent = '';
    this.set(PLANET_SPEEDS[Number(this.input.value)] ?? 0);
  }

  show(shown: boolean): void {
    if (shown === this.shown) return;
    this.shown = shown;
    this.root.classList.toggle('hidden', !shown);
  }
}
