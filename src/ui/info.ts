import { Vector3 } from 'three';
import { attrName, normalizeColor, valueFromLabel, valueLabel, type AttrValue, type AttributeDef, type AttributeStore } from '../data/attributes';
import { parseNumber } from '../data/csv';
import { Flag, UNKNOWN_I16, distErrPercent, spectralClassOf } from '../data/format';
import { LY_PER_PC, galacticLB, worldToGalactic } from '../data/galactic';
import { formatLy, formatNumber, getLang, localName, numberText, t } from '../i18n';

export interface StarInfo {
  key: string;
  nameEn: string | null;
  nameDe: string | null;
  designation: string;
  alt: string[];
  pos: Vector3;
  absMag: number;
  logL: number;
  teff: number;
  flags: number;
  distErr: number;
  spec: number;
  specType: string | null;
  system: { id: number; nameEn: string; nameDe: string | null; members: number } | null;
  /** Primary designation of the system's primary star (key of whole-system attribute values). */
  systemPrimary: string | null;
  /** Known exoplanets. */
  planets: number;
}

/** Jump links of the selected star's place, nearest first. */
export interface JumpListing {
  /** Name of the system whose representative carries the links, when that is another star. */
  via: string | null;
  /** Jump range in light years. */
  range: number;
  links: { name: string; distance: number; kind: number; pick: () => void }[];
}

const KIND_TITLES = ['jumpKindCapacity', 'jumpKindAlone', 'jumpKindConnect'] as const;

