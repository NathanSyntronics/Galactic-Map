import type { AttributeStore } from '../data/attributes';
import { formatNumber, t, type MessageKey } from '../i18n';
import {
  MISSING_COLOR,
  SIZE_LUMINOSITY,
  SIZE_UNIFORM,
  attributeInfo,
  categoryColors,
  numericScale,
  paletteGradient,
  type AttributeInfo,
} from '../render/style';
import type { Settings } from '../settings';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A number with about three significant digits in the current language. */
export function formatValue(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 100) return formatNumber(v, 0);
  if (a >= 10) return formatNumber(v, 1);
  if (a >= 1) return formatNumber(v, 2);
  return formatNumber(v, Math.min(Math.ceil(-Math.log10(a)) + 1, 8));
}

export function attributeLabel(info: AttributeInfo): string {
  return info.builtin ? t(info.name as MessageKey) : info.name;
}

const MAX_CATEGORIES = 12;

/** Legend of the data layers (bottom left), shown while the map is coloured or sized by an attribute. */
export class Legend {
  readonly root: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'legend hidden');
    parent.appendChild(this.root);
  }

  update(s: Settings, store: AttributeStore): void {
    this.root.replaceChildren();
    const color = s.colorBy ? attributeInfo(s.colorBy, store) : null;
    const size = s.sizeBy !== SIZE_LUMINOSITY && s.sizeBy !== SIZE_UNIFORM ? attributeInfo(s.sizeBy, store) : null;
    const show = s.legend && (color || (size && size.type === 'number'));
    this.root.classList.toggle('hidden', !show);
    if (!show) return;

    if (color) {
      this.root.appendChild(el('div', 'legend-title', attributeLabel(color)));
      if (color.type === 'number') {
        const sc = numericScale(color.id, store);
        const bar = el('div', 'legend-bar');
        bar.style.background = paletteGradient(sc.palette ?? 'turbo', sc.reverse);
        const ends = el('div', 'legend-ends');
        ends.append(el('span', '', formatValue(sc.min)), el('span', '', sc.log ? 'log' : ''), el('span', '', formatValue(sc.max)));
        this.root.append(bar, ends);
      } else if (color.type === 'text') {
        const cats = [...categoryColors(color.id, store)];
        const list = el('ul', 'legend-cats');
        for (const [name, css] of cats.slice(0, MAX_CATEGORIES)) list.appendChild(this.swatch(css, name));
        if (cats.length > MAX_CATEGORIES) list.appendChild(el('li', 'more', t('moreCategories', { n: cats.length - MAX_CATEGORIES })));
        this.root.appendChild(list);
      } else {
        const list = el('ul', 'legend-cats');
        list.appendChild(el('li', 'more', t('legendColorValues')));
        this.root.appendChild(list);
      }
    }
    if (size && size.type === 'number') {
      const sc = numericScale(size.id, store);
      const row = el('div', 'legend-size');
      row.append(
        el('span', 'legend-size-title', t('legendSize', { name: attributeLabel(size) })),
        el('span', 'dot small'),
        el('span', '', formatValue(sc.reverse ? sc.max : sc.min)),
        el('span', 'dot large'),
        el('span', '', formatValue(sc.reverse ? sc.min : sc.max)),
      );
      this.root.appendChild(row);
    }
    if (s.missingStyle === 'dim') {
      const list = el('ul', 'legend-cats');
      list.appendChild(this.swatch(MISSING_COLOR, t('noValue')));
      this.root.appendChild(list);
    }
  }

  private swatch(css: string, label: string): HTMLElement {
    const li = el('li');
    const sw = el('span', 'swatch');
    sw.style.background = css;
    li.append(sw, el('span', '', label));
    return li;
  }
}
