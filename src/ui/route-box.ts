import { formatLy, formatNumber, t } from '../i18n';
import type { RouteEnd, RouteResult, RouteStatus, Waypoint } from '../network/planner';
import type { RouteMode } from '../network/route';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface RouteBoxState {
  from: RouteEnd | null;
  to: RouteEnd | null;
  mode: RouteMode;
  status: RouteStatus;
  /** The route drawn (kept while a recomputation runs). */
  route: RouteResult | null;
}

/** Display names of route ends and waypoints (in the current language). */
export interface RouteNames {
  end: (e: RouteEnd) => string;
  waypoint: (w: Waypoint) => string;
}

const rangeText = (r: number) => `${formatNumber(r, Number.isInteger(r) ? 0 : 1)} ${t('ly')}`;

export function jumpsText(n: number): string {
  return n === 1 ? t('routeJumpsOne') : t('routeJumps', { n: formatNumber(n) });
}

/** Status text of the route box and whether it reports a problem. */
export function routeStatusText(s: RouteBoxState, names: RouteNames): { text: string; warn: boolean } {
  const st = s.status;
  const name = (e: RouteEnd | null) => (e ? names.end(e) : '');
  const closest = (r: RouteResult | null) =>
    r && r.waypoints.length
      ? ' ' + t('routeClosest', { place: names.waypoint(r.waypoints[r.waypoints.length - 1]), d: formatLy(r.short) })
      : '';
  switch (st.kind) {
    case 'empty':
      return { text: '', warn: false };
    case 'incomplete':
      return { text: s.from ? t('routeChooseTo') : t('routeChooseFrom'), warn: false };
    case 'waiting':
      return { text: t('routeWaiting'), warn: false };
    case 'loading':
      if (st.width === 0) return { text: t('routeLoadingEnds'), warn: false };
      return {
        text: t('routeLoading', {
          loaded: formatNumber(st.loaded),
          total: formatNumber(st.total),
          mb: formatNumber(st.loadedBytes / 1e6, 1),
          totalMb: formatNumber(st.totalBytes / 1e6, 1),
        }),
        warn: false,
      };
    case 'computing':
      return { text: t('routeComputing', { w: formatLy(st.width) }), warn: false };
    case 'found': {
      const r = st.route;
      const text = `${jumpsText(r.jumps)} · ${formatLy(r.total)} · ${t('routeStraight', { d: formatLy(r.straight) })}`;
      return { text, warn: false };
    }
    case 'unreachable':
      return { text: t('routeUnreachable', { to: name(s.to), range: rangeText(st.route.range) }) + closest(st.route), warn: true };
    case 'refused': {
      const key = st.reason === 'places' ? 'routeTooManyPlaces' : st.reason === 'pairs' ? 'routeTooManyPairs' : 'routeTooMuchData';
      return { text: t(key, { w: formatLy(st.width) }) + closest(st.route), warn: true };
    }
    case 'missing':
      return { text: t('routeMissing', { name: name(st.end === 'from' ? s.from : s.to) }), warn: true };
    case 'notFound':
      return { text: t('routeNotFound', { name: name(st.end === 'from' ? s.from : s.to) }), warn: true };
    case 'failed':
      return { text: st.tiles === 1 ? t('routeFailedOne') : t('routeFailed', { n: formatNumber(st.tiles) }), warn: true };
    case 'error':
      return { text: t('routeError'), warn: true };
  }
}

/**
 * The route box (bottom left, above the legend): start → destination, status, swap, mode, the
 * list of waypoints, "show whole route" and remove. Built once; updates change texts in place,
 * so clicks and keyboard focus survive progress updates.
 */
export class RouteBox {
  readonly root: HTMLElement;
  onSwap: () => void = () => {};
  onMode: (mode: RouteMode) => void = () => {};
  onShowAll: () => void = () => {};
  onRemove: () => void = () => {};
  onRetry: () => void = () => {};
  /** A waypoint of the list was picked (index into the route's waypoints). */
  onPick: (index: number) => void = () => {};

  private readonly title = el('h3', 'sr-only');
  private readonly removeBtn = el('button', 'icon-btn small', '×');
  private readonly fromEl = el('span', 'route-end');
  private readonly toEl = el('span', 'route-end');
  private readonly swapBtn = el('button', 'icon-btn small route-swap', '⇄');
  private readonly modeSel = el('select');
  private readonly statusEl = el('p', 'route-status');
  private readonly progress = el('div', 'route-progress');
  private readonly bar = el('div');
  private readonly retryBtn = el('button', 'btn small');
  private readonly showAllBtn = el('button', 'btn small');
  private readonly listBtn = el('button', 'btn small subtle');
  private readonly list = el('ol', 'route-list');
  private expanded = false;
  /** The route whose waypoints the list shows, and whether its items are built. */
  private listRoute: RouteResult | null = null;
  private listBuilt = false;
  private state: RouteBoxState | null = null;
  private names: RouteNames | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('section', 'route-box hidden');
    this.root.setAttribute('aria-labelledby', 'route-title');
    this.title.id = 'route-title';
    // one row: start → destination, swap, remove (the title is for screen readers)
    const head = el('div', 'route-head');
    const ends = el('div', 'route-ends');
    ends.append(this.fromEl, el('span', 'route-arrow', '→'), this.toEl);
    this.swapBtn.addEventListener('click', () => this.onSwap());
    this.removeBtn.addEventListener('click', () => this.onRemove());
    head.append(ends, this.swapBtn, this.removeBtn);

