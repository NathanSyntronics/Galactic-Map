// The factions' section of the settings panel (Layers): shown or not, each faction's state in the
// year on the clock, its parameters, new factions (docs/FACTIONS.md).
import { CLASS_KEYS, type ClassKey } from '../data/filter';
import { parseNumber } from '../data/csv';
import { SOLAR_EMPIRE, type FactionDef } from '../factions/sim';
import { MAX_FACTIONS, MAX_REGION, newFaction } from '../factions/world';
import { getLang, numberText, t, type MessageKey } from '../i18n';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const CLASS_LABEL: Partial<Record<ClassKey, MessageKey>> = { BD: 'filterClassBD', WD: 'filterClassWD' };

/** A whole number as typed, without thousands separators ("2.027", "2,027", "2 027": 2027). */
export function ungroup(text: string): string {
  const s = text.trim();
  return /^[+-]?\d{1,3}([.,' \u00a0\u202f]\d{3})+$/.test(s) ? s.replace(/[.,' \u00a0\u202f]/g, '') : s;
}

/** What a change of a faction's parameters needs: a new simulation, or new networks first. */
export type FactionChange = 'sim' | 'world';

/** A star chosen as a faction's home. */
export interface HomeStar {
  designation: string;
  name: string;
  path: string;
  x: number;
  y: number;
  z: number;
}

/** The name of a faction in the current language. */
export function factionName(d: FactionDef): string {
  return getLang() === 'de' ? d.name.de : d.name.en;
}

export class FactionBox {
  readonly root = el('div', 'faction-box');
  private readonly status = new Map<string, HTMLElement>();
  /** Which factions' parameters are open (kept across renders). */
  private readonly open = new Set<string>();
  /** The form of a new faction is open. */
  private adding = false;

  /** The parameters changed. */
  onChange: (defs: FactionDef[], change: FactionChange) => void = () => {};
  onShown: (shown: boolean) => void = () => {};
  /** The star selected on the map, if any. */
  selectedStar: () => HomeStar | null = () => null;
  /** A star by its name or designation (null: not found). */
  resolveStar: (text: string) => Promise<HomeStar | null> = async () => null;

  constructor(
    private defs: FactionDef[],
    private shown: boolean,
  ) {
    this.render();
  }

  setShown(v: boolean): void {
    if (v === this.shown) return;
    this.shown = v;
    this.render();
  }

  /** The state line of a faction ("2153: 12 colonies …"). */
  setStatus(id: string, text: string, warn = false): void {
    const e = this.status.get(id);
    if (!e) return;
    if (e.textContent !== text) e.textContent = text;
    e.classList.toggle('warn', warn);
  }

  private commit(defs: FactionDef[], change: FactionChange): void {
    this.defs = defs;
    this.onChange(defs, change);
  }

