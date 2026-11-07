import { getLang, t } from '../i18n';
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

/** The dates the picker offers (the planets' orbits are approximations beyond a few centuries). */
export const DATE_MIN = '1000-01-01';
export const DATE_MAX = '3000-12-31';

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

const formats = new Map<string, Intl.DateTimeFormat>();

/** A date as the map shows it ("7. Nov. 2026", with the time of day: "7. Nov. 2026, 20:16"). */
export function formatClockDate(jd: number, withTime: boolean, lang = getLang()): string {
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
 * The planets' clock on the map, while planets or spacecraft are to be seen: the date drawn, a
 * button back to now, a date picker and the speed (a slider with the stops of the setting, from
 * real time, one second per second, to ten years per second).
 */
export class PlanetTimeControl {
  readonly root = el('div', 'time-control hidden');
  private readonly date = el('span', 'time-date');
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

  constructor(parent: HTMLElement) {
    const dateRow = el('div', 'time-row');
    this.date.setAttribute('aria-live', 'off');
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
    dateRow.append(this.date, this.now, this.pickWrap);

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
    const text = t(PLANET_SPEED_KEYS[k]);
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
    this.date.textContent = '';
    this.set(PLANET_SPEEDS[Number(this.input.value)] ?? 0);
  }

  show(shown: boolean): void {
    if (shown === this.shown) return;
    this.shown = shown;
    this.root.classList.toggle('hidden', !shown);
  }
}
