import { t } from '../i18n';
import { PLANET_SPEED_KEYS, PLANET_SPEEDS, planetSpeedStop } from '../settings';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * The speed of the planets, on the map while planets are to be seen (zoomed into a planetary
 * system): a slider with the stops of the setting (real time to ten years per second).
 */
export class PlanetTimeControl {
  readonly root = el('div', 'time-control hidden');
  private readonly input = el('input');
  private readonly value = el('span', 'time-value');
  private readonly icon = el('span', 'time-icon', '⏱');
  private shown = false;
  /** A stop of PLANET_SPEEDS was chosen. */
  onChange: (speed: number) => void = () => {};

  constructor(parent: HTMLElement) {
    this.input.type = 'range';
    this.input.min = '0';
    this.input.max = String(PLANET_SPEEDS.length - 1);
    this.input.step = '1';
    this.input.addEventListener('input', () => this.onChange(PLANET_SPEEDS[Number(this.input.value)]));
    this.icon.setAttribute('aria-hidden', 'true');
    this.root.append(this.icon, this.input, this.value);
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

  updateTexts(): void {
    this.input.setAttribute('aria-label', t('planetSpeed'));
    this.root.title = t('planetSpeed');
    this.set(PLANET_SPEEDS[Number(this.input.value)] ?? 0);
  }

  show(shown: boolean): void {
    if (shown === this.shown) return;
    this.shown = shown;
    this.root.classList.toggle('hidden', !shown);
  }
}
