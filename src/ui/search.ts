import { Vector3 } from 'three';
import { galacticToWorld } from '../data/galactic';
import { formatLy, localName, t } from '../i18n';
import { addRecent, readRecent, resolveRecent, sameRecent, writeRecent, type RecentSearch } from './recent';

/**
 * [nameEn, nameDe | null, nodePath, localIndex, x, y, z, rank, alt designations | null,
 *  primary designation, system id (-1: single star)]
 */
export type SearchTuple = [
  string,
  string | null,
  string,
  number,
  number,
  number,
  number,
  number,
  (string[] | null)?,
  string?,
  number?,
];

export interface SearchHit {
  nameEn: string;
  nameDe: string | null;
  path: string;
  index: number;
  pos: Vector3;
  rank: number;
  matched: string;
  /** Primary designation (key of the recent searches); null in entries without one. */
  designation: string | null;
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
  /** Exact-key lookup (normalised name or designation -> entry), built on first use. */
  private exact: Map<string, SearchTuple> | null = null;
  private byDesignation: Map<string, SearchTuple> | null = null;

  load(tuples: SearchTuple[]): void {
    this.exact = null;
    this.byDesignation = null;
    this.entries = tuples.map((tuple) => {
      const [en, de, , , x, y, z, , alt] = tuple;
      const keys = [en, ...(de ? [de] : []), ...(alt ?? [])].map(normalize);
      return { tuple, keys, pos: galacticToWorld(x, y, z) };
    });
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * The star that a name or designation names exactly (any spelling the search accepts), or
   * null. Primary designations win over displayed names, displayed names over other designations.
   */
  find(key: string): SearchTuple | null {
    if (!this.exact) {
      const m = new Map<string, SearchTuple>();
      const put = (k: string | null | undefined, tuple: SearchTuple) => {
        if (!k) return;
        const n = normalize(k);
        if (n && !m.has(n)) m.set(n, tuple);
      };
      for (const { tuple } of this.entries) put(tuple[9], tuple);
      for (const { tuple } of this.entries) {
        put(tuple[0], tuple);
        put(tuple[1], tuple);
      }
      for (const { tuple } of this.entries) for (const a of tuple[8] ?? []) put(a, tuple);
      this.exact = m;
    }
    return this.exact.get(normalize(key)) ?? null;
  }

  /** The entry of a star by its primary designation (named stars only). */
  byPrimary(designation: string): SearchTuple | null {
    if (!this.byDesignation) {
      this.byDesignation = new Map();
      for (const { tuple } of this.entries) if (tuple[9]) this.byDesignation.set(tuple[9], tuple);
    }
    return this.byDesignation.get(designation) ?? null;
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
      const [en, de, , , , , , , alt] = e.tuple;
      const names = [en, ...(de ? [de] : []), ...(alt ?? [])];
      return hitOf(e.tuple, names[key], e.pos);
    });
  }
}

