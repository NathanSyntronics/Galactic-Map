import { Vector3 } from 'three';
import { galacticToWorld } from '../data/galactic';
import { formatLy, localName, t } from '../i18n';

/** [nameEn, nameDe | null, nodePath, localIndex, x, y, z, rank, alt designations] */
export type SearchTuple = [string, string | null, string, number, number, number, number, number, string[]?];

export interface SearchHit {
  nameEn: string;
  nameDe: string | null;
  path: string;
  index: number;
  pos: Vector3;
  rank: number;
  matched: string;
}

interface Entry {
  tuple: SearchTuple;
  keys: string[];
  pos: Vector3;
}

/**
 * Search key of a name: compatibility-decomposed (superscript ¹ -> 1, ligatures), without
 * diacritics, case, spaces, apostrophes, dots and all dash / minus variants, so "Rho1 Cancri"
 * finds "Rho¹ Cancri" and "2MASS 1507-1627" finds "2MASS 1507−1627".
 */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[\s'‘’ʼ`´\-‐‑‒–—―−⁃﹣－_.·\u00ad]/g, '');
}

export class SearchIndex {
  private entries: Entry[] = [];

  load(tuples: SearchTuple[]): void {
    this.entries = tuples.map((tuple) => {
      const [en, de, , , x, y, z, , alt] = tuple;
      const keys = [en, ...(de ? [de] : []), ...(alt ?? [])].map(normalize);
      return { tuple, keys, pos: galacticToWorld(x, y, z) };
    });
  }

  get size(): number {
    return this.entries.length;
  }

  query(q: string, limit = 12): SearchHit[] {
    const nq = normalize(q);
    if (!nq) return [];
    const hits: { e: Entry; score: number; key: number }[] = [];
    for (const e of this.entries) {
      // the displayed names (English, German) come first in keys, then the other designations
      const shown = e.tuple[1] ? 2 : 1;
      let best = -1;
      let bestKey = 0;
      for (let k = 0; k < e.keys.length; k++) {
        const key = e.keys[k];
        let s = -1;
        if (key === nq) s = 3;
        else if (key.startsWith(nq)) s = 2;
        else if (nq.length >= 3 && key.includes(nq)) s = 1;
        if (s > best) {
          best = s;
          bestKey = k;
        }
      }
      if (best < 0) continue;
      // a match on the displayed name beats an equally good match on another designation
      // ('alpha centauri': Alpha Centauri A before Proxima Centauri, alias 'Alpha Centauri C')
      const shownBonus = bestKey < shown ? 40 : 0;
      hits.push({ e, score: best * 100 + shownBonus - e.tuple[7] * 5 - e.keys[0].length * 0.1, key: bestKey });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit).map(({ e, key }) => {
      const [en, de, path, index, , , , rank, alt] = e.tuple;
      const names = [en, ...(de ? [de] : []), ...(alt ?? [])];
      return { nameEn: en, nameDe: de, path, index, pos: e.pos, rank, matched: names[key] };
    });
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Search box with a result dropdown. */
export class SearchBox {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly list: HTMLUListElement;
  private hits: SearchHit[] = [];
  private active = 0;
  onPick: (hit: SearchHit) => void = () => {};
  onFocus: () => void = () => {};

  constructor(
    parent: HTMLElement,
    private readonly index: SearchIndex,
  ) {
    this.root = el('div', 'search');
    this.input = el('input');
    this.input.type = 'search';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.list = el('ul', 'results hidden');
    this.root.append(this.input, this.list);
    parent.appendChild(this.root);
    this.updateTexts();

    this.input.addEventListener('focus', () => this.onFocus());
    this.input.addEventListener('input', () => this.update());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        this.active = Math.min(this.active + 1, this.hits.length - 1);
        this.renderList();
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        this.active = Math.max(this.active - 1, 0);
        this.renderList();
        e.preventDefault();
      } else if (e.key === 'Enter') {
        const hit = this.hits[this.active];
        if (hit) this.pick(hit);
        e.preventDefault();
      } else if (e.key === 'Escape') {
        this.clear();
        this.input.blur();
      }
    });
    this.input.addEventListener('blur', () => setTimeout(() => this.list.classList.add('hidden'), 150));
  }

  updateTexts(): void {
    this.input.placeholder = t('search');
    this.input.setAttribute('aria-label', t('search'));
    if (!this.list.classList.contains('hidden')) this.renderList();
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  update(): void {
    this.hits = this.index.query(this.input.value);
    this.active = 0;
    this.renderList();
  }

  private clear(): void {
    this.input.value = '';
    this.hits = [];
    this.renderList();
  }

  private pick(hit: SearchHit): void {
    this.onPick(hit);
    this.clear();
    this.input.blur();
  }

  private renderList(): void {
    this.list.replaceChildren();
    const q = this.input.value.trim();
    if (!q) {
      this.list.classList.add('hidden');
      return;
    }
    this.list.classList.remove('hidden');
    if (this.hits.length === 0) {
      this.list.appendChild(el('li', 'empty', this.index.size === 0 ? t('loading') : t('noResults')));
      return;
    }
    this.hits.forEach((h, i) => {
      const li = el('li', i === this.active ? 'active' : '');
      const name = localName(h.nameEn, h.nameDe);
      li.appendChild(el('span', 'name', name));
      const meta = h.matched !== name && h.matched !== h.nameEn ? `${h.matched} · ` : '';
      li.appendChild(el('span', 'meta', `${meta}${formatLy(h.pos.length())}`));
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.pick(h);
      });
      this.list.appendChild(li);
    });
  }
}
