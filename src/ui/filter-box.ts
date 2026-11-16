// The Filter tab of the settings panel: criteria, the list of the stars found, CSV export.
import {
  CLASS_KEYS,
  DEFAULT_CRITERIA,
  MAX_FILTER_RADIUS,
  MIN_FILTER_RADIUS,
  RADIUS_PRESETS,
  clampRadius,
  readCriteria,
  sortRows,
  type CentreKind,
  type ClassKey,
  type FilterCriteria,
  type PlanetCriterion,
  type SortKey,
  type SystemCriterion,
} from '../data/filter';
import { parseNumber } from '../data/csv';
import { formatLy, formatNumber, getLang, locale, t, type MessageKey } from '../i18n';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** An attribute the filter can ask for (built-in or the user's). */
export interface FilterAttribute {
  id: string;
  /** In the current language. */
  name: string;
  type: 'number' | 'text';
  /** Values to choose from (text attributes). */
  categories?: string[];
  /** Unit after a value in the list (built-in attributes). */
  unit?: string;
}

/** One star of the result list. */
export interface FilterRow {
  path: string;
  index: number;
  name: string;
  /** Primary designation, when the name is something else. */
  designation: string | null;
  dist: number;
  spec: string | null;
  /** The `spec` code (for sorting by spectral class; 255 unknown). */
  specCode: number;
  planets: number;
  /** The filter attribute's value as shown, and as sorted. */
  value?: string;
  valueKey?: number | string;
}

export type FilterState =
  | { kind: 'idle' }
  | { kind: 'expanding' }
  | { kind: 'loading'; loaded: number; total: number }
  | { kind: 'done'; rows: FilterRow[]; complete: boolean; failed: number; attrName: string | null };

const STORE_KEY = 'galactic-map:filter';
/** Rows shown at first and added by "show more". */
export const PAGE_ROWS = 50;

const CLASS_LABEL: Partial<Record<ClassKey, MessageKey>> = { BD: 'filterClassBD', WD: 'filterClassWD' };

interface Stored {
  criteria: FilterCriteria;
  dim: boolean;
  sort: SortKey;
  desc: boolean;
}

const SORT_LABEL: Record<SortKey, MessageKey> = {
  dist: 'filterSortDist',
  name: 'filterSortName',
  spec: 'filterSortSpec',
  planets: 'filterSortPlanets',
  value: 'filterAttr',
};

function readStored(): Stored {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as { criteria?: unknown; dim?: unknown; sort?: unknown; desc?: unknown };
      const sort = (Object.keys(SORT_LABEL) as SortKey[]).find((k) => k === v.sort) ?? 'dist';
      return { criteria: readCriteria(v.criteria), dim: v.dim !== false, sort, desc: v.desc === true };
    }
  } catch {
    // storage unavailable or malformed: the defaults
  }
  return { criteria: { ...DEFAULT_CRITERIA }, dim: true, sort: 'dist', desc: false };
}

export class FilterBox {
  readonly root = el('div', 'filter-box');
  private criteria: FilterCriteria;
  private dimOthers: boolean;
  private sortKey: SortKey;
  private sortDesc: boolean;
  /** The rows of the last search in the order chosen. */
  private sorted: FilterRow[] = [];
  private state: FilterState = { kind: 'idle' };
  private shown = PAGE_ROWS;
  private readonly status = el('div', 'filter-status');
  private readonly actions = el('div', 'go-row filter-actions');
  private readonly sortRow = el('div', 'row select filter-sort');
  private readonly list = el('ol', 'filter-list');
  private readonly more = el('div', 'filter-more');

  /** The criteria to search with (also on "Find" with unchanged criteria: a new search). */
  onRun: (c: FilterCriteria) => void = () => {};
  /** The marks are removed (the list stays until the next search). */
  onClear: () => void = () => {};
  onPick: (row: FilterRow) => void = () => {};
  /** The list as shown (in its order) and the attribute's name, if the filter has one. */
  onCsv: (rows: FilterRow[], attrName: string | null) => void = () => {};
  onDim: (dim: boolean) => void = () => {};
  /** The attributes to offer (asked at every render). */
  attributes: () => FilterAttribute[] = () => [];

  constructor() {
    const s = readStored();
    this.criteria = s.criteria;
    this.dimOthers = s.dim;
    this.sortKey = s.sort;
    this.sortDesc = s.desc;
    this.render();
  }

