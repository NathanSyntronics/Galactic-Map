import { PlanetFlag, planetKind, planetName, type PlanetCatalogue } from '../data/planets';
import { formatKm, formatNumber, getLang, t, type MessageKey } from '../i18n';

/** The Earth's mean radius (km). */
const EARTH_RADIUS_KM = 6371;

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
  private dateEl: HTMLElement | null = null;
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

  /** The date the positions are drawn for, as the clock runs (only the line changes). */
  setDate(date: string): void {
    if (date === this.dateText) return;
    this.dateText = date;
    if (this.dateEl) this.dateEl.textContent = date ? t('planetDate', { date }) : '';
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
    const parent = p.parent !== null ? cat.planets[p.parent] : null;

    const head = el('div', 'info-head');
    const titles = el('div');
    const title = el('h2', '', planetName(p, lang));
    title.tabIndex = -1;
    titles.appendChild(title);
    // a moon: its planet; a planet: its star
    if (parent) titles.appendChild(el('div', 'sub', planetName(parent, lang)));
    else if (this.hostName) titles.appendChild(el('div', 'sub', this.hostName));
    const close = el('button', 'icon-btn', '×');
    close.setAttribute('aria-label', t('close'));
    close.addEventListener('click', () => this.onClose());
    head.append(titles, close);
    this.root.appendChild(head);

    const tags = el('div', 'tags');
    tags.appendChild(el('span', 'tag', parent ? t('moonOf', { planet: planetName(parent, lang) }) : t(KIND_KEYS[planetKind(p)])));
    if (Number.isFinite(p.eqt) && p.eqt > 1300) tags.appendChild(el('span', 'tag', t('planetHot')));
    if (solar) tags.appendChild(el('span', 'tag', t('solarSystem')));
    if (p.flags & PlanetFlag.POTENTIALLY_HABITABLE) tags.appendChild(el('span', 'tag habitable', t('potentiallyHabitable')));
    this.root.appendChild(tags);

    const dl = el('dl');
    const row = (k: string, v: string) => dl.append(el('dt', '', k), el('dd', '', v));
    // below 1 AU also in kilometres (TRAPPIST-1 b: 0.0115 AU, 1.72 million km); a moon's in km
    if (parent) row(t('semiMajorAxis'), formatKm(p.a * KM_PER_AU));
    else row(t('semiMajorAxis'), `${sig(p.a)} ${t('au')}${p.a < 1 ? ` (${formatKm(p.a * KM_PER_AU)})` : ''}`);
    row(t('eccentricity'), p.flags & PlanetFlag.ECCENTRICITY_ASSUMED ? t('assumedCircular') : sig(p.e));
    // where the orbit lies relative to the star's habitable zone (its narrower limits shown)
    const hz = parent ? null : cat.hosts[p.host].hz;
    if (hz) {
      const where: MessageKey =
        p.flags & PlanetFlag.HABITABLE_ZONE_CONSERVATIVE ? 'hzInside' : p.flags & PlanetFlag.HABITABLE_ZONE ? 'hzEdge' : p.a < hz[1] ? 'hzInner' : 'hzOuter';
      row(t('habitableZone'), `${t(where)} · ${sig(hz[1])}–${sig(hz[2])} ${t('au')}`);
    }
    row(t('orbitalPeriod'), p.period >= 1000 ? t('yearsN', { n: sig(p.period / 365.25) }) : t('daysN', { n: sig(p.period) }));
    if (parent) {
      // a moon's radius in km (the small ones without a measured size: about a few km)
      if (!(p.flags & PlanetFlag.RADIUS_ESTIMATED)) row(t('planetRadius'), `${formatNumber(p.radius * EARTH_RADIUS_KM, p.radius * EARTH_RADIUS_KM < 100 ? 1 : 0)} km`);
    } else if (Number.isFinite(p.radius)) {
      row(t('planetRadius'), `${sig(p.radius)} R⊕${p.flags & PlanetFlag.RADIUS_ESTIMATED ? ` (${t('estimatedFromMass')})` : ''}`);
    }
    if (Number.isFinite(p.mass)) row(t('planetMass'), `${sig(p.mass)} M⊕`);
    if (Number.isFinite(p.eqt)) row(t('eqTemperature'), `${formatNumber(p.eqt, 0)} K`);
    if (Number.isFinite(p.incl) && !(p.flags & PlanetFlag.INCLINATION_ASSUMED)) {
      // (the Earth's -0.00002 deg: 0)
      // (a moon's to its reference plane: the ecliptic, its planet's equator or its Laplace plane)
      row(parent ? t('inclinationMoon') : solar ? t('inclinationEcliptic') : t('inclinationSky'), `${sig(Math.abs(p.incl) < 0.005 ? 0 : p.incl)}°`);
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
    this.dateEl = el('p', 'hint card-date', this.dateText ? t('planetDate', { date: this.dateText }) : '');
    this.dateEl.setAttribute('aria-live', 'off');
    this.root.appendChild(this.dateEl);

    const actions = el('div', 'info-actions');
    const fly = el('button', 'btn', t('flyTo'));
    fly.title = t('flyToHint');
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
