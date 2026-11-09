import { probePosition, probeSpeed, type ProbeCatalogue } from '../data/probes';
import { AU_PER_LY } from '../data/planets';
import { formatLy, formatNumber, getLang, t, type MessageKey } from '../i18n';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Each probe's story and its mission page. */
const STORIES: Record<string, { text: MessageKey; url: string }> = {
  pioneer10: { text: 'probePioneer10', url: 'https://science.nasa.gov/mission/pioneer-10/' },
  pioneer11: { text: 'probePioneer11', url: 'https://science.nasa.gov/mission/pioneer-11/' },
  voyager1: { text: 'probeVoyager1', url: 'https://science.nasa.gov/mission/voyager/' },
  voyager2: { text: 'probeVoyager2', url: 'https://science.nasa.gov/mission/voyager/' },
  newhorizons: { text: 'probeNewHorizons', url: 'https://science.nasa.gov/mission/new-horizons/' },
};

/** The time a radio signal takes, in hours, days or years. */
export function signalTimeText(hours: number): string {
  if (hours < 48) return t('hoursN', { n: formatNumber(hours, 1) });
  const days = hours / 24;
  if (days < 730) return t('daysN', { n: formatNumber(days, days < 10 ? 1 : 0) });
  const years = days / 365.25;
  return t('yearsN', { n: formatNumber(years, years < 10 ? 1 : 0) });
}

/** Light minutes per AU. */
const LIGHT_MINUTES_PER_AU = 8.316746;

/** The card of a selected spacecraft (in the same place as the star card). */
export class ProbeCard {
  readonly root: HTMLElement;
  private cat: ProbeCatalogue | null = null;
  private index: number | null = null;
  private jd = 0;
  private dateText = '';
  private dl: HTMLElement | null = null;
  private dateEl: HTMLElement | null = null;
  onClose: () => void = () => {};
  onFlyTo: (i: number) => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = el('section', 'info-card probe-card hidden');
    this.root.setAttribute('aria-live', 'polite');
    parent.appendChild(this.root);
  }

  get current(): number | null {
    return this.index;
  }

  /** `jd`: the date the probes are drawn for; `date`: its text. */
  show(cat: ProbeCatalogue | null, i: number | null, jd = 0, date = ''): void {
    this.cat = cat;
    this.index = cat ? i : null;
    this.jd = jd;
    this.dateText = date;
    this.render();
  }

  /** The distance, speed and date for a new date (without rebuilding the card). */
  update(jd: number, date: string): void {
    this.jd = jd;
    if (this.dl) this.fillRows(this.dl);
    if (date !== this.dateText) {
      this.dateText = date;
      if (this.dateEl) this.dateEl.textContent = date ? t('planetDate', { date }) : '';
    }
  }

  private rowsText = '';

  private fillRows(dl: HTMLElement): void {
    const cat = this.cat;
    const i = this.index;
    if (!cat || i === null) return;
    const probe = cat.probes[i];
    const rows: [string, string][] = [];
    const [y, m, d] = probe.launch.split('-').map(Number);
    rows.push([t('launched'), new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(getLang(), { timeZone: 'UTC' })]);
    const pos = probePosition(probe, this.jd);
    if (pos) {
      const ly = pos.length();
      const au = ly * AU_PER_LY;
      // far out (after a long flight): light years
      rows.push([t('distanceFromSun'), ly >= 0.1 ? formatLy(ly) : `${formatNumber(au, au < 100 ? 1 : 0)} ${t('au')}`]);
      rows.push([t('signalTime'), signalTimeText((au * LIGHT_MINUTES_PER_AU) / 60)]);
      const v = probeSpeed(probe, this.jd);
      if (Number.isFinite(v)) rows.push([t('speedToSun'), `${formatNumber(v, 1)} km/s`]);
    }
    // rebuilt only when a value changes (the clock runs every frame)
    const text = rows.flat().join('\n');
    if (text === this.rowsText && dl.childElementCount) return;
    this.rowsText = text;
    dl.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', '', k), el('dd', '', v)]));
  }

  private render(): void {
    const cat = this.cat;
    const i = this.index;
    this.root.replaceChildren();
    this.dl = null;
    this.root.classList.toggle('hidden', !cat || i === null);
    if (!cat || i === null) return;
    const probe = cat.probes[i];
    const story = STORIES[probe.key];

    const head = el('div', 'info-head');
    const titles = el('div');
    const title = el('h2', '', probe.name);
    title.tabIndex = -1;
    titles.appendChild(title);
    const close = el('button', 'icon-btn', '×');
    close.setAttribute('aria-label', t('close'));
    close.addEventListener('click', () => this.onClose());
    head.append(titles, close);
    this.root.appendChild(head);

    const tags = el('div', 'tags');
    tags.appendChild(el('span', 'tag', t('probe')));
    this.root.appendChild(tags);

    const dl = el('dl');
    // the values follow the clock: not read out at every change
    dl.setAttribute('aria-live', 'off');
    this.dl = dl;
    this.rowsText = '';
    this.fillRows(dl);
    this.root.appendChild(dl);
    this.dateEl = el('p', 'hint card-date', this.dateText ? t('planetDate', { date: this.dateText }) : '');
    this.dateEl.setAttribute('aria-live', 'off');
    this.root.appendChild(this.dateEl);
    if (story) this.root.appendChild(el('p', 'probe-story', t(story.text)));

    const actions = el('div', 'info-actions');
    const fly = el('button', 'btn', t('flyTo'));
    fly.addEventListener('click', () => this.onFlyTo(i));
    actions.appendChild(fly);
    if (story) {
      const a = el('a', 'btn subtle', t('missionPage'));
      a.href = story.url;
      a.target = '_blank';
      a.rel = 'noopener';
      actions.appendChild(a);
    }
    this.root.appendChild(actions);
  }
}