function valueText(def: AttributeDef, v: AttrValue): string {
  if (def.type === 'number' && typeof v === 'number') {
    const digits = Math.min((String(v).split('.')[1] ?? '').length, 8);
    return /e/i.test(String(v)) ? numberText(v) : formatNumber(v, digits);
  }
  return valueLabel(def, v, getLang());
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function displayName(info: StarInfo): string {
  if (info.flags & Flag.SUN) return t('theSun');
  return info.nameEn ? localName(info.nameEn, info.nameDe) : info.designation;
}

/** Bottom/right card with details about the selected star. */
export class InfoPanel {
  readonly root: HTMLElement;
  private info: StarInfo | null = null;
  /** The "distance from view centre" row, the only part that changes while the view moves. */
  private centreRow: { dt: HTMLElement; dd: HTMLElement } | null = null;
  onClose: () => void = () => {};
  onFlyTo: (info: StarInfo) => void = () => {};
  /** Flies close to a star with planets (null: the planets are not known). */
  onShowPlanets: ((info: StarInfo) => void) | null = null;
  onManageAttributes: () => void = () => {};
  /** "Route from here" / "Route to here". */
  onRoute: (info: StarInfo, end: 'from' | 'to') => void = () => {};
  /** Jump links of a star (null: the network is off or the star is not part of it). */
  jumpsOf: (info: StarInfo) => JumpListing | null = () => null;
  /** True while the attribute form is open (the card is then not rebuilt by data changes). */
  editing = false;
  private jumpBox: HTMLElement | null = null;
  /** Content of the shown jump list, so that an unchanged list is not rebuilt. */
  private jumpKey = '';

  constructor(
    parent: HTMLElement,
    private readonly attrs: AttributeStore,
  ) {
    this.root = el('section', 'info-card hidden');
    this.root.setAttribute('aria-live', 'polite');
    parent.appendChild(this.root);
  }

  get current(): StarInfo | null {
    return this.info;
  }

  /** Shows the card for a star (null hides it). Rebuilds the card. */
  show(info: StarInfo | null, target: Vector3): void {
    if (info?.key !== this.info?.key) this.editing = false;
    this.info = info;
    this.render(target);
  }

  /** Rebuilds the card for the current star, e.g. after a language change. */
  rerender(target: Vector3): void {
    this.render(target);
  }

  /**
   * Updates the view-dependent values (distance from the view centre) in place. The card is not
   * rebuilt, so clicks and keyboard focus on its buttons survive while the view moves.
   */
  updateView(target: Vector3): void {
    const row = this.centreRow;
    if (!this.info || !row) return;
    const d = this.info.pos.distanceTo(target);
    const show = d > 0.01;
    const text = show ? formatLy(d) : '';
    if (row.dd.textContent !== text) row.dd.textContent = text;
    row.dt.hidden = !show;
    row.dd.hidden = !show;
  }

  /** Updates the jump links (after the network was recomputed); an unchanged list stays as it is. */
  updateJumps(): void {
    if (this.info && this.jumpBox) this.renderJumps(this.info, this.jumpBox);
  }

  private renderJumps(info: StarInfo, box: HTMLElement): void {
    const listing = this.jumpsOf(info);
    const key = listing
      ? [listing.via, listing.range, ...listing.links.map((l) => `${l.name}@${formatLy(l.distance)}/${l.kind}`)].join('|')
      : '';
    if (key === this.jumpKey) return;
    this.jumpKey = key;
    box.replaceChildren();
    box.hidden = !listing;
    if (!listing) return;
    const head = el('div', 'attr-head');
    head.appendChild(el('h3', '', t('jumpLinks', { n: listing.links.length })));
    if (listing.via) head.appendChild(el('span', 'jump-via', t('jumpVia', { system: listing.via })));
    box.appendChild(head);
    if (!listing.links.length) {
      const r = listing.range;
      box.appendChild(el('p', 'hint', t('jumpNone', { range: `${formatNumber(r, Number.isInteger(r) ? 0 : 1)} ${t('ly')}` })));
      return;
    }
    const list = el('ul', 'jump-list');
    for (const l of listing.links) {
      const li = el('li');
      const btn = el('button', 'jump-link');
      btn.type = 'button';
      btn.title = t(KIND_TITLES[l.kind] ?? 'jumpKindCapacity');
      btn.append(el('span', 'jump-name', l.name), el('span', 'jump-dist', formatLy(l.distance)));
      btn.addEventListener('click', () => {
        l.pick();
        // the pick rebuilds the card: keep the keyboard focus in it, on the new star's name
        this.root.querySelector<HTMLElement>('.info-head h2')?.focus();
      });
      li.appendChild(btn);
      list.appendChild(li);
    }
    box.appendChild(list);
  }

  private render(target: Vector3): void {
    const info = this.info;
    this.root.replaceChildren();
    this.centreRow = null;
    this.jumpBox = null;
    this.jumpKey = '\0';
    this.root.classList.toggle('hidden', !info);
    if (!info) return;

    const head = el('div', 'info-head');
    const titles = el('div');
    const title = el('h2', '', displayName(info));
    title.tabIndex = -1;
    titles.appendChild(title);
    const sub = info.flags & Flag.SUN ? '' : info.nameEn ? info.designation : '';
    if (sub) titles.appendChild(el('div', 'sub', sub));
    const close = el('button', 'icon-btn', '×');
    close.setAttribute('aria-label', t('close'));
    close.addEventListener('click', () => this.onClose());
    head.append(titles, close);
    this.root.appendChild(head);

    const tags: string[] = [];
    if (info.flags & Flag.BROWN_DWARF) tags.push(t('brownDwarf'));
    if (info.flags & Flag.WHITE_DWARF) tags.push(t('whiteDwarf'));
    if (info.flags & Flag.GIANT) tags.push(t('giant'));
    if (info.flags & Flag.VARIABLE) tags.push(t('variable'));
    if (tags.length) {
      const tagRow = el('div', 'tags');
      for (const tag of tags) tagRow.appendChild(el('span', 'tag', tag));
      this.root.appendChild(tagRow);
    }

    const dl = el('dl');
    const row = (k: string, v: string) => {
      const dt = el('dt', '', k);
      const dd = el('dd', '', v);
      dl.append(dt, dd);
      return { dt, dd };
    };
    const [gx, gy, gz] = worldToGalactic(info.pos);
    const dSun = Math.hypot(gx, gy, gz);
    if (!(info.flags & Flag.SUN)) {
      row(t('distanceFromSun'), `${formatLy(dSun)} (${formatNumber(dSun / LY_PER_PC, dSun < 33 ? 2 : 1)} ${t('pc')})`);
    }
    this.centreRow = row(t('distanceFromCentre'), '');
    // changes continuously while the view moves: not announced by screen readers
    this.centreRow.dd.setAttribute('aria-live', 'off');
    this.updateView(target);
    const err = distErrPercent(info.distErr);
    if (err !== null && !(info.flags & Flag.SUN)) {
      const est = info.flags & Flag.DIST_NO_PARALLAX ? ` (${t('distEstimated')})` : '';
      row(t('distUncertainty'), (err < 0.5 ? '< 0.5 %' : `± ${formatNumber(err, err < 10 ? 1 : 0)} %`) + est);
    }
    if (!(info.flags & Flag.SUN)) {
      const { l, b } = galacticLB(info.pos);
      row(t('galacticCoords'), `l = ${formatNumber(l, 2)}°, b = ${formatNumber(b, 2)}°`);
      row(t('galacticXYZ'), `${formatNumber(gx, 2)} / ${formatNumber(gy, 2)} / ${formatNumber(gz, 2)} ${t('ly')}`);
    }
    const spec = info.specType ?? spectralClassOf(info.spec);
    row(t('spectralType'), spec ?? t('unknown'));
    if (info.teff > 0) row(t('temperature'), `${formatNumber(info.teff)} K`);
    if (info.absMag !== UNKNOWN_I16) row(t('absMag'), formatNumber(info.absMag / 100, 2));
    if (info.logL !== UNKNOWN_I16) {
      const L = Math.pow(10, info.logL / 1000);
      const digits = L >= 100 ? 0 : L >= 1 ? 2 : Math.min(6, Math.ceil(-Math.log10(L)) + 2);
      row(t('luminosity'), `${formatNumber(L, digits)} L☉`);
    }
    if (info.planets > 0) row(t('knownPlanets'), String(info.planets));
    if (info.system) {
      row(
        t('system'),
        `${localName(info.system.nameEn, info.system.nameDe)} (${info.system.members} ${t('systemMembers')})`,
      );
    }
    if (info.alt.length) row(t('otherNames'), info.alt.join(' · '));
    row(t('source'), sourceText(info.flags));
    this.root.appendChild(dl);
    this.root.appendChild(this.editing ? this.attributeForm(info, target) : this.attributeList(info, target));
    const jumps = el('div', 'attr-box jump-box');
    this.jumpBox = jumps;
    this.renderJumps(info, jumps);
    this.root.appendChild(jumps);

    const actions = el('div', 'info-actions');
    const fly = el('button', 'btn', t('flyTo'));
    fly.addEventListener('click', () => this.onFlyTo(info));
    actions.appendChild(fly);
    const showPlanets = this.onShowPlanets;
    if (showPlanets && (info.planets > 0 || info.flags & Flag.SUN)) {
      const btn = el('button', 'btn', t('showPlanets'));
      btn.addEventListener('click', () => showPlanets(info));
      actions.appendChild(btn);
    }
    for (const end of ['from', 'to'] as const) {
      const btn = el('button', 'btn route-btn', t(end === 'from' ? 'routeFromHere' : 'routeToHere'));
      btn.addEventListener('click', () => this.onRoute(info, end));
      actions.appendChild(btn);
    }
    if (!(info.flags & Flag.SUN)) {
      const a = el('a', 'btn subtle', t('openSimbad'));
      a.href = `https://simbad.cds.unistra.fr/simbad/sim-id?Ident=${encodeURIComponent(info.designation)}`;
      a.target = '_blank';
      a.rel = 'noopener';
      actions.appendChild(a);
    }
    this.root.appendChild(actions);
  }

  /** Value of an attribute for the star: its own, or (whole-system attributes) its system's. */
  private valueOf(info: StarInfo, def: AttributeDef): { v: AttrValue; inherited: boolean } | null {
    const m = this.attrs.values(def.id);
    const own = m.getText(info.designation);
    if (own !== undefined) return { v: own, inherited: false };
    if (def.system && info.systemPrimary && info.systemPrimary !== info.designation) {
      const v = m.getExact(info.systemPrimary);
      if (v !== undefined) return { v, inherited: true };
    }
    return null;
  }

  private attributeList(info: StarInfo, target: Vector3): HTMLElement {
    const box = el('div', 'attr-box');
    const head = el('div', 'attr-head');
    head.appendChild(el('h3', '', t('attributes')));
    const defs = this.attrs.defs;
    const btn = el('button', 'btn small', defs.length ? t('editAttributes') : t('manageAttributes'));
    btn.addEventListener('click', () => {
      if (!defs.length) return this.onManageAttributes();
      this.editing = true;
      this.render(target);
      this.root.querySelector<HTMLInputElement>('.attr-form input')?.focus();
    });
    head.appendChild(btn);
    box.appendChild(head);
    if (!defs.length) {
      box.appendChild(el('p', 'hint', t('noAttributes')));
      return box;
    }
    const dl = el('dl', 'attr-list');
    for (const def of defs) {
      const val = this.valueOf(info, def);
      dl.appendChild(el('dt', '', attrName(def, getLang())));
      const dd = el('dd');
      if (!val) {
        dd.textContent = '–';
        dd.classList.add('empty');
      } else {
        if (def.type === 'color') {
          const sw = el('span', 'swatch');
          sw.style.background = String(val.v);
          dd.appendChild(sw);
        }
        dd.appendChild(document.createTextNode(valueText(def, val.v)));
        if (val.inherited) dd.appendChild(el('span', 'inherited', ` (${t('fromSystem')})`));
      }
      dl.appendChild(dd);
    }
    box.appendChild(dl);
    return box;
  }

  private attributeForm(info: StarInfo, target: Vector3): HTMLElement {
    const form = el('form', 'attr-form attr-box');
    form.noValidate = true;
    form.appendChild(el('h3', '', t('attributes')));
    const fields: { def: AttributeDef; input: HTMLInputElement }[] = [];
    for (const def of this.attrs.defs) {
      const val = this.valueOf(info, def);
      const row = el('label', 'attr-field');
      const name = el('span', 'attr-name', attrName(def, getLang()));
      if (def.system && info.system) name.appendChild(el('span', 'inherited', ` (${t('wholeSystem')})`));
      row.appendChild(name);
      const input = el('input');
      input.type = 'text';
      input.name = def.id;
      const wrap = el('span', 'attr-input');
      wrap.appendChild(input);
      if (def.type === 'number') {
        input.inputMode = 'decimal';
        input.value = val && typeof val.v === 'number' ? numberText(val.v) : '';
      } else if (def.type === 'color') {
        input.value = val ? String(val.v) : '';
        input.placeholder = '#rrggbb';
        input.size = 8;
        const pick = el('input');
        pick.type = 'color';
        pick.value = normalizeColor(input.value) ?? '#ffc861';
        pick.setAttribute('aria-label', attrName(def, getLang()));
        pick.addEventListener('input', () => (input.value = pick.value));
        input.addEventListener('input', () => {
          const c = normalizeColor(input.value);
          if (c) pick.value = c;
        });
        wrap.appendChild(pick);
      } else {
        // text values are shown and typed in the current language (see valueFromLabel)
        input.value = val ? valueLabel(def, val.v, getLang()) : '';
        const options = this.attrs.distinct(def.id).slice(0, 300);
        if (options.length) {
          const list = el('datalist');
          list.id = `attr-values-${def.id}`;
          for (const o of options) {
            const opt = el('option');
            opt.value = valueLabel(def, o, getLang());
            list.appendChild(opt);
          }
          wrap.appendChild(list);
          input.setAttribute('list', list.id);
        }
      }
      const clear = el('button', 'icon-btn small', '×');
      clear.type = 'button';
      clear.setAttribute('aria-label', t('removeValue'));
      clear.addEventListener('click', () => {
        input.value = '';
        input.focus();
      });
      wrap.appendChild(clear);
      row.appendChild(wrap);
      form.appendChild(row);
      fields.push({ def, input });
    }
    const actions = el('div', 'info-actions');
    const save = el('button', 'btn', t('save'));
    save.type = 'submit';
    const cancel = el('button', 'btn subtle', t('cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      this.editing = false;
      this.render(target);
    });
    actions.append(save, cancel);
    form.appendChild(actions);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      // check everything first, then write
      const updates: { def: AttributeDef; value: AttrValue | null }[] = [];
      let ok = true;
      for (const { def, input } of fields) {
        const raw = input.value.trim();
        let value: AttrValue | null = raw;
        if (raw && def.type === 'number') value = parseNumber(raw, true);
        else if (raw && def.type === 'color') value = normalizeColor(raw);
        else if (raw) value = valueFromLabel(def, raw);
        const bad = !!raw && value === null;
        input.classList.toggle('invalid', bad);
        if (bad) ok = false;
        updates.push({ def, value: raw ? value : null });
      }
      if (!ok) {
        form.querySelector<HTMLInputElement>('input.invalid')?.focus();
        return;
      }
      this.editing = false;
      for (const { def, value } of updates) {
        if (def.system && info.systemPrimary) {
          // whole-system values live on the primary; a member's own value would hide them
          if (info.systemPrimary !== info.designation) this.attrs.setValue(def.id, info.designation, null, false);
          this.attrs.setValue(def.id, info.systemPrimary, value, false);
        } else {
          this.attrs.setValue(def.id, info.designation, value, false);
        }
      }
      this.attrs.commit('values');
      this.render(target);
    });
    return form;
  }
}

function sourceText(flags: number): string {
  const s: string[] = [];
  if (flags & Flag.SRC_CENSUS20) s.push(t('srcCensus20'));
  if (flags & Flag.SRC_GCNS) s.push('Gaia GCNS');
  if (flags & Flag.SRC_ATHYG) s.push('AT-HYG');
  if (flags & Flag.SRC_HYG) s.push('HYG');
  if (flags & Flag.SRC_GAIA) s.push('Gaia DR3');
  if (flags & Flag.SRC_EXOPLANET) s.push('NASA Exoplanet Archive');
  return s.join(', ') || '–';
}
