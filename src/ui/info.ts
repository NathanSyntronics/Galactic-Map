import { Vector3 } from 'three';
import { Flag, UNKNOWN_I16, distErrPercent, spectralClassOf } from '../data/format';
import { LY_PER_PC, galacticLB, worldToGalactic } from '../data/galactic';
import { formatLy, formatNumber, localName, t } from '../i18n';

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
  onClose: () => void = () => {};
  onFlyTo: (info: StarInfo) => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = el('section', 'info-card hidden');
    this.root.setAttribute('aria-live', 'polite');
    parent.appendChild(this.root);
  }

  show(info: StarInfo | null, target: Vector3): void {
    this.info = info;
    this.render(target);
  }

  refresh(target: Vector3): void {
    this.render(target);
  }

  private render(target: Vector3): void {
    const info = this.info;
    this.root.replaceChildren();
    this.root.classList.toggle('hidden', !info);
    if (!info) return;

    const head = el('div', 'info-head');
    const titles = el('div');
    titles.appendChild(el('h2', '', displayName(info)));
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
      dl.append(el('dt', '', k), el('dd', '', v));
    };
    const [gx, gy, gz] = worldToGalactic(info.pos);
    const dSun = Math.hypot(gx, gy, gz);
    if (!(info.flags & Flag.SUN)) {
      row(t('distanceFromSun'), `${formatLy(dSun)} (${formatNumber(dSun / LY_PER_PC, dSun < 33 ? 2 : 1)} ${t('pc')})`);
    }
    const dCentre = info.pos.distanceTo(target);
    if (dCentre > 0.01) row(t('distanceFromCentre'), formatLy(dCentre));
    const err = distErrPercent(info.distErr);
    if (err !== null && !(info.flags & Flag.SUN)) {
      row(t('distUncertainty'), err < 0.5 ? '< 0.5 %' : `± ${formatNumber(err, err < 10 ? 1 : 0)} %`);
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
    if (info.system) {
      row(
        t('system'),
        `${localName(info.system.nameEn, info.system.nameDe)} (${info.system.members} ${t('systemMembers')})`,
      );
    }
    if (info.alt.length) row(t('otherNames'), info.alt.join(' · '));
    row(t('source'), sourceText(info.flags));
    this.root.appendChild(dl);

    const actions = el('div', 'info-actions');
    const fly = el('button', 'btn', t('flyTo'));
    fly.addEventListener('click', () => this.onFlyTo(info));
    actions.appendChild(fly);
    if (!(info.flags & Flag.SUN)) {
      const a = el('a', 'btn subtle', t('openSimbad'));
      a.href = `https://simbad.cds.unistra.fr/simbad/sim-id?Ident=${encodeURIComponent(info.designation)}`;
      a.target = '_blank';
      a.rel = 'noopener';
      actions.appendChild(a);
    }
    this.root.appendChild(actions);
  }
}

function sourceText(flags: number): string {
  const s: string[] = [];
  if (flags & Flag.SRC_CENSUS20) s.push('20 pc census');
  if (flags & Flag.SRC_GCNS) s.push('Gaia GCNS');
  if (flags & Flag.SRC_ATHYG) s.push('AT-HYG');
  if (flags & Flag.SRC_HYG) s.push('HYG');
  return s.join(', ') || '–';
}
