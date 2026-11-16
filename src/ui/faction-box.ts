// The factions' section of the settings panel (Layers): shown or not, each faction's state in the
// year on the clock, and its parameters (docs/FACTIONS.md).
import { CLASS_KEYS, type ClassKey } from '../data/filter';
import { parseNumber } from '../data/csv';
import { SOLAR_EMPIRE, type FactionDef } from '../factions/sim';
import { MAX_REGION } from '../factions/world';
import { formatNumber, getLang, t, type MessageKey } from '../i18n';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const CLASS_LABEL: Partial<Record<ClassKey, MessageKey>> = { BD: 'filterClassBD', WD: 'filterClassWD' };

/** What a change of a faction's parameters needs: a new simulation, or a new network first. */
export type FactionChange = 'sim' | 'world';

export class FactionBox {
  readonly root = el('div', 'faction-box');
  private readonly status = new Map<string, HTMLElement>();
  /** Which factions' parameters are open (kept across renders). */
  private readonly open = new Set<string>();

  /** The parameters changed. */
  onChange: (defs: FactionDef[], change: FactionChange) => void = () => {};
  onShown: (shown: boolean) => void = () => {};

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
  }

  private faction(d: FactionDef, k: number): HTMLElement {
    const wrap = el('div', 'faction');
    const head = el('div', 'faction-head');
    const swatch = el('span', 'faction-swatch');
    swatch.style.background = d.color;
    head.append(swatch, el('strong', '', getLang() === 'de' ? d.name.de : d.name.en));
    wrap.appendChild(head);
    const status = el('p', 'hint faction-status');
    this.status.set(d.id, status);
    wrap.appendChild(status);

    const details = el('details', 'faction-params');
    details.open = this.open.has(d.id);
    details.addEventListener('toggle', () => (details.open ? this.open.add(d.id) : this.open.delete(d.id)));
    details.appendChild(el('summary', '', t('factionParams')));
    const set = (patch: Partial<FactionDef>, change: FactionChange) => {
      this.defs = this.defs.map((x, j) => (j === k ? { ...x, ...patch } : x));
      this.onChange(this.defs, change);
    };
    const num = (key: MessageKey, value: number, lo: number, hi: number, put: (v: number) => void, digits = 1) => {
      const lab = el('label', 'row select');
      lab.appendChild(el('span', '', t(key)));
      const inp = el('input', 'filter-number');
      inp.type = 'text';
      inp.inputMode = 'decimal';
      inp.value = formatNumber(value, Number.isInteger(value) ? 0 : digits);
      inp.addEventListener('change', () => {
        const v = parseNumber(inp.value.trim(), getLang() === 'de');
        const ok = v !== null && v >= lo && v <= hi;
        inp.classList.toggle('invalid', !ok);
        if (ok) put(v);
      });
      lab.appendChild(inp);
      return lab;
    };
    details.append(
      num('factionStartYear', d.startYear, -100_000, 100_000, (v) => set({ startYear: Math.round(v) }, 'sim')),
      num('factionStartIncome', d.startIncome, 0, 1e6, (v) => set({ startIncome: v }, 'sim'), 2),
      num('factionIncomeStep', d.incomeStep, 0, 1e6, (v) => set({ incomeStep: v }, 'sim'), 2),
      num('factionMaxIncome', d.maxIncome, 0, 1e9, (v) => set({ maxIncome: v }, 'sim')),
      num('factionCostK', d.cost.k, 0.5, 5, (v) => set({ cost: { ...d.cost, k: v } }, 'sim')),
    );
    const exp = el('label', 'row check');
    const expBox = el('input');
    expBox.type = 'checkbox';
    expBox.checked = d.cost.exp;
    expBox.addEventListener('change', () => set({ cost: { ...d.cost, exp: expBox.checked } }, 'sim'));
    exp.append(expBox, el('span', '', t('jumpCostExp')));
    details.appendChild(exp);

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
        const targets = CLASS_KEYS.filter((x) => (x === c ? on : d.targets.includes(x)));
        d = { ...d, targets };
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
        set({ targets }, 'sim');
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
    details.appendChild(num('factionRegion', d.region, 20, MAX_REGION, (v) => set({ region: v }, 'world'), 0));
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
    const reset = el('button', 'btn small subtle', t('filterReset'));
    reset.type = 'button';
    reset.addEventListener('click', () => {
      const base = d.id === SOLAR_EMPIRE.id ? SOLAR_EMPIRE : d;
      this.defs = this.defs.map((x, j) => (j === k ? { ...base, targets: [...base.targets], cost: { ...base.cost } } : x));
      this.onChange(this.defs, 'world');
      this.render();
    });
    details.appendChild(reset);
    wrap.appendChild(details);
    return wrap;
  }
}