  get current(): FilterCriteria {
    return this.criteria;
  }

  get dim(): boolean {
    return this.dimOthers;
  }

  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ criteria: this.criteria, dim: this.dimOthers, sort: this.sortKey, desc: this.sortDesc }));
    } catch {
      // storage unavailable: the criteria are not kept
    }
  }

  private set(patch: Partial<FilterCriteria>): void {
    this.criteria = { ...this.criteria, ...patch };
    this.save();
  }

  /** Rebuilds the controls (language change, new attributes). */
  render(): void {
    const c = this.criteria;
    const r = this.root;
    r.replaceChildren();
    r.appendChild(el('h3', '', t('filterSection')));
    r.appendChild(el('p', 'hint', t('filterHint')));

    // radius: presets and a number
    const radius = el('div', 'row filter-radius');
    radius.appendChild(el('span', 'filter-label', t('filterRadius')));
    const presets = el('div', 'filter-chips');
    const input = el('input', 'filter-number');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = formatNumber(c.radius, c.radius < 10 ? 1 : 0);
    input.setAttribute('aria-label', `${t('filterRadius')} (${t('ly')})`);
    const chips: HTMLButtonElement[] = [];
    const syncChips = () => chips.forEach((b, k) => b.classList.toggle('active', RADIUS_PRESETS[k] === this.criteria.radius));
    for (const p of RADIUS_PRESETS) {
      const b = el('button', 'btn small chip', `${p}`);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.set({ radius: p });
        input.value = String(p);
        input.classList.remove('invalid');
        syncChips();
      });
      chips.push(b);
      presets.appendChild(b);
    }
    input.addEventListener('change', () => {
      const v = parseNumber(input.value, getLang() === 'de');
      const ok = v !== null && v >= MIN_FILTER_RADIUS && v <= MAX_FILTER_RADIUS;
      input.classList.toggle('invalid', !ok);
      if (v !== null) this.set({ radius: clampRadius(v) });
      syncChips();
    });
    const unit = el('span', 'filter-unit', t('ly'));
    presets.append(input, unit);
    radius.appendChild(presets);
    syncChips();
    r.appendChild(radius);

    // centre
    r.appendChild(
      this.select<CentreKind>('filterCentre', [
        ['sun', 'filterCentreSun'],
        ['view', 'filterCentreView'],
      ], c.centre, (v) => this.set({ centre: v })),
    );

    // spectral classes: none chosen means all
    r.appendChild(el('div', 'filter-label', t('filterClasses')));
    const classes = el('div', 'filter-chips classes');
    for (const k of CLASS_KEYS) {
      const label = CLASS_LABEL[k];
      const b = el('button', 'btn small chip', label ? t(label) : k);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(c.classes.includes(k)));
      b.classList.toggle('active', c.classes.includes(k));
      b.addEventListener('click', () => {
        const on = !this.criteria.classes.includes(k);
        this.set({ classes: CLASS_KEYS.filter((x) => (x === k ? on : this.criteria.classes.includes(x))) });
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      classes.appendChild(b);
    }
    r.appendChild(classes);

    r.appendChild(
      this.select<PlanetCriterion>('filterPlanets', [
        ['any', 'filterPlanetsAny'],
        ['planets', 'filterPlanetsSome'],
        ['habitable', 'filterPlanetsHabitable'],
      ], c.planets, (v) => this.set({ planets: v })),
    );
    r.appendChild(this.check('filterNamed', c.named, (v) => this.set({ named: v })));
    r.appendChild(
      this.select<SystemCriterion>('filterSystems', [
        ['both', 'filterSystemsBoth'],
        ['single', 'filterSystemsSingle'],
        ['multiple', 'filterSystemsMultiple'],
      ], c.systems, (v) => this.set({ systems: v })),
    );
    r.appendChild(this.attrControls());

    // actions
    const run = el('div', 'go-row');
    const find = el('button', 'btn primary', t('filterRun'));
    find.type = 'button';
    find.addEventListener('click', () => {
      this.shown = PAGE_ROWS;
      this.onRun(this.criteria);
    });
    const reset = el('button', 'btn subtle', t('filterReset'));
    reset.type = 'button';
    reset.addEventListener('click', () => {
      this.criteria = { ...DEFAULT_CRITERIA };
      this.save();
      this.render();
    });
    run.append(find, reset);
    r.appendChild(run);
    r.appendChild(this.check('filterDim', this.dimOthers, (v) => {
      this.dimOthers = v;
      this.save();
      this.onDim(v);
    }));

    // the buttons above the list: no scrolling down to them
    r.append(this.status, this.actions, this.sortRow, this.list, this.more);
    this.renderState();
  }

  /** The attribute criterion: which attribute, and a text or a range. */
  private attrControls(): HTMLElement {
    const box = el('div', 'filter-attr');
    const attrs = this.attributes();
    const a = this.criteria.attr;
    const def = a ? attrs.find((x) => x.id === a.id) : undefined;
    const wrap = el('label', 'row select');
    wrap.appendChild(el('span', '', t('filterAttr')));
    const sel = el('select');
    sel.appendChild(new Option('—', ''));
    for (const x of attrs) sel.appendChild(new Option(x.name, x.id));
    sel.value = def ? def.id : '';
    sel.addEventListener('change', () => {
      this.set({ attr: sel.value ? { id: sel.value } : null });
      box.replaceWith(this.attrControls());
    });
    wrap.appendChild(sel);
    box.appendChild(wrap);
    if (!def || !a) return box;
    const de = getLang() === 'de';
    if (def.type === 'number') {
      const row = el('div', 'row range');
      const num = (key: MessageKey, v: number | undefined, put: (x: number | undefined) => void) => {
        const lab = el('label', 'check');
        const inp = el('input');
        inp.type = 'text';
        inp.inputMode = 'decimal';
        inp.value = v === undefined ? '' : formatNumber(v, Number.isInteger(v) ? 0 : 2);
        inp.addEventListener('change', () => {
          const raw = inp.value.trim();
          const x = raw ? parseNumber(raw, de) : null;
          inp.classList.toggle('invalid', !!raw && x === null);
          put(x === null ? undefined : x);
        });
        lab.append(el('span', '', t(key)), inp);
        return lab;
      };
      row.append(
        num('filterAttrMin', a.min, (x) => this.set({ attr: { ...this.criteria.attr!, min: x } })),
        num('filterAttrMax', a.max, (x) => this.set({ attr: { ...this.criteria.attr!, max: x } })),
      );
      box.appendChild(row);
    } else {
      const row = el('label', 'row select');
      row.appendChild(el('span', '', t('filterAttrText')));
      if (def.categories?.length) {
        const vs = el('select');
        vs.appendChild(new Option(t('filterAttrAny'), ''));
        for (const v of def.categories) vs.appendChild(new Option(v, v));
        vs.value = a.text && def.categories.includes(a.text) ? a.text : '';
        vs.addEventListener('change', () => this.set({ attr: { id: def.id, text: vs.value || undefined } }));
        row.appendChild(vs);
      } else {
        const inp = el('input', 'filter-text');
        inp.type = 'text';
        inp.value = a.text ?? '';
        inp.placeholder = t('filterAttrAny');
        inp.addEventListener('change', () => this.set({ attr: { id: def.id, text: inp.value.trim() || undefined } }));
        row.appendChild(inp);
      }
      box.appendChild(row);
    }
    return box;
  }

  private select<T extends string>(key: MessageKey, options: [T, MessageKey][], value: T, set: (v: T) => void): HTMLElement {
    const wrap = el('label', 'row select');
    wrap.appendChild(el('span', '', t(key)));
    const sel = el('select');
    for (const [v, k] of options) sel.appendChild(new Option(t(k), v));
    sel.value = value;
    sel.addEventListener('change', () => set(sel.value as T));
    wrap.appendChild(sel);
    return wrap;
  }

  private check(key: MessageKey, value: boolean, set: (v: boolean) => void): HTMLElement {
    const label = el('label', 'row check');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = value;
    input.addEventListener('change', () => set(input.checked));
    label.append(input, el('span', '', t(key)));
    return label;
  }

  setState(state: FilterState): void {
    if (state.kind === 'done' && this.state.kind !== 'done') this.shown = PAGE_ROWS;
    this.state = state;
    if (state.kind === 'done') {
      // sorted by the attribute only while the filter has one
      if (this.sortKey === 'value' && !state.attrName) this.sortKey = 'dist';
      this.sorted = sortRows(state.rows, this.sortKey, this.sortDesc, locale());
    } else {
      this.sorted = [];
    }
    this.renderState();
  }

  /** The status line, the buttons, the sort order and the list. */
  private renderState(): void {
    const st = this.state;
    for (const e of [this.status, this.actions, this.sortRow, this.list, this.more]) e.replaceChildren();
    this.sortRow.hidden = true;
    if (st.kind === 'idle') return;
    if (st.kind === 'expanding') {
      this.status.textContent = t('filterExpanding');
      return;
    }
    if (st.kind === 'loading') {
      this.status.textContent = t('filterLoading', { loaded: st.loaded, total: st.total });
      return;
    }
    const n = st.rows.length;
    this.status.appendChild(el('strong', '', n === 0 ? t('filterNone') : n === 1 ? t('filterCountOne') : t('filterCount', { n: formatNumber(n) })));
    if (!st.complete) this.status.appendChild(el('p', 'hint warn', t('filterIncomplete')));
    if (st.failed) this.status.appendChild(el('p', 'hint warn', t('filterFailed', { n: st.failed })));
    if (n) {
      const csv = el('button', 'btn small', t('filterCsv'));
      csv.type = 'button';
      csv.addEventListener('click', () => this.onCsv(this.sorted, st.attrName));
      this.actions.appendChild(csv);
    }
    const clear = el('button', 'btn small subtle', t('filterClear'));
    clear.type = 'button';
    clear.addEventListener('click', () => {
      this.state = { kind: 'idle' };
      this.sorted = [];
      this.renderState();
      this.onClear();
    });
    this.actions.appendChild(clear);
    if (n > 1) this.renderSort(st.attrName);
    for (const row of this.sorted.slice(0, this.shown)) {
      const li = el('li');
      const b = el('button', 'filter-row');
      b.type = 'button';
      const head = el('span', 'filter-head');
      head.appendChild(el('span', 'filter-name', row.name));
      if (row.value !== undefined) head.appendChild(el('span', 'filter-value', row.value));
      const meta = el('span', 'filter-meta');
      const bits = [formatLy(row.dist)];
      if (row.spec) bits.push(row.spec);
      if (row.planets) bits.push(row.planets === 1 ? t('filterPlanetOne') : t('filterPlanetCount', { n: row.planets }));
      meta.textContent = bits.join(' · ');
      b.append(head, meta);
      if (row.designation) b.title = row.designation;
      b.addEventListener('click', () => this.onPick(row));
      li.appendChild(b);
      this.list.appendChild(li);
    }
    if (n > this.shown) {
      const more = el('button', 'btn small', t('filterMore', { n: formatNumber(Math.min(PAGE_ROWS, n - this.shown)) }));
      more.type = 'button';
      more.addEventListener('click', () => {
        this.shown += PAGE_ROWS;
        this.renderState();
      });
      this.more.appendChild(more);
    }
  }

  /** "Sort by" and the direction. */
  private renderSort(attrName: string | null): void {
    const row = this.sortRow;
    row.hidden = false;
    const label = el('label', 'filter-sort-label');
    label.appendChild(el('span', '', t('filterSort')));
    const sel = el('select');
    for (const k of Object.keys(SORT_LABEL) as SortKey[]) {
      if (k === 'value' && !attrName) continue;
      sel.appendChild(new Option(k === 'value' ? attrName! : t(SORT_LABEL[k]), k));
    }
    sel.value = this.sortKey;
    sel.addEventListener('change', () => {
      this.sortKey = sel.value as SortKey;
      // the natural direction of each order: the nearest, A to Z, hot to cool, the most planets
      this.sortDesc = this.sortKey === 'planets';
      this.resort();
    });
    label.appendChild(sel);
    const dir = el('button', 'btn small filter-dir', this.sortDesc ? '↓' : '↑');
    dir.type = 'button';
    dir.title = t(this.sortDesc ? 'filterSortDesc' : 'filterSortAsc');
    dir.setAttribute('aria-label', dir.title);
    dir.addEventListener('click', () => {
      this.sortDesc = !this.sortDesc;
      this.resort();
    });
    row.append(label, dir);
  }

  private resort(): void {
    this.save();
    if (this.state.kind !== 'done') return;
    this.sorted = sortRows(this.state.rows, this.sortKey, this.sortDesc, locale());
    this.shown = PAGE_ROWS;
    this.renderState();
  }
}