/** Search hit of an index entry (matched: the name that matched, by default the English name). */
export function hitOf(tuple: SearchTuple, matched = tuple[0], pos?: Vector3): SearchHit {
  const [en, de, path, index, x, y, z, rank, , designation] = tuple;
  return {
    nameEn: en,
    nameDe: de,
    path,
    index,
    pos: pos ?? galacticToWorld(x, y, z),
    rank,
    matched,
    designation: designation ?? null,
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** One row of the dropdown: a search result or a recent search. */
interface Row {
  name: string;
  meta: string;
  pick: () => void;
}

/**
 * Search box with a result dropdown. While the field is empty, the dropdown lists the stars last
 * picked from the results (newest first).
 */
export class SearchBox {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly list: HTMLUListElement;
  private rows: Row[] = [];
  /** What the dropdown shows. */
  private mode: 'none' | 'results' | 'recent' = 'none';
  private active = 0;
  private recent: RecentSearch[] = readRecent();
  onPick: (hit: SearchHit) => void = () => {};
  /** Loads the search index (called on focus; awaited by a recent search picked before it is loaded). */
  loadIndex: () => Promise<void> = async () => {};

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

    this.input.addEventListener('focus', () => {
      void this.loadIndex();
      if (!this.input.value.trim()) this.showRecent();
    });
    // a click into the focused field brings the recent searches back (e.g. after Escape)
    this.input.addEventListener('click', () => {
      if (!this.input.value.trim() && this.mode === 'none') this.showRecent();
    });
    this.input.addEventListener('input', () => this.update());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        if (this.mode === 'none' && !this.input.value.trim()) this.showRecent();
        else this.active = Math.min(this.active + 1, this.rows.length - 1);
        this.renderList();
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        this.active = Math.max(this.active - 1, 0);
        this.renderList();
        e.preventDefault();
      } else if (e.key === 'Enter') {
        this.rows[this.active]?.pick();
        e.preventDefault();
      } else if (e.key === 'Escape') {
        if (this.mode === 'recent') this.hide();
        else {
          this.clear();
          this.input.blur();
        }
      }
    });
    this.input.addEventListener('blur', () => {
      setTimeout(() => {
        if (document.activeElement !== this.input) this.hide();
      }, 150);
    });
  }

  updateTexts(): void {
    this.input.placeholder = t('search');
    this.input.setAttribute('aria-label', t('search'));
    if (this.mode === 'recent') this.showRecent(false);
    else if (this.mode !== 'none') this.renderList();
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  /** The search index has been loaded: drop stale recent searches, refresh the dropdown. */
  indexLoaded(): void {
    this.resolveRecent();
    if (this.input.value.trim()) this.update();
    else if (this.mode === 'recent') this.showRecent(false);
  }

  /** The recent searches looked up in the loaded index (current names; stale entries dropped and forgotten). */
  private resolveRecent(): ReturnType<typeof resolveRecent> {
    const resolved = resolveRecent(this.recent, (d) => this.index.byPrimary(d));
    const current = resolved.map((r) => r.entry);
    if (!sameRecent(current, this.recent)) {
      this.recent = current;
      writeRecent(current);
    }
    return resolved;
  }

  update(): void {
    if (!this.input.value.trim()) {
      if (document.activeElement === this.input) this.showRecent();
      else this.hide();
      return;
    }
    this.mode = 'results';
    this.rows = this.index.query(this.input.value).map((h) => {
      const name = localName(h.nameEn, h.nameDe);
      const meta = h.matched !== name && h.matched !== h.nameEn ? `${h.matched} · ` : '';
      return { name, meta: `${meta}${formatLy(h.pos.length())}`, pick: () => this.pick(h) };
    });
    this.active = 0;
    this.renderList();
  }

  /**
   * Lists the recent searches (nothing when there are none). Once the index is loaded they are
   * looked up in it: names and distances are current, and stars it no longer has are dropped.
   */
  private showRecent(resetActive = true): void {
    if (this.index.size > 0) {
      this.rows = this.resolveRecent().map(({ entry, tuple }) => {
        const hit = hitOf(tuple);
        return { name: localName(entry.nameEn, entry.nameDe), meta: formatLy(hit.pos.length()), pick: () => this.pick(hit) };
      });
    } else {
      this.rows = this.recent.map((entry) => ({
        name: localName(entry.nameEn, entry.nameDe),
        meta: '',
        pick: () => void this.pickUnresolved(entry),
      }));
    }
    this.mode = this.rows.length ? 'recent' : 'none';
    if (resetActive) this.active = 0;
    this.active = Math.min(this.active, Math.max(this.rows.length - 1, 0));
    this.renderList();
  }

  /** A recent search picked before the index was loaded: picked once the index is there. */
  private async pickUnresolved(entry: RecentSearch): Promise<void> {
    this.hide();
    this.input.blur();
    await this.loadIndex();
    const tuple = this.index.byPrimary(entry.designation);
    if (tuple) this.pick(hitOf(tuple));
    else if (this.index.size > 0) {
      this.recent = this.recent.filter((e) => e.designation !== entry.designation);
      writeRecent(this.recent);
    }
  }

  private hide(): void {
    this.mode = 'none';
    this.rows = [];
    this.renderList();
  }

  private clear(): void {
    this.input.value = '';
    this.hide();
  }

  private pick(hit: SearchHit): void {
    if (hit.designation) {
      this.recent = addRecent(this.recent, { designation: hit.designation, nameEn: hit.nameEn, nameDe: hit.nameDe });
      writeRecent(this.recent);
    }
    this.onPick(hit);
    this.clear();
    this.input.blur();
  }

  private renderList(): void {
    this.list.replaceChildren();
    if (this.mode === 'none') {
      this.list.classList.add('hidden');
      return;
    }
    this.list.classList.remove('hidden');
    if (this.mode === 'recent') {
      const head = el('li', 'header', t('recentSearches'));
      head.setAttribute('role', 'presentation');
      head.addEventListener('mousedown', (e) => e.preventDefault());
      this.list.appendChild(head);
    } else if (this.rows.length === 0) {
      this.list.appendChild(el('li', 'empty', this.index.size === 0 ? t('loading') : t('noResults')));
      return;
    }
    this.rows.forEach((r, i) => {
      const li = el('li', i === this.active ? 'active' : '');
      li.appendChild(el('span', 'name', r.name));
      if (r.meta) li.appendChild(el('span', 'meta', r.meta));
      // mousedown, not click: the field must not lose focus (and hide the list) first
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        r.pick();
      });
      this.list.appendChild(li);
    });
  }
}
