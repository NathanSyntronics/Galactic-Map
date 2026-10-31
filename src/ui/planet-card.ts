import { PlanetFlag, planetKind, planetName, type PlanetCatalogue } from '../data/planets';
import { formatKm, formatNumber, getLang, t, type MessageKey } from '../i18n';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const KIND_KEYS: Record<string, MessageKey> = {
  rocky: 'planetRocky',
  subNeptune: 'planetSubNeptune',
  iceGiant: 'planetIceGiant',
  gasGiant: 'planetGasGiant',
};

/** Discovery methods of the NASA Exoplanet Archive in German. */
const METHODS_DE: Record<string, string> = {
  Transit: 'Transit',
  'Radial Velocity': 'Radialgeschwindigkeit',
  Imaging: 'direkte Abbildung',
  Microlensing: 'Mikrolinseneffekt',
  'Transit Timing Variations': 'Transitzeitvariationen',
  'Eclipse Timing Variations': 'Bedeckungszeitvariationen',
  'Orbital Brightness Modulation': 'Helligkeitsmodulation',
  'Pulsar Timing': 'Pulsar-Timing',
  'Pulsation Timing Variations': 'Pulsationszeitvariationen',
  Astrometry: 'Astrometrie',
  'Disk Kinematics': 'Scheibenkinematik',
};

const KM_PER_AU = 149_597_870.7;

/** A number with about three significant digits. */
function sig(x: number): string {
  const a = Math.abs(x);
  const digits = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : Math.min(2 - Math.floor(Math.log10(a || 1)), 6);
  return formatNumber(x, digits);
}

/** The card of a selected planet (in the same place as the star card). */
export class PlanetCard {
  readonly root: HTMLElement;
  private cat: PlanetCatalogue | null = null;
  private index: number | null = null;
  private hostName = '';
  private dateText = '';
  onClose: () => void = () => {};
  onFlyTo: (i: number) => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = el('section', 'info-card planet-card hidden');
    this.root.setAttribute('aria-live', 'polite');
    parent.appendChild(this.root);
  }

  get current(): number | null {
    return this.index;
  }

  /** `hostName`: the star's display name on the map; `date`: the date the positions are drawn for. */
  show(cat: PlanetCatalogue | null, i: number | null, hostName = '', date = ''): void {
    this.cat = cat;
    this.index = cat ? i : null;
    this.hostName = hostName;
    this.dateText = date;
    this.render();
  }

  rerender(): void {
    this.render();
  }

  private render(): void {
    const cat = this.cat;
    const i = this.index;
    this.root.replaceChildren();
    this.root.classList.toggle('hidden', !cat || i === null);
    if (!cat || i === null) return;
    const p = cat.planets[i];
    const lang = getLang();
    const solar = (p.flags & PlanetFlag.SOLAR_SYSTEM) !== 0;

    const head = el('div', 'info-head');
    const titles = el('div');
    const title = el('h2', '', planetName(p, lang));
    title.tabIndex = -1;
    titles.appendChild(title);
    if (this.hostName) titles.appendChild(el('div', 'sub', this.hostName));
    const close = el('button', 'icon-btn', '×');
    close.setAttribute('aria-label', t('close'));
    close.addEventListener('click', () => this.onClose());
    head.append(titles, close);
    this.root.appendChild(head);

    const tags = el('div', 'tags');
    tags.appendChild(el('span', 'tag', t(KIND_KEYS[planetKind(p)])));
    if (Number.isFinite(p.eqt) && p.eqt > 1300) tags.appendChild(el('span', 'tag', t('planetHot')));
    if (solar) tags.appendChild(el('span', 'tag', t('solarSystem')));
    this.root.appendChild(tags);

    const dl = el('dl');
    const row = (k: string, v: string) => dl.append(el('dt', '', k), el('dd', '', v));
    // below 1 AU also in kilometres (TRAPPIST-1 b: 0.0115 AU, 1.72 million km)
    row(t('semiMajorAxis'), `${sig(p.a)} ${t('au')}${p.a < 1 ? ` (${formatKm(p.a * KM_PER_AU)})` : ''}`);
    row(t('eccentricity'), p.flags & PlanetFlag.ECCENTRICITY_ASSUMED ? t('assumedCircular') : sig(p.e));
    row(t('orbitalPeriod'), p.period >= 1000 ? t('yearsN', { n: sig(p.period / 365.25) }) : t('daysN', { n: sig(p.period) }));
    if (Number.isFinite(p.radius)) {
      row(t('planetRadius'), `${sig(p.radius)} R⊕${p.flags & PlanetFlag.RADIUS_ESTIMATED ? ` (${t('estimatedFromMass')})` : ''}`);
    }
    if (Number.isFinite(p.mass)) row(t('planetMass'), `${sig(p.mass)} M⊕`);
    if (Number.isFinite(p.eqt)) row(t('eqTemperature'), `${formatNumber(p.eqt, 0)} K`);
    if (Number.isFinite(p.incl) && !(p.flags & PlanetFlag.INCLINATION_ASSUMED)) {
      // (the Earth's -0.00002 deg: 0)
      row(solar ? t('inclinationEcliptic') : t('inclinationSky'), `${sig(Math.abs(p.incl) < 0.005 ? 0 : p.incl)}°`);
    }
    if (!solar && (p.method || p.year)) {
      const method = lang === 'de' ? (METHODS_DE[p.method] ?? p.method) : p.method;
      row(t('discovered'), [p.year ?? '', method].filter((x) => x !== '').join(' · '));
    }
    this.root.appendChild(dl);
    if (!solar) {
      const assumed: string[] = [];
      if (p.flags & PlanetFlag.INCLINATION_ASSUMED) assumed.push(t('assumedInclination'));
      if (p.flags & PlanetFlag.PHASE_ASSUMED) assumed.push(t('assumedPhase'));
      const note = el('p', 'hint', t('orbitNote'));
      if (assumed.length) note.textContent += ` ${t('orbitNoteAssumed', { what: assumed.join(', ') })}`;
      this.root.appendChild(note);
    }
    if (this.dateText) this.root.appendChild(el('p', 'hint', t('planetDate', { date: this.dateText })));

    const actions = el('div', 'info-actions');
    const fly = el('button', 'btn', t('flyTo'));
    fly.addEventListener('click', () => this.onFlyTo(i));
    actions.appendChild(fly);
    if (!solar) {
      const a = el('a', 'btn subtle', t('openExoplanetArchive'));
      a.href = `https://exoplanetarchive.ipac.caltech.edu/overview/${encodeURIComponent(cat.hosts[p.host].name)}`;
      a.target = '_blank';
      a.rel = 'noopener';
      actions.appendChild(a);
    }
    this.root.appendChild(actions);
  }
}