  render(): void {
    const r = this.root;
    r.replaceChildren();
    this.status.clear();
    r.appendChild(el('h3', '', t('factionsSection')));
    const show = el('label', 'row check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = this.shown;
    box.addEventListener('change', () => {
      this.shown = box.checked;
      this.onShown(box.checked);
      this.render();
    });
    show.append(box, el('span', '', t('factionsShow')));
    r.appendChild(show);
    r.appendChild(el('p', 'hint', t('factionsHint')));
    if (!this.shown) return;
    this.defs.forEach((d, k) => r.appendChild(this.faction(d, k)));
    if (this.adding) r.appendChild(this.newForm());
    else if (this.defs.length < MAX_FACTIONS) {
      const add = el('button', 'btn', t('factionNew'));
      add.type = 'button';
      add.addEventListener('click', () => {
        this.adding = true;
        this.render();
        this.root.querySelector<HTMLInputElement>('.faction-new input')?.focus();
      });
      r.appendChild(add);
    }
  }

  /** The form of a new faction: its name and home star. */
  private newForm(): HTMLElement {
    const form = el('form', 'faction faction-new');
    form.appendChild(el('strong', '', t('factionNew')));
    const nameRow = el('label', 'row select');
    nameRow.appendChild(el('span', '', t('factionName')));
    const name = el('input', 'filter-text');
    name.type = 'text';
    name.required = true;
    nameRow.appendChild(name);
    const homeRow = el('label', 'row select');
    homeRow.appendChild(el('span', '', t('factionHome')));
    const home = el('input', 'filter-text');
    home.type = 'text';
    home.placeholder = t('factionHomeHint');
    homeRow.appendChild(home);
    let chosen: HomeStar | null = null;
    const sel = this.selectedStar();
    if (sel) {
      chosen = sel;
      home.value = sel.name;
    }
    home.addEventListener('input', () => (chosen = null));
    const pick = el('button', 'btn small', t('factionHomeSelected'));
    pick.type = 'button';
    pick.addEventListener('click', () => {
      const s = this.selectedStar();
      msg.textContent = s ? '' : t('factionNoSelection');
      if (s) {
        chosen = s;
        home.value = s.name;
      }
    });
    const msg = el('p', 'hint warn');
    const buttons = el('div', 'go-row');
    const ok = el('button', 'btn primary', t('factionCreate'));
    ok.type = 'submit';
    const cancel = el('button', 'btn subtle', t('cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      this.adding = false;
      this.render();
    });
    buttons.append(ok, cancel);
    form.append(nameRow, homeRow, pick, msg, buttons);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void (async () => {
        const n = name.value.trim();
        if (!n) {
          msg.textContent = t('factionNeedName');
          return;
        }
        const star = chosen ?? (home.value.trim() ? await this.resolveStar(home.value.trim()) : null);
        if (!star) {
          msg.textContent = t('factionStarUnknown');
          return;
        }
        const d = newFaction(n, star, this.defs);
        this.adding = false;
        this.open.add(d.id);
        this.commit([...this.defs, d], 'world');
        this.render();
      })();
    });
    return form;
  }

  private faction(d: FactionDef, k: number): HTMLElement {
    const wrap = el('div', 'faction');
    const head = el('div', 'faction-head');
    const swatch = el('span', 'faction-swatch');
    swatch.style.background = d.color;
    head.append(swatch, el('strong', '', factionName(d)));
    if (d.id !== SOLAR_EMPIRE.id || d.home !== SOLAR_EMPIRE.home) head.appendChild(el('span', 'faction-home', d.homeName ?? d.home));
    wrap.appendChild(head);
    const status = el('p', 'hint faction-status');
    this.status.set(d.id, status);
    wrap.appendChild(status);

    const details = el('details', 'faction-params');
    details.open = this.open.has(d.id);
    details.addEventListener('toggle', () => (details.open ? this.open.add(d.id) : this.open.delete(d.id)));
    details.appendChild(el('summary', '', t('factionParams')));
    const set = (patch: Partial<FactionDef>, change: FactionChange) => {
      d = { ...d, ...patch };
      this.commit(
        this.defs.map((x, j) => (j === k ? d : x)),
        change,
      );
    };
    /** A number field; shown as it is typed (no thousands separators, which would read as a decimal point). */
    const num = (key: MessageKey, value: number, lo: number, hi: number, put: (v: number) => void, integer = false) => {
      const lab = el('label', 'row select');
      lab.appendChild(el('span', '', t(key)));
      const inp = el('input', 'filter-number');
      inp.type = 'text';
      inp.inputMode = integer ? 'numeric' : 'decimal';
      inp.value = numberText(value);
      inp.addEventListener('change', () => {
        const v = parseNumber(integer ? ungroup(inp.value) : inp.value.trim(), getLang() === 'de');
        const ok = v !== null && v >= lo && v <= hi;
        inp.classList.toggle('invalid', !ok);
        if (ok) {
          inp.value = numberText(integer ? Math.round(v) : v);
          put(v);
        }
      });
      lab.appendChild(inp);
      return lab;
    };
    if (d.id !== SOLAR_EMPIRE.id) {
      const nameRow = el('label', 'row select');
      nameRow.appendChild(el('span', '', t('factionName')));
      const inp = el('input', 'filter-text');
      inp.type = 'text';
      inp.value = factionName(d);
      inp.addEventListener('change', () => {
        const v = inp.value.trim();
        if (v) {
          set({ name: { en: v, de: v } }, 'sim');
          this.render();
        }
      });
      nameRow.appendChild(inp);
      details.appendChild(nameRow);
    }
    details.append(
      num('factionStartYear', d.startYear, -100_000, 100_000, (v) => set({ startYear: Math.round(v) }, 'sim'), true),
      num('factionIncomeStep', d.incomeStep, 0.001, 1e6, (v) => set({ incomeStep: v }, 'sim')),
      num('factionMaxIncome', d.maxIncome, 0, 1e9, (v) => set({ maxIncome: v }, 'sim')),
    );
    details.appendChild(el('div', 'filter-label', t('factionTargets')));
    const chips = el('div', 'filter-chips classes');
    for (const c of CLASS_KEYS) {
      const label = CLASS_LABEL[c];
      const b = el('button', 'btn small chip', label ? t(label) : c);
      b.type = 'button';
      b.classList.toggle('active', d.targets.includes(c));
      b.setAttribute('aria-pressed', String(d.targets.includes(c)));
      b.addEventListener('click', () => {
        const on = !d.targets.includes(c);
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
        set({ targets: CLASS_KEYS.filter((x) => (x === c ? on : d.targets.includes(x))) }, 'sim');
      });
      chips.appendChild(b);
    }
    details.appendChild(chips);
    const single = el('label', 'row check');
    const singleBox = el('input');
    singleBox.type = 'checkbox';
    singleBox.checked = d.singleOnly;
    singleBox.addEventListener('change', () => set({ singleOnly: singleBox.checked }, 'sim'));
    single.append(singleBox, el('span', '', t('filterSystemsSingle')));
    details.appendChild(single);
    details.appendChild(num('factionRegion', d.region, 20, MAX_REGION, (v) => set({ region: Math.round(v) }, 'world'), true));
    details.appendChild(el('p', 'hint', t('factionRegionHint')));
    const colour = el('label', 'row select');
    colour.appendChild(el('span', '', t('factionColor')));
    const pick = el('input', 'faction-color');
    pick.type = 'color';
    pick.value = d.color;
    pick.addEventListener('change', () => {
      swatch.style.background = pick.value;
      set({ color: pick.value }, 'sim');
    });
    colour.appendChild(pick);
    details.appendChild(colour);
    const buttons = el('div', 'go-row');
    if (d.id === SOLAR_EMPIRE.id) {
      const reset = el('button', 'btn small subtle', t('filterReset'));
      reset.type = 'button';
      reset.addEventListener('click', () => {
        this.commit(
          this.defs.map((x, j) => (j === k ? { ...SOLAR_EMPIRE, targets: [...SOLAR_EMPIRE.targets] } : x)),
          'world',
        );
        this.render();
      });
      buttons.appendChild(reset);
    }
    const del = el('button', 'btn small danger', t('factionDelete'));
    del.type = 'button';
    del.addEventListener('click', () => {
      if (!window.confirm(t('factionDeleteConfirm', { name: factionName(d) }))) return;
      this.commit(
        this.defs.filter((_, j) => j !== k),
        'world',
      );
      this.render();
    });
    buttons.appendChild(del);
    details.appendChild(buttons);
    wrap.appendChild(details);
    return wrap;
  }
}
