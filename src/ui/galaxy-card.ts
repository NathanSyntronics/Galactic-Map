import { Vector3 } from 'three';
import { galacticLB, worldToGalactic } from '../data/galactic';
import { GalaxyClass, GalaxyFlag, galaxyDesignation, galaxyName, type GalaxyCatalogue } from '../data/galaxies';
import { formatLy, formatNumber, getLang, t, type MessageKey } from '../i18n';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const CLASS_KEYS: Record<number, MessageKey> = {
  [GalaxyClass.Spiral]: 'galaxySpiral',
  [GalaxyClass.Lenticular]: 'galaxyLenticular',
  [GalaxyClass.Elliptical]: 'galaxyElliptical',
  [GalaxyClass.Irregular]: 'galaxyIrregular',
  [GalaxyClass.Spheroidal]: 'galaxySpheroidal',
  [GalaxyClass.MilkyWay]: 'galaxyBarredSpiral',
};

const METHOD_KEYS: Record<string, MessageKey> = {
  TRGB: 'methodTRGB',
  Cep: 'methodCep',
  maser: 'methodMaser',
  SBF: 'methodSBF',
  SNIa: 'methodSNIa',
  SNII: 'methodSNII',
  FP: 'methodFP',
  TF: 'methodTF',
  RR: 'methodRR',
  HB: 'methodHB',
  CMD: 'methodCMD',
  BS: 'methodBS',
  PNLF: 'methodPNLF',
  mem: 'methodMem',
  txt: 'methodTxt',
  geom: 'methodGeom',
};

/** "2.5 × 10¹⁰" in the current language. */
export function scientific(x: number): string {
  if (!Number.isFinite(x) || x <= 0) return '–';
  const e = Math.floor(Math.log10(x));
  if (e < 4) return formatNumber(x, x < 10 ? 1 : 0);
  const m = x / 10 ** e;
  const sup = String(e).replace(/[0-9-]/g, (c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'['0123456789'.indexOf(c)] ?? '⁻');
  return `${formatNumber(m, 1)} × 10${sup}`;
}

/** The card of a selected galaxy (in the same place as the star card). */
export class GalaxyCard {
  readonly root: HTMLElement;
  private cat: GalaxyCatalogue | null = null;
  private index: number | null = null;
  private centreRow: { dt: HTMLElement; dd: HTMLElement } | null = null;
  onClose: () => void = () => {};
  onFlyTo: (i: number) => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = el('section', 'info-card galaxy-card hidden');
    this.root.setAttribute('aria-live', 'polite');
    parent.appendChild(this.root);
  }

  get current(): number | null {
    return this.index;
  }

  show(cat: GalaxyCatalogue | null, i: number | null, target: Vector3): void {
    this.cat = cat;
    this.index = cat ? i : null;
    this.render(target);
  }

  rerender(target: Vector3): void {
    this.render(target);
  }

  updateView(target: Vector3): void {
    const row = this.centreRow;
    if (!this.cat || this.index === null || !row) return;
    const p = this.position();
    const d = p.distanceTo(target);
    const show = d > 1;
    const text = show ? formatLy(d) : '';
    if (row.dd.textContent !== text) row.dd.textContent = text;
    row.dt.hidden = !show;
    row.dd.hidden = !show;
  }

  private position(): Vector3 {
    const p = this.cat!.pos;
    const i = this.index!;
    return new Vector3(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
  }

  private render(target: Vector3): void {
    const cat = this.cat;
    const i = this.index;
    this.root.replaceChildren();
    this.centreRow = null;
    this.root.classList.toggle('hidden', !cat || i === null);
    if (!cat || i === null) return;
    const lang = getLang();
    const name = galaxyName(cat, i, lang);
    const model = (cat.flags[i] & GalaxyFlag.MODEL) !== 0;
    const designation = galaxyDesignation(cat, i);

    const head = el('div', 'info-head');
    const titles = el('div');
    const title = el('h2', '', name);
    title.tabIndex = -1;
    titles.appendChild(title);
    if (!model && designation !== name) titles.appendChild(el('div', 'sub', designation));
    const close = el('button', 'icon-btn', '×');
    close.setAttribute('aria-label', t('close'));
    close.addEventListener('click', () => this.onClose());
    head.append(titles, close);
    this.root.appendChild(head);

    const tags = el('div', 'tags');
    tags.appendChild(el('span', 'tag', t(CLASS_KEYS[cat.cls[i]] ?? 'galaxy')));
    if (cat.flags[i] & GalaxyFlag.LOCAL_GROUP) tags.appendChild(el('span', 'tag', t('localGroup')));
    this.root.appendChild(tags);

    const dl = el('dl');
    const row = (k: string, v: string) => {
      const dt = el('dt', '', k);
      const dd = el('dd', '', v);
      dl.append(dt, dd);
      return { dt, dd };
    };
    const p = this.position();
    const [gx, gy, gz] = worldToGalactic(p);
    const dSun = Math.hypot(gx, gy, gz);
    row(model ? t('distanceToCentre') : t('distanceFromSun'), formatLy(dSun));
    this.centreRow = row(t('distanceFromCentre'), '');
    this.centreRow.dd.setAttribute('aria-live', 'off');
    this.updateView(target);
    if (!model) {
      const err = cat.distErr[i];
      if (Number.isFinite(err)) row(t('distUncertainty'), `± ${formatNumber(err * 100, err < 0.1 ? 1 : 0)} %`);
      const method = cat.methods[cat.method[i]] ?? '';
      if (method && METHOD_KEYS[method]) row(t('distanceMethod'), t(METHOD_KEYS[method]));
      const { l, b } = galacticLB(p);
      row(t('galacticCoords'), `l = ${formatNumber(l, 2)}°, b = ${formatNumber(b, 2)}°`);
    }
    row(t('diameter'), formatLy(cat.diam[i]));
    if (Number.isFinite(cat.logL[i])) row(t('luminosity'), `${scientific(10 ** cat.logL[i])} L☉`);
    const names = cat.names.get(i);
    // the designation is the subtitle already
    const others = (names?.alt ?? []).filter((x) => x !== name && x !== designation);
    if (others.length) row(t('otherNames'), others.join(' · '));
    if (model) {
      row(t('source'), t('milkyWayModelSource'));
    } else {
      const src: string[] = [];
      if (cat.flags[i] & GalaxyFlag.CF4) src.push('Cosmicflows-4');
      if (cat.flags[i] & GalaxyFlag.UNGC) src.push('UNGC');
      if (cat.flags[i] & GalaxyFlag.LVDB) src.push('LVDB');
      row(t('source'), src.join(', '));
    }
    this.root.appendChild(dl);

    const actions = el('div', 'info-actions');
    const fly = el('button', 'btn', t('flyTo'));
    fly.addEventListener('click', () => this.onFlyTo(i));
    actions.appendChild(fly);
    if (!model) {
      const a = el('a', 'btn subtle', t('openNed'));
      a.href = `https://ned.ipac.caltech.edu/byname?objname=${encodeURIComponent(designation)}`;
      a.target = '_blank';
      a.rel = 'noopener';
      actions.appendChild(a);
    }
    this.root.appendChild(actions);
  }
}