    const controls = el('div', 'route-controls');
    for (const m of ['jumps', 'distance'] as const) {
      const o = el('option');
      o.value = m;
      this.modeSel.appendChild(o);
    }
    this.modeSel.addEventListener('change', () => this.onMode(this.modeSel.value as RouteMode));
    this.showAllBtn.addEventListener('click', () => this.onShowAll());
    this.listBtn.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this.renderList();
    });
    this.retryBtn.addEventListener('click', () => this.onRetry());
    controls.append(this.modeSel, this.showAllBtn, this.listBtn, this.retryBtn);

    this.statusEl.setAttribute('aria-live', 'polite');
    this.progress.appendChild(this.bar);
    this.list.id = 'route-waypoints';
    this.listBtn.setAttribute('aria-controls', this.list.id);
    this.root.append(this.title, head, this.statusEl, this.progress, controls, this.list);
    parent.appendChild(this.root);
    this.updateTexts();
  }

  /** Static texts in the current language. */
  updateTexts(): void {
    this.title.textContent = t('routeTitle');
    this.removeBtn.setAttribute('aria-label', t('routeRemove'));
    this.removeBtn.title = t('routeRemove');
    this.swapBtn.setAttribute('aria-label', t('routeSwap'));
    this.swapBtn.title = t('routeSwap');
    this.modeSel.setAttribute('aria-label', t('routeMode'));
    this.modeSel.options[0].textContent = t('routeModeJumps');
    this.modeSel.options[1].textContent = t('routeModeDistance');
    this.showAllBtn.textContent = t('routeShowAll');
    this.retryBtn.textContent = t('routeRetry');
    this.listBuilt = false;
    if (this.state && this.names) this.update(this.state, this.names);
  }

  update(state: RouteBoxState, names: RouteNames): void {
    this.state = state;
    this.names = names;
    const st = state.status;
    this.root.classList.toggle('hidden', st.kind === 'empty');
    if (st.kind === 'empty') return;
    const end = (e: RouteEnd | null, which: 'from' | 'to') => {
      const elm = which === 'from' ? this.fromEl : this.toEl;
      elm.textContent = e ? names.end(e) : t(which === 'from' ? 'routeNoStart' : 'routeNoGoal');
      elm.classList.toggle('unset', !e);
    };
    end(state.from, 'from');
    end(state.to, 'to');
    this.swapBtn.disabled = !state.from || !state.to;
    if (this.modeSel.value !== state.mode) this.modeSel.value = state.mode;
    const { text, warn } = routeStatusText(state, names);
    if (this.statusEl.textContent !== text) this.statusEl.textContent = text;
    this.statusEl.classList.toggle('warn', warn);
    const busy = st.kind === 'loading' || st.kind === 'computing' || st.kind === 'waiting';
    this.root.classList.toggle('busy', busy);
    this.progress.hidden = st.kind !== 'loading';
    if (st.kind === 'loading') this.bar.style.width = `${Math.round((100 * st.loadedBytes) / Math.max(st.totalBytes, 1))}%`;
    this.retryBtn.hidden = st.kind !== 'failed';
    const route = state.route;
    this.showAllBtn.hidden = !route;
    this.listBtn.hidden = !route;
    this.modeSel.hidden = !state.from || !state.to;
    if (route !== this.listRoute) {
      this.listRoute = route;
      this.listBuilt = false;
    }
    this.renderList();
  }

  private renderList(): void {
    const route = this.listRoute;
    const names = this.names;
    this.listBtn.textContent = route ? t('routeWaypoints', { n: formatNumber(route.waypoints.length) }) + (this.expanded ? ' ▴' : ' ▾') : '';
    this.listBtn.setAttribute('aria-expanded', String(this.expanded && !!route));
    this.list.hidden = !this.expanded || !route;
    if (this.list.hidden || !route || !names || this.listBuilt) return;
    this.listBuilt = true;
    this.list.replaceChildren();
    route.waypoints.forEach((w, k) => {
      const li = el('li');
      const btn = el('button', 'jump-link');
      btn.type = 'button';
      btn.append(el('span', 'route-step', String(k)), el('span', 'jump-name', names.waypoint(w)), el('span', 'jump-dist', k > 0 ? formatLy(w.jump) : ''));
      btn.addEventListener('click', () => {
        // on a phone the list would cover the star the view flies to
        if (window.matchMedia?.('(max-width: 700px)').matches) {
          this.expanded = false;
          this.renderList();
        }
        this.onPick(k);
      });
      li.appendChild(btn);
      this.list.appendChild(li);
    });
  }
}
