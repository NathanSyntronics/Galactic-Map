import { Color, MathUtils, Matrix4, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { Navigation } from './controls/navigation';
import { SPRITE_CORE, pickScore } from './controls/pick';
import { TapDetector } from './controls/tap';
import { AttributeStore } from './data/attributes';
import { Flag, designationOf, type NodeData } from './data/format';
import { decodeCsv } from './data/csv';
import { NO_LOOKUP, csvNeedsLookup, exportCsv, importCsv, type ImportReport, type StarResolver } from './data/importer';
import { galacticToWorld, worldToGalactic } from './data/galactic';
import {
  HttpError,
  NodeLoader,
  Octree,
  isPermanentError,
  retryDelay,
  selectWithMargin,
  type Manifest,
  type OctreeNode,
} from './data/octree';
import { formatLy, formatNumber, jumpStatsText, localName, setLang, t, type MessageKey } from './i18n';
import {
  MAX_PAIRS,
  MAX_PLACES,
  attributeCapacity,
  computeNetwork,
  jumpMargin,
  linksOfStar,
  networkServes,
  placeOfStar,
  type CapacityRule,
  type JumpNetwork,
  type NetworkOptions,
} from './network/places';
import { ROUTE_STORAGE_KEY, RoutePlanner, parseStoredRoute, type RouteEnd, type RouteResult, type StoredRoute, type Waypoint } from './network/planner';
import { JumpLines } from './render/links';
import { DropLines, Marker, PolarGrid } from './render/overlays';
import { RouteLine, fitDistance, routeBounds } from './render/route';
import { Starfield, apparentMag, computeStyle, spritePx, starLogL } from './render/starfield';
import {
  SIZE_LUMINOSITY,
  SIZE_UNIFORM,
  attributeInfo,
  buildPlan,
  numericScale,
  planetsOf,
  valueGetter,
  type StylePlan,
} from './render/style';
import {
  QUALITY_BUDGET,
  RADIUS_MAX,
  RADIUS_MIN,
  SettingsStore,
  distanceForRadius,
  followZoom,
  type Settings,
} from './settings';
import { AttributesDialog } from './ui/attributes-dialog';
import { InfoPanel, displayName, type JumpListing, type StarInfo } from './ui/info';
import { Legend } from './ui/legend';
import { LabelLayer, TopK, namedCandidateLimit, onScreen, starPriority, type LabelCandidate } from './ui/labels';
import { SettingsPanel } from './ui/panel';
import { RouteBox, type RouteNames } from './ui/route-box';
import { SearchBox, SearchIndex, type SearchHit, type SearchTuple } from './ui/search';

interface DownloadsApi {
  save(request: { filename: string; data: string }): Promise<unknown>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Node path and star index of a StarInfo key ("path:index"). */
function parseStarKey(key: string): { path: string; i: number } {
  const k = key.lastIndexOf(':');
  return { path: key.slice(0, k), i: Number(key.slice(k + 1)) };
}

/** Settings that change which stars are shown (and so the jump network). */
const VISIBILITY_KEYS: (keyof Settings)[] = ['showBrownDwarfs', 'showWhiteDwarfs', 'maxDistErr', 'colorBy', 'sizeBy', 'missingStyle'];
/** Settings that change the jump network (the radius only when the network no longer serves, see networkServes). */
const JUMP_KEYS: (keyof Settings)[] = ['jumps', 'jumpRange', 'jumpFaint', 'jumpSun', 'jumpBright', 'jumpBy', 'jumpHub', 'jumpConnect'];
/** Settings that change the route (besides hiding stars without a value of the data layers). */
const ROUTE_KEYS: (keyof Settings)[] = [
  'jumpRange',
  'jumpFaint',
  'jumpSun',
  'jumpBright',
  'jumpBy',
  'jumpHub',
  'jumpConnect',
  'showBrownDwarfs',
  'showWhiteDwarfs',
  'maxDistErr',
  'missingStyle',
];
/** The route is computed again this long after the last change of a setting (sliders change continuously). */
const ROUTE_DELAY_MS = 400;
/** Two taps within this time and 30 px make a double-tap. */
const DOUBLE_TAP_MS = 350;


function readStoredRoute(): StoredRoute | null {
  try {
    return parseStoredRoute(localStorage.getItem(ROUTE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function saveRoute(r: StoredRoute): void {
  try {
    if (r.from || r.to) localStorage.setItem(ROUTE_STORAGE_KEY, JSON.stringify(r));
    else localStorage.removeItem(ROUTE_STORAGE_KEY);
  } catch {
    // storage unavailable: the route is simply not kept
  }
}

export class App {
  private readonly store = new SettingsStore();
  private readonly attrs = new AttributeStore();
  private stylePlan: StylePlan;
  private styleDirty = false;
  private lastStyle = 0;
  private readonly legend: Legend;
  private attrDialog: AttributesDialog | null = null;
  /** The site's own attribute dataset (public/user/attributes.csv), if it has one. */
  private siteData: string | null = null;
  private systemPrimaries: Promise<Map<number, string>> | null = null;
  private saveWarned = false;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly nav: Navigation;
  private readonly starfield: Starfield;
  private readonly grid = new PolarGrid();
  private readonly dropLines = new DropLines();
  private readonly selMarker = new Marker(0xffc861, 30);
  private readonly jumpLines = new JumpLines();
  private readonly planner: RoutePlanner<OctreeNode>;
  private readonly routeLine = new RouteLine();
  private readonly routeBox: RouteBox;
  /** Nodes the route planner waits for (requested in addition to the view's). */
  private routeNodes: OctreeNode[] = [];
  /** The route drawn: the planner's last result. */
  private route: RouteResult | null = null;
  /**
   * A route is drawn and the visible radius is larger than three jump ranges: only the route is
   * drawn, the jump network is neither drawn nor computed (docs/ROUTES.md).
   */
  private routeOnly = false;
  /** The jump network needs to be recomputed. */
  private jumpDirty = true;
  /** The radius changed or the selection lost nodes: recomputed only if the network no longer serves. */
  private jumpCheck = false;
  private lastJump = -Infinity;
  /** Duration of the last network computation (ms); recomputations are spaced by a multiple of it. */
  private jumpCost = 0;
  /** Time of the last view change; a slow network computation waits until the view rests. */
  private lastViewChange = -Infinity;
  /** Time of the last radius change (zoom while the radius follows it). */
  private lastRadiusChange = -Infinity;
  /** The level of detail holds all stars of the network region (not cut by the point budget). */
  private jumpRegion = false;
  /**
   * The last network exceeded the limits: the level of detail goes back to the visible sphere
   * until a setting changes, the radius shrinks by 10 % or the view centre moves by more than the radius.
   */
  private jumpBlocked: { kind: 'places' | 'pairs'; centre: Vector3; radius: number } | null = null;
  /** The radius is being set from the zoom (radius follows zoom), not by the user. */
  private followingZoom = false;
  /** Stable number per octree node path (tie-break keys of the network). */
  private readonly nodeOrdinal = new Map<string, number>();
  private readonly labels: LabelLayer;
  private readonly panel: SettingsPanel;
  private readonly info: InfoPanel;
  private readonly searchIndex = new SearchIndex();
  private readonly search: SearchBox;
  private readonly status: HTMLElement;
  private readonly loadingEl: HTMLElement;
  /** Message shown in the loading box (kept so a language switch shows the same message). */
  private loadingKey: MessageKey = 'loading';
  private readonly menuBtn: HTMLButtonElement;
  private readonly helpBtn: HTMLButtonElement;
  private readonly dialog: HTMLDialogElement;
  private readonly baseUrl: string;

  private manifest: Manifest | null = null;
  private octree: Octree | null = null;
  private loader: NodeLoader | null = null;
  /** The search index load (true: loaded); reset after a failure, so the next use tries again. */
  private searchLoaded: Promise<boolean> | null = null;
  private selected: StarInfo | null = null;
  private pendingSelect: SearchHit | null = null;

  private lodDirty = true;
  private lastLod = 0;
  private candidatesDirty = true;
  private lastCandidates = 0;
  private selectedPaths = new Set<string>();
  private inView = 0;
  private lastTime = performance.now();
  private hashTimer = 0;
  private lastTap = { time: 0, x: 0, y: 0 };
  private readonly viewProj = new Matrix4();

  constructor(private readonly container: HTMLElement) {
    this.baseUrl = `${import.meta.env.BASE_URL}data/`;
    setLang(this.store.get().lang);
    document.title = t('appTitle');

    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(new Color(0x02040b));
    this.renderer.domElement.className = 'gl-canvas';
    container.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(55, 1, 0.001, 1e6);
    this.nav = new Navigation(this.camera, this.renderer.domElement);
    const stored = AttributeStore.readStored();
    if (stored) this.attrs.load(stored, false);
    this.stylePlan = buildPlan(this.store.get(), this.attrs);
    this.starfield = new Starfield(
      () => this.store.get(),
      () => this.stylePlan,
    );

    this.scene.add(
      this.grid.group,
      this.dropLines.lines,
      this.jumpLines.group,
      this.routeLine.group,
      this.starfield.group,
      this.selMarker.points,
    );

    this.labels = new LabelLayer(container);

    // --- UI chrome. The settings panel does not subscribe to the store itself: settingsChanged()
    // switches the language first and then lets the panel re-render.
    const top = el('header', 'topbar');
    const menuBtn = el('button', 'icon-btn menu-btn', '☰');
    menuBtn.setAttribute('aria-label', t('settings'));
    menuBtn.addEventListener('click', () => this.panel.toggle());
    this.menuBtn = menuBtn;
    const title = el('div', 'app-title', t('appTitle'));
    top.append(menuBtn, title);
    container.appendChild(top);
    this.search = new SearchBox(top, this.searchIndex);
    const helpBtn = el('button', 'icon-btn help-btn', '?');
    helpBtn.setAttribute('aria-label', t('help'));
    helpBtn.addEventListener('click', () => this.showHelp());
    this.helpBtn = helpBtn;
    top.appendChild(helpBtn);

    // while it is open, a press anywhere beside the panel only closes it; the wheel still zooms
    this.panel = new SettingsPanel(container, this.store, this.attrs);
    this.panel.onScrimWheel = (e) => this.renderer.domElement.dispatchEvent(new WheelEvent('wheel', e));
    this.panel.onManageAttributes = () => this.showAttributes();
    this.panel.onGoToSun = () => this.goToSun();
    this.panel.onHelp = () => this.showHelp();
    this.panel.onAbout = () => this.showAbout();

    this.info = new InfoPanel(container, this.attrs);
    this.catchSecondTap(this.info.root);
    this.info.onManageAttributes = () => this.showAttributes();
    this.info.onClose = () => this.select(null);
    this.info.onFlyTo = (info) => this.nav.flyTo(info.pos);
    this.info.jumpsOf = (info) => this.jumpListing(info);
    this.info.onRoute = (info, end) => this.planner.setEnd(end, this.routeEnd(info));

    // bottom left: the route box above the legend
    const stack = el('div', 'bottom-left');
    container.appendChild(stack);
    this.catchSecondTap(stack);
    this.routeBox = new RouteBox(stack);
    this.legend = new Legend(stack);
    this.planner = new RoutePlanner<OctreeNode>(
      {
        root: () => this.octree?.root ?? null,
        node: (path) => this.octree?.nodes.get(path),
        want: (nodes) => {
          this.routeNodes = nodes;
          this.lodDirty = true;
        },
        data: (path) => this.loader?.get(path),
        failed: (path) => this.loader?.hasFailed(path) ?? false,
        retry: (path) => this.loader?.retry(path),
        options: () => {
          const s = this.store.get();
          return { range: s.jumpRange, hub: s.jumpHub, kSun: s.jumpSun, connect: s.jumpConnect, capacity: this.capacityRule(s) };
        },
        style: (data, colors, sizes) => computeStyle(data, this.store.get(), this.stylePlan, colors, sizes),
        nodeKey: (path) => this.nodeOrdinal.get(path) ?? 0,
        // an exact lookup (find() would also take other spellings); a failed index load is reported
        find: async (designation) => {
          if (!(await this.loadSearch())) throw new Error('search index unavailable');
          const e = this.searchIndex.byPrimary(designation);
          return e ? { path: e[2], index: e[3] } : null;
        },
        save: saveRoute,
      },
      readStoredRoute(),
    );
    this.planner.onChange = () => this.routeChanged();
    this.routeBox.onSwap = () => this.planner.swap();
    this.routeBox.onMode = (mode) => this.planner.setMode(mode);
    this.routeBox.onRemove = () => this.planner.clear();
    this.routeBox.onRetry = () => this.planner.retry();
    this.routeBox.onShowAll = () => this.showWholeRoute();
    this.routeBox.onPick = (k) => this.pickWaypoint(k);
    this.placeAboveCard();

    this.updateLegend();
    this.attrs.subscribe((kind) => this.attributesChanged(kind));
    this.attrs.onSaveError = () => {
      if (this.saveWarned) return;
      this.saveWarned = true;
      this.toast(t('saveFailed'));
    };

    this.status = el('div', 'status');
    container.appendChild(this.status);
    this.loadingEl = el('div', 'loading', t('loading'));
    container.appendChild(this.loadingEl);
    this.dialog = el('dialog', 'dialog');
    container.appendChild(this.dialog);
    this.closeOnBackdrop(this.dialog);

    this.search.onPick = (hit) => this.pickSearch(hit);
    this.search.loadIndex = () => this.loadSearch();

    this.nav.onChange = () => {
      this.lastViewChange = performance.now();
      this.lodDirty = true;
      this.candidatesDirty = true;
      this.scheduleHash();
    };
    this.nav.onShortcut = (key, e) => this.shortcut(key, e);

    this.store.subscribe((s, changed) => this.settingsChanged(s, changed));
    this.setupPointer();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('hashchange', () => this.applyHash());
    this.resize();
    this.applySettings(this.store.get());
    this.applyHash(true);
    this.routeChanged();
  }

  async start(): Promise<void> {
    try {
      this.manifest = await this.fetchManifest();
    } catch (err) {
      console.error(err);
      this.showLoadError(err instanceof HttpError && err.status === 404 ? 'noData' : 'loadError');
      this.loop();
      return;
    }
    this.octree = new Octree(this.manifest);
    let k = 0;
    for (const path of this.octree.nodes.keys()) this.nodeOrdinal.set(path, k++);
    this.loader = new NodeLoader(this.baseUrl, this.manifest.packs);
    this.loader.onLoaded = (node, data) => this.nodeLoaded(node, data);
    this.loader.onEvicted = (path) => {
      if (this.starfield.get(path)?.points.visible) this.jumpDirty = true;
      this.starfield.remove(path);
    };
    this.loader.onFailed = (node) => this.nodeFailed(node);
    this.lodDirty = true;
    // a route kept from the last visit
    this.planner.invalidate();
    this.loop();
    // fetched for everyone (it is small), so that visitors with data of their own can go back to it;
    // the shipped one has exact keys, so applying it loads no search index
    void this.loadSiteData(!AttributeStore.readStored());
  }

  // ------------------------------------------------------------------ user attributes

  /** Loads the site's attribute dataset; `apply`: shows it (visitors without data of their own). */
  private async loadSiteData(apply: boolean): Promise<void> {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}user/attributes.csv`);
      if (!res.ok) return;
      const text = await res.text();
      // dev servers answer unknown paths with the app page
      if (/^\s*</.test(text)) return;
      this.siteData = text;
      if (apply) await this.applySiteData();
    } catch (err) {
      console.warn('site attributes unavailable', err);
    }
  }

  private async applySiteData(): Promise<void> {
    if (!this.siteData) return;
    // a dataset with exact keys (the shipped one) needs neither the search index nor systems.json
    const resolver = csvNeedsLookup(this.siteData) ? await this.resolver() : NO_LOOKUP;
    // the site dataset is not saved as the visitor's own data: site updates keep reaching them
    this.attrs.withoutSaving(() => {
      this.attrs.load({ v: 1, defs: [], values: {} }, false);
      importCsv(this.siteData!, this.attrs, resolver);
    });
  }

  /** Name and designation lookup for CSV imports (loads the search index and systems.json). */
  private async resolver(): Promise<StarResolver> {
    await this.loadSearch();
    if (!this.systemPrimaries) {
      this.systemPrimaries = (async () => {
        const m = new Map<number, string>();
        try {
          const res = await fetch(`${this.baseUrl}systems.json`);
          if (res.ok) {
            const sys = (await res.json()) as Record<string, unknown[]>;
            for (const [k, v] of Object.entries(sys)) if (typeof v[6] === 'string') m.set(Number(k), v[6]);
          }
        } catch (err) {
          console.warn('systems.json unavailable', err);
        }
        return m;
      })();
    }
    const primaries = await this.systemPrimaries;
    return {
      star: (key) => {
        const e = this.searchIndex.find(key);
        return e && e[9] ? { designation: e[9], system: e[10] ?? -1 } : null;
      },
      systemPrimary: (sid) => primaries.get(sid) ?? null,
    };
  }

  private attributesChanged(kind: 'defs' | 'values' | 'scales'): void {
    const s = this.store.get();
    if (kind === 'defs') {
      // a deleted (or retyped) attribute no longer colours or sizes the map
      const patch: Partial<Settings> = {};
      if (s.colorBy && !attributeInfo(s.colorBy, this.attrs)) patch.colorBy = '';
      const size = s.sizeBy !== SIZE_LUMINOSITY && s.sizeBy !== SIZE_UNIFORM ? attributeInfo(s.sizeBy, this.attrs) : undefined;
      if (size === null || (size && size.type !== 'number')) patch.sizeBy = SIZE_LUMINOSITY;
      if (s.jumpBy && attributeInfo(s.jumpBy, this.attrs)?.type !== 'number') patch.jumpBy = '';
      if (Object.keys(patch).length) this.store.set(patch);
      this.panel.attributesChanged();
    }
    this.stylePlan = buildPlan(this.store.get(), this.attrs);
    this.styleDirty = true;
    // capacities by attribute and hidden stars
    this.jumpDirty = true;
    this.planner.styleChanged();
    if (s.jumpBy || s.missingStyle === 'hide') this.planner.invalidate(ROUTE_DELAY_MS);
    if (this.jumpBlocked && s.missingStyle === 'hide') {
      this.jumpBlocked = null;
      this.lodDirty = true;
    }
    this.updateLegend();
    if (!this.info.editing) this.info.rerender(this.nav.target);
  }

  private showAttributes(): void {
    this.attrDialog = new AttributesDialog(this.attrs, {
      importCsv: async (file, replace) => this.importFile(file, replace),
      exportCsv: async () => this.exportFile(),
      hasSiteData: () => this.siteData !== null,
      resetToSite: async () => {
        this.attrs.clearStored();
        await this.applySiteData();
      },
      deleteAll: () => {
        this.attrs.load({ v: 1, defs: [], values: {} });
        this.attrs.saveNow();
      },
    });
    this.panel.toggle(false);
    this.openDialog(t('attributes'), this.attrDialog.body);
  }

  private async importFile(file: File, replace: boolean): Promise<ImportReport> {
    const text = decodeCsv(await file.arrayBuffer());
    const resolver = csvNeedsLookup(text) ? await this.resolver() : NO_LOOKUP;
    return importCsv(text, this.attrs, resolver, replace);
  }

  private async exportFile(): Promise<void> {
    await this.loadSearch();
    const lang = this.store.get().lang;
    const csv = exportCsv(
      this.attrs,
      {
        name: (d) => {
          const e = this.searchIndex.byPrimary(d);
          return e ? localName(e[0], e[1]) : null;
        },
      },
      lang,
    );
    const filename = lang === 'de' ? 'galaktische-karte-attribute.csv' : 'galactic-map-attributes.csv';
    // inside the claude.ai artifact viewer, files are handed over by its downloads capability
    const viewer = (window as { claude?: { use?: (name: string) => Promise<unknown> } }).claude;
    const downloads = viewer?.use ? ((await viewer.use('downloads')) as DownloadsApi | null) : null;
    if (downloads) {
      try {
        await downloads.save({ filename, data: csv });
      } catch (err) {
        if ((err as { code?: string })?.code !== 'declined') throw err;
      }
      return;
    }
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  /** A short message at the bottom of the screen. */
  private toast(text: string): void {
    const box = el('div', 'toast', text);
    box.setAttribute('role', 'alert');
    this.container.appendChild(box);
    setTimeout(() => box.remove(), 9000);
  }

  /** Loads the manifest, retrying transient failures a few times. */
  private async fetchManifest(): Promise<Manifest> {
    const url = `${this.baseUrl}manifest.json`;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new HttpError(res.status, url);
        return (await res.json()) as Manifest;
      } catch (err) {
        if (isPermanentError(err) || err instanceof SyntaxError || attempt >= 4) throw err;
        console.warn(`manifest: attempt ${attempt} failed, retrying`, err);
        await new Promise((r) => setTimeout(r, retryDelay(attempt)));
      }
    }
  }

  private showLoadError(key: MessageKey): void {
    this.loadingKey = key;
    this.loadingEl.textContent = t(key);
    this.loadingEl.classList.add('error');
    this.loadingEl.classList.remove('hidden');
  }

  /** The search index is loaded on first use of the search box; resolves to false if it could not be loaded. */
  private loadSearch(): Promise<boolean> {
    if (!this.searchLoaded) {
      const p: Promise<boolean> = this.fetchSearch().then((ok) => {
        // after a failure the next use tries again
        if (!ok && this.searchLoaded === p) this.searchLoaded = null;
        return ok;
      });
      this.searchLoaded = p;
    }
    return this.searchLoaded;
  }

  private async fetchSearch(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}search.json`);
      if (!res.ok) throw new HttpError(res.status, res.url);
      this.searchIndex.load((await res.json()) as SearchTuple[]);
      this.search.indexLoaded();
      return true;
    } catch (err) {
      console.warn('search index unavailable', err);
      this.search.indexFailed();
      return false;
    }
  }

  // ------------------------------------------------------------------ settings

  private settingsChanged(s: Settings, changed: (keyof Settings)[]): void {
    const has = (...k: (keyof Settings)[]) => k.some((x) => changed.includes(x));
    // switch the language before anything re-renders
    if (has('lang')) setLang(s.lang);
    this.panel.settingsChanged(changed);
    if (has('lang')) {
      this.search.updateTexts();
      this.info.rerender(this.nav.target);
      this.routeBox.updateTexts();
      this.refreshChrome();
    }
    if (has('colorBy', 'sizeBy', 'missingStyle')) this.stylePlan = buildPlan(s, this.attrs);
    if (has('showBrownDwarfs', 'showWhiteDwarfs', 'maxDistErr', 'saturation', 'colorBy', 'sizeBy', 'missingStyle')) {
      this.styleDirty = true;
    }
    if (has('colorBy', 'sizeBy', 'missingStyle', 'legend', 'lang', 'jumps', 'jumpRange', 'jumpColor')) this.updateLegend();
    if (has('radius', 'quality', 'jumps', 'jumpRange')) this.lodDirty = true;
    if (has('radius')) {
      // radius follows zoom: a radius set by the user (slider, reset, link) moves the camera instead
      if (s.autoRadius && !this.followingZoom) this.nav.setDistance(distanceForRadius(s.radius));
      // like a view change: a slow network computation waits until the radius rests
      this.lastViewChange = this.lastRadiusChange = performance.now();
    }
    // a new range or set of shown stars may fit the network's limits again, and so may a clearly
    // smaller radius (not every step of a zoom: each try loads the region and computes in vain)
    const blocked = this.jumpBlocked;
    if (blocked && (has('jumps', 'jumpRange', ...VISIBILITY_KEYS) || (has('radius') && s.radius < 0.9 * blocked.radius))) {
      this.jumpBlocked = null;
      this.lodDirty = true;
    }
    if (has(...JUMP_KEYS, ...VISIBILITY_KEYS)) this.jumpDirty = true;
    else if (has('radius')) this.jumpCheck = true;
    // the route: the shown stars and the network settings (data layers hide stars only with 'hide')
    if (has(...VISIBILITY_KEYS)) this.planner.styleChanged();
    if (has(...ROUTE_KEYS) || (s.missingStyle === 'hide' && has('colorBy', 'sizeBy'))) this.planner.invalidate(ROUTE_DELAY_MS);
    if (has('jumpColor')) this.jumpLines.setMode(s.jumpColor);
    if (has('jumps') && !s.jumps) {
      this.jumpLines.clear();
      this.info.updateJumps();
      this.updateJumpStatus();
    }
    this.candidatesDirty = true;
    this.applySettings(s);
    this.scheduleHash();
  }

  private applySettings(s: Settings): void {
    const u = this.starfield.material.uniforms;
    u.uRadius.value = s.radius;
    u.uSizeMul.value = s.starSize;
    u.uBrightness.value = s.brightness;
    this.grid.visible = s.grid;
    this.dropLines.lines.visible = s.dropLines && s.labels;
    this.jumpLines.visible = s.jumps && !this.routeOnly;
  }

  private refreshChrome(): void {
    const title = this.container.querySelector('.app-title');
    if (title) title.textContent = t('appTitle');
    this.menuBtn.setAttribute('aria-label', t('settings'));
    this.helpBtn.setAttribute('aria-label', t('help'));
    this.loadingEl.textContent = t(this.loadingKey);
    document.title = t('appTitle');
    this.updateStatus();
    this.updateJumpStatus();
  }

  private updateLegend(): void {
    const s = this.store.get();
    const tooMany = s.jumps && !this.routeOnly && !!this.jumpLines.network?.overflow;
    this.legend.update(s, this.attrs, tooMany, { shown: this.routeLine.shown, only: this.routeOnly });
  }

  // ------------------------------------------------------------------ data

  private nodeLoaded(node: OctreeNode, data: NodeData): void {
    const r = this.starfield.add(node, data);
    r.points.visible = this.selectedPaths.has(node.path);
    this.candidatesDirty = true;
    if (r.points.visible) this.jumpDirty = true;
    if (node.path === 'r') {
      this.loadingKey = 'loading';
      this.loadingEl.classList.remove('error');
      this.loadingEl.classList.add('hidden');
    }
    if (this.pendingSelect && this.pendingSelect.path === node.path) {
      this.select(this.starInfo(data, this.pendingSelect.index));
    }
    this.planner.nodeArrived();
  }

  /** A node could not be loaded even after retries. */
  private nodeFailed(node: OctreeNode): void {
    this.candidatesDirty = true; // status line
    if (node.path === 'r') this.showLoadError('loadError');
    if (this.pendingSelect?.path === node.path) this.pendingSelect = null;
    this.planner.nodeArrived();
  }

  private updateLod(): void {
    if (!this.octree || !this.loader) return;
    const s = this.store.get();
    const budget = QUALITY_BUDGET[s.quality];
    const h = this.renderer.domElement.clientHeight || window.innerHeight;
    const pxPerUnit = h / (2 * Math.tan(MathUtils.degToRad(this.camera.fov) / 2));
    const blocked = this.jumpBlocked;
    if (blocked && blocked.centre.distanceTo(this.nav.target) > s.radius) this.jumpBlocked = null;
    // the jump network also needs the stars just outside the visible sphere (faded out by the
    // shader), but only when all of them fit the budget: it never takes stars from the sphere
    const margin = s.jumps && !this.routeOnly && !this.jumpBlocked ? jumpMargin(s.jumpRange) : 0;
    const { nodes: selected, wide } = selectWithMargin(
      this.octree,
      { cameraPos: this.camera.position, target: this.nav.target, radius: s.radius, budget, pixelsPerUnitAtUnitDistance: pxPerUnit },
      margin,
    );
    const before = this.selectedPaths;
    this.selectedPaths = new Set(selected.map((n) => n.path));
    const added = [...this.selectedPaths].some((p) => !before.has(p));
    if (added || [...before].some((p) => !this.selectedPaths.has(p))) {
      // new nodes change the network; nodes dropped by a zoom in only when it no longer serves
      if (added) this.jumpDirty = true;
      else this.jumpCheck = true;
      // labels and the status line (also when no node has to be loaded for the change)
      this.candidatesDirty = true;
    }
    if (wide !== this.jumpRegion) this.jumpDirty = true;
    this.jumpRegion = wide;
    // keep loading the node of a star picked in the search even if the LOD does not choose it,
    // and the nodes of a route's corridor (after the view's)
    const extra: OctreeNode[] = [];
    const pending = this.pendingSelect ? this.octree.nodes.get(this.pendingSelect.path) : undefined;
    if (pending && !this.selectedPaths.has(pending.path)) extra.push(pending);
    for (const n of this.routeNodes) if (!this.selectedPaths.has(n.path) && n !== pending) extra.push(n);
    this.loader.request(extra.length ? [...selected, ...extra] : selected, budget * 2);
    this.starfield.setVisible(this.selectedPaths);
  }

  // ------------------------------------------------------------------ labels & stats

  private rebuildCandidates(): void {
    const s = this.store.get();
    const target = this.nav.target;
    const camPos = this.camera.position;
    const r2 = s.radius * s.radius;
    const cands: LabelCandidate[] = [];
    let inView = 0;
    // the best named stars and unnamed stars by label priority, among those on screen (a large
    // view holds tens of thousands of named stars; candidates are rebuilt after each view change)
    const named = new TopK<{ d: NodeData; i: number; size: number }>(namedCandidateLimit(s.labelCount));
    const unnamed = new TopK<{ d: NodeData; i: number; size: number }>(s.labelDesignations ? Math.min(s.labelCount, 200) : 0);
    const vp = this.viewProj.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements;

    const tx = target.x;
    const ty = target.y;
    const tz = target.z;
    const cx = camPos.x;
    const cy = camPos.y;
    const cz = camPos.z;
    for (const rn of this.starfield.visibleNodes()) {
      const d = rn.data;
      const p = d.positions;
      // quick reject: node entirely outside the sphere
      if (rn.node.box.distanceToPoint(target) > s.radius) continue;
      for (let i = 0; i < d.count; i++) {
        const x = p[3 * i];
        const y = p[3 * i + 1];
        const z = p[3 * i + 2];
        const dx = x - tx;
        const dy = y - ty;
        const dz = z - tz;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        if (rn.sizes[i] <= 0) continue;
        inView++;
        const name = d.names.get(i);
        const sun = (d.flags[i] & Flag.SUN) !== 0;
        if (!name && !sun && unnamed.k === 0) continue;
        if (!sun && !onScreen(vp, x, y, z)) continue;
        const ex = x - cx;
        const ey = y - cy;
        const ez = z - cz;
        const dist = Math.sqrt(ex * ex + ey * ey + ez * ez);
        const top = name || sun ? named : unnamed;
        const score = name || sun ? starPriority(starLogL(d, i), dist, sun ? 0 : name!.rank, apparentMag(d, i), sun) : starPriority(starLogL(d, i), dist, 99, undefined);
        if (score > top.threshold) top.push(score, { d, i, size: rn.sizes[i] });
      }
    }
    for (const { d, i, size } of named.items()) {
      const name = d.names.get(i);
      const sun = (d.flags[i] & Flag.SUN) !== 0;
      const sys = d.systems.get(i);
      const sysInfo = sys !== undefined ? d.systemInfo.get(sys) : undefined;
      const p = d.positions;
      cands.push({
        key: `${d.path}:${i}`,
        pos: new Vector3(p[3 * i], p[3 * i + 1], p[3 * i + 2]),
        text: sun ? t('theSun') : localName(name!.en, name!.de),
        rank: sun ? 0 : name!.rank,
        logL: starLogL(d, i),
        sun,
        sys,
        sysName: sysInfo?.nameEn ? localName(sysInfo.nameEn, sysInfo.nameDe) : undefined,
        appMag: apparentMag(d, i),
        size,
      });
    }
    for (const { d, i, size } of unnamed.items()) {
      const p = d.positions;
      cands.push({
        key: `${d.path}:${i}`,
        pos: new Vector3(p[3 * i], p[3 * i + 1], p[3 * i + 2]),
        text: designationOf(d, i),
        rank: 99,
        logL: starLogL(d, i),
        size,
      });
    }
    this.routeCandidates(cands);
    // Keep the selected star labelled even if it is outside the candidate set.
    if (this.selected && !cands.some((c) => c.key === this.selected!.key)) {
      cands.push({
        key: this.selected.key,
        pos: this.selected.pos,
        text: displayName(this.selected),
        rank: 0,
        logL: 0,
        sys: this.selected.system?.id,
      });
    }
    this.labels.candidates = cands;
    this.inView = inView;
    // only the view-dependent values: rebuilding the card here would swallow clicks on its buttons
    if (this.selected) this.info.updateView(this.nav.target);
  }

  /**
   * Route labels: every waypoint is a candidate, also outside the visible sphere (the route is
   * drawn there too), ahead of all other stars (see labelScore); start and destination are always
   * labelled.
   */
  private routeCandidates(cands: LabelCandidate[]): void {
    const ends = [this.planner.from, this.planner.to].filter((e): e is RouteEnd => !!e);
    if (!this.route && !ends.length) return;
    const byKey = new Map(cands.map((c) => [c.key, c]));
    for (const w of this.route?.waypoints ?? []) {
      const key = `${w.data.path}:${w.index}`;
      const c = byKey.get(key) ?? this.candidateOf(w.data, w.index);
      c.route = true;
      if (!byKey.has(key)) {
        byKey.set(key, c);
        cands.push(c);
      }
    }
    for (const e of ends) {
      const key = `${e.path}:${e.index}`;
      const c = byKey.get(key);
      if (c) {
        c.pinned = true;
        continue;
      }
      const pinned: LabelCandidate = { key, pos: new Vector3(e.pos.x, e.pos.y, e.pos.z), text: this.routeNames.end(e), rank: 0, logL: 0, pinned: true };
      byKey.set(key, pinned);
      cands.push(pinned);
    }
  }

  /** Label candidate of star i of a node. */
  private candidateOf(d: NodeData, i: number): LabelCandidate {
    const name = d.names.get(i);
    const sun = (d.flags[i] & Flag.SUN) !== 0;
    const sys = d.systems.get(i);
    const sysInfo = sys !== undefined ? d.systemInfo.get(sys) : undefined;
    const p = d.positions;
    return {
      key: `${d.path}:${i}`,
      pos: new Vector3(p[3 * i], p[3 * i + 1], p[3 * i + 2]),
      text: this.starName(d, i),
      rank: sun ? 0 : (name?.rank ?? 99),
      logL: starLogL(d, i),
      sun,
      sys,
      sysName: sysInfo?.nameEn ? localName(sysInfo.nameEn, sysInfo.nameDe) : undefined,
      appMag: apparentMag(d, i),
      size: this.starfield.get(d.path)?.sizes[i],
    };
  }

  private updateStatus(): void {
    if (!this.loader) return;
    const loaded = this.starfield.visiblePointCount();
    let text = t('stats', {
      loaded: formatNumber(loaded),
      visible: formatNumber(this.inView),
    });
    const pending = this.loader.pendingCount;
    if (pending > 0) text += ` · ${pending === 1 ? t('statsLoadingOne') : t('statsLoading', { pending: formatNumber(pending) })}`;
    this.status.textContent = text;
  }

  // ------------------------------------------------------------------ picking & selection

  private setupPointer(): void {
    const dom = this.renderer.domElement;
    // a tap is a single pointer that went down and up without moving; pinches never count.
    // Times are those of the input events (e.timeStamp), not of their handling: the page can be
    // busy for a moment after a tap (card, labels), which must not break a double-tap.
    const taps = new TapDetector(6, 600);
    // a double-tap: the second press starts within DOUBLE_TAP_MS of the first tap's release, near it
    let secondTap = false;
    dom.addEventListener('pointerdown', (e) => {
      taps.down(e.pointerId, e.clientX, e.clientY, e.timeStamp, e.isPrimary);
      if (e.isPrimary) {
        secondTap =
          e.timeStamp - this.lastTap.time < DOUBLE_TAP_MS &&
          Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 30;
      }
    });
    dom.addEventListener('pointercancel', (e) => taps.cancel(e.pointerId));
    dom.addEventListener('pointerup', (e) => {
      if (!taps.up(e.pointerId, e.clientX, e.clientY, e.timeStamp)) return;
      // (while the settings panel is open, its scrim catches every press beside it)
      const hit = this.pickAt(e.clientX, e.clientY, e.pointerType === 'touch' ? 22 : 14);
      const isDouble = secondTap;
      secondTap = false;
      // after a double-tap the next tap starts a new pair
      this.lastTap = isDouble ? { time: 0, x: 0, y: 0 } : { time: e.timeStamp, x: e.clientX, y: e.clientY };
      if (hit) {
        this.select(hit);
        if (isDouble) this.nav.flyTo(hit.pos);
      } else if (!isDouble) {
        this.select(null);
      }
    });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /**
   * The card (and on phones the route box above it) opens right over the tapped star: the second
   * tap of a double-tap then lands on it. Such a press (by its input time, close to the first tap)
   * is caught there and flies to the selected star, like a double-tap on the map.
   */
  private catchSecondTap(el: HTMLElement): void {
    let caught: number | null = null;
    let swallowClick = false;
    const isSecondTap = (e: PointerEvent) =>
      e.isPrimary &&
      !!this.selected &&
      e.timeStamp - this.lastTap.time < DOUBLE_TAP_MS &&
      Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 30;
    el.addEventListener(
      'pointerdown',
      (e) => {
        if (!isSecondTap(e)) return;
        caught = e.pointerId;
        e.preventDefault();
        e.stopPropagation();
      },
      { capture: true },
    );
    el.addEventListener(
      'pointerup',
      (e) => {
        if (caught !== e.pointerId) return;
        caught = null;
        swallowClick = true;
        e.preventDefault();
        e.stopPropagation();
        this.lastTap = { time: 0, x: 0, y: 0 };
        if (this.selected) this.nav.flyTo(this.selected.pos);
      },
      { capture: true },
    );
    el.addEventListener('pointercancel', () => (caught = null), { capture: true });
    el.addEventListener(
      'click',
      (e) => {
        if (!swallowClick) return;
        swallowClick = false;
        e.preventDefault();
        e.stopPropagation();
      },
      { capture: true },
    );
  }

  private pickAt(clientX: number, clientY: number, radiusPx: number): StarInfo | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const vp = new Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const m = vp.elements;
    const s = this.store.get();
    const target = this.nav.target;
    const r2 = s.radius * s.radius;
    // sprite sizes as the shader draws them (large star sizes make discs much wider than the pick radius)
    const u = this.starfield.material.uniforms;
    const pr = this.renderer.getPixelRatio();
    const scale = u.uScale.value as number;
    const minPx = u.uMinPx.value as number;
    const maxPx = u.uMaxPx.value as number;
    let best: { d: number; data: NodeData; i: number } | null = null;
    for (const rn of this.starfield.visibleNodes()) {
      const d = rn.data;
      const p = d.positions;
      if (rn.node.box.distanceToPoint(target) > s.radius) continue;
      for (let i = 0; i < d.count; i++) {
        if (rn.sizes[i] <= 0) continue;
        const x = p[3 * i];
        const y = p[3 * i + 1];
        const z = p[3 * i + 2];
        const ddx = x - target.x;
        const ddy = y - target.y;
        const ddz = z - target.z;
        if (ddx * ddx + ddy * ddy + ddz * ddz > r2) continue;
        const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (cw <= 0) continue;
        const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw + 1) * 0.5 * w;
        const sy = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw) * 0.5 * h;
        const dist = Math.hypot(sx - mx, sy - my);
        if (dist > radiusPx && dist > (SPRITE_CORE * maxPx) / (2 * pr)) continue;
        // clip w is the view depth
        const core = (SPRITE_CORE * spritePx(rn.sizes[i], s.starSize, scale, cw, minPx, maxPx)) / (2 * pr);
        const score = pickScore({ dist, core, named: d.names.has(i), logL: starLogL(d, i) }, radiusPx);
        if (score !== null && (!best || score < best.d)) best = { d: score, data: d, i };
      }
    }
    return best ? this.starInfo(best.data, best.i) : null;
  }

  private starInfo(d: NodeData, i: number): StarInfo {
    const name = d.names.get(i);
    const sysId = d.systems.get(i);
    const sys = sysId !== undefined ? d.systemInfo.get(sysId) : undefined;
    return {
      key: `${d.path}:${i}`,
      nameEn: name?.en ?? null,
      nameDe: name?.de ?? null,
      designation: designationOf(d, i),
      alt: name?.alt ?? [],
      pos: new Vector3(d.positions[3 * i], d.positions[3 * i + 1], d.positions[3 * i + 2]),
      absMag: d.absMag[i],
      logL: d.logL[i],
      teff: d.teff[i],
      flags: d.flags[i],
      distErr: d.distErr[i],
      spec: d.spec[i],
      specType: d.spectralTypes.get(i) ?? null,
      planets: planetsOf(d, i),
      systemPrimary: sys?.primary ?? null,
      system:
        sysId !== undefined && sys
          ? { id: sysId, nameEn: sys.nameEn ?? designationOf(d, i), nameDe: sys.nameDe, members: sys.members }
          : null,
    };
  }

  /** Any selection change (by the user or a completed search pick) ends a pending search pick. */
  private select(info: StarInfo | null): void {
    this.pendingSelect = null;
    this.selected = info;
    this.labels.selectedKey = info?.key ?? null;
    this.selMarker.show(info?.pos ?? null, this.renderer.getPixelRatio());
    this.info.show(info, this.nav.target);
    this.highlightJumps();
    this.candidatesDirty = true;
  }

  // ------------------------------------------------------------------ jump network

  /** How many links a place wants: by luminosity or by the position on an attribute's scale. */
  private capacityRule(s: Settings): CapacityRule {
    const info = s.jumpBy ? attributeInfo(s.jumpBy, this.attrs) : null;
    const get = info?.type === 'number' ? valueGetter(s.jumpBy, this.attrs) : null;
    if (get) return attributeCapacity(get, numericScale(s.jumpBy, this.attrs), s.jumpFaint, s.jumpBright);
    return { by: 'luminosity', faint: s.jumpFaint, sun: s.jumpSun, bright: s.jumpBright };
  }

  /** Computes the network from the shown stars around the view centre. */
  private recomputeJumps(): void {
    this.jumpDirty = false;
    const s = this.store.get();
    const t0 = performance.now();
    const centre = this.nav.target;
    const region = s.radius + jumpMargin(s.jumpRange);
    const wasOverflow = !!this.jumpLines.network?.overflow;
    const opt: NetworkOptions = {
      centre: { x: centre.x, y: centre.y, z: centre.z },
      radius: region,
      capacity: this.capacityRule(s),
      nodeKey: (path) => this.nodeOrdinal.get(path) ?? 0,
      maxPlaces: MAX_PLACES,
      range: s.jumpRange,
      hub: s.jumpHub,
      kSun: s.jumpSun,
      connect: s.jumpConnect,
      maxCandidates: MAX_PAIRS,
    };
    let net: JumpNetwork;
    if (this.jumpRegion) {
      const sources = this.starfield.visibleNodes().filter((rn) => rn.node.box.distanceToPoint(centre) <= region);
      net = computeNetwork(sources, opt);
      if (net.overflow === 'places' || net.overflow === 'pairs') {
        // the region's extra stars are of no use: the level of detail goes back to the sphere
        this.jumpBlocked = { kind: net.overflow, centre: centre.clone(), radius: s.radius };
        this.lodDirty = true;
      }
    } else {
      // without all stars of the region the links would depend on the camera: not computed
      net = { ...computeNetwork([], opt), overflow: this.jumpBlocked?.kind ?? 'detail' };
    }
    // all links of the region: the shader fades them out at the edge of the visible sphere, so
    // the view can move by up to two jump ranges before links go missing
    this.jumpLines.set(net, s.jumpColor);
    this.highlightJumps();
    this.lastJump = performance.now();
    this.jumpCost = this.lastJump - t0;
    if (import.meta.env.DEV) {
      const { places, links, overflow } = net;
      console.debug(`jumps: ${places.count} places, ${links.candidates} pairs, ${links.count} links, ${overflow ?? 'ok'}, ${this.jumpCost.toFixed(1)} ms`);
    }
    if (wasOverflow !== !!net.overflow) this.updateLegend();
    this.updateJumpStatus();
    this.info.updateJumps();
  }

  private highlightJumps(): void {
    const net = this.jumpLines.network;
    if (!net || !this.selected) return this.jumpLines.highlight(-1);
    const { path, i } = parseStarKey(this.selected.key);
    this.jumpLines.highlight(placeOfStar(net.places, path, i));
  }

  private updateJumpStatus(): void {
    const s = this.store.get();
    const net = this.jumpLines.network;
    if (s.jumps && this.routeOnly) return this.panel.setJumpStatus(t('jumpRouteOnly', { r: formatLy(3 * s.jumpRange) }));
    if (!s.jumps || !net) return this.panel.setJumpStatus('');
    if (net.overflow === 'places') return this.panel.setJumpStatus(t('jumpTooMany', { n: formatNumber(MAX_PLACES) }), true);
    if (net.overflow === 'pairs') return this.panel.setJumpStatus(t('jumpTooManyPairs'), true);
    if (net.overflow === 'detail') return this.panel.setJumpStatus(t('jumpIncomplete'), true);
    // counted inside the visible sphere
    const { places, links } = net;
    const p = places.positions;
    const { x: cx, y: cy, z: cz } = net.centre;
    const r2 = s.radius * s.radius;
    const inside = new Uint8Array(places.count);
    let nPlaces = 0;
    for (let k = 0; k < places.count; k++) {
      const dx = p[3 * k] - cx;
      const dy = p[3 * k + 1] - cy;
      const dz = p[3 * k + 2] - cz;
      if (dx * dx + dy * dy + dz * dz <= r2) {
        inside[k] = 1;
        nPlaces++;
      }
    }
    let nLinks = 0;
    for (let k = 0; k < links.count; k++) if (inside[links.a[k]] || inside[links.b[k]]) nLinks++;
    this.panel.setJumpStatus(jumpStatsText(nLinks, nPlaces));
  }

  /** Display name of star i of a node. */
  private starName(d: NodeData, i: number): string {
    if (d.flags[i] & Flag.SUN) return t('theSun');
    const name = d.names.get(i);
    return name ? localName(name.en, name.de) : designationOf(d, i);
  }

  /** The info card's list of the links of a star's place. */
  private jumpListing(info: StarInfo): JumpListing | null {
    const net = this.jumpLines.network;
    if (!this.store.get().jumps || this.routeOnly || !net || net.overflow) return null;
    const { path, i } = parseStarKey(info.key);
    const found = linksOfStar(net, path, i);
    if (!found) return null;
    const { places } = net;
    const rep = places.sources[places.repSource[found.place]].data;
    const repIndex = places.repIndex[found.place];
    let via: string | null = null;
    if (rep.path !== path || repIndex !== i) {
      // the system's name, or the star a close neighbour without a system id was merged with
      const sameSystem = !!info.system && rep.systems.get(repIndex) === info.system.id;
      via = sameSystem ? localName(info.system!.nameEn, info.system!.nameDe) : this.starName(rep, repIndex);
    }
    return {
      via,
      range: net.range,
      links: found.links.map((l) => {
        const d = places.sources[places.repSource[l.partner]].data;
        const k = places.repIndex[l.partner];
        return { name: this.starName(d, k), distance: l.length, kind: l.kind, pick: () => this.pickJump(d, k) };
      }),
    };
  }

  /** A star picked in the info card's jump list: select it and centre the view on it. */
  private pickJump(d: NodeData, i: number): void {
    const info = this.starInfo(d, i);
    this.select(info);
    this.nav.flyTo(info.pos);
  }

  private pickSearch(hit: SearchHit): void {
    const s = this.store.get();
    // a fixed radius: close enough to see the sphere; radius follows zoom: the zoom stays
    const dist = MathUtils.clamp(this.nav.distance, 3, s.autoRadius ? Infinity : Math.max(s.radius * 1.8, 10));
    this.nav.flyTo(hit.pos, dist);
    const data = this.loader?.get(hit.path);
    if (data) {
      this.select(this.starInfo(data, hit.index));
    } else if (this.loader && !this.loader.hasFailed(hit.path)) {
      this.pendingSelect = hit;
      const node = this.octree?.nodes.get(hit.path);
      // make sure the node gets loaded even if the LOD would not choose it yet
      if (node && this.loader) this.loader.request([...this.lodSelectedNodes(), node], QUALITY_BUDGET[s.quality] * 2);
    }
  }

  private lodSelectedNodes(): OctreeNode[] {
    const out: OctreeNode[] = [];
    for (const p of this.selectedPaths) {
      const n = this.octree?.nodes.get(p);
      if (n) out.push(n);
    }
    return out;
  }

  // ------------------------------------------------------------------ route

  /** A star of the info card as a route end. */
  private routeEnd(info: StarInfo): RouteEnd {
    const { path, i } = parseStarKey(info.key);
    return {
      designation: info.designation,
      nameEn: info.nameEn,
      nameDe: info.nameDe,
      sun: (info.flags & Flag.SUN) !== 0,
      path,
      index: i,
      pos: { x: info.pos.x, y: info.pos.y, z: info.pos.z },
    };
  }

  /** Names in the route box: the chosen stars; waypoints by their system's name when it has one. */
  private readonly routeNames: RouteNames = {
    end: (e) => (e.sun ? t('theSun') : e.nameEn ? localName(e.nameEn, e.nameDe) : e.designation),
    waypoint: (w: Waypoint) => {
      const sys = w.data.systems.get(w.index);
      const info = sys !== undefined ? w.data.systemInfo.get(sys) : undefined;
      return info?.nameEn ? localName(info.nameEn, info.nameDe) : this.starName(w.data, w.index);
    },
  };

  /**
   * Phones: while the info card is open, the route box (and legend) would sit under it, so the
   * bottom-left stack moves to the top of the screen (CSS: .card-open, --card-h).
   */
  private placeAboveCard(): void {
    const phone = window.matchMedia?.('(max-width: 700px)');
    const card = this.info.root;
    const place = () => {
      const open = !!phone?.matches && !card.classList.contains('hidden');
      this.container.classList.toggle('card-open', open);
      if (open) this.container.style.setProperty('--card-h', `${card.offsetHeight}px`);
    };
    // the card's size changes with its content and when it is shown or hidden
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(place).observe(card);
    phone?.addEventListener?.('change', place);
    place();
  }

  /** The planner's ends, status or route changed. */
  private routeChanged(): void {
    const p = this.planner;
    if (p.route !== this.route) {
      this.route = p.route;
      // a partial route: the destination it did not reach gets its own marker
      this.routeLine.set(this.route ? this.route.waypoints.map((w) => w.pos) : null, this.route?.found ?? true, p.to?.pos ?? null);
      this.updateLegend();
    }
    // start and destination labels
    this.candidatesDirty = true;
    this.routeBox.update({ from: p.from, to: p.to, mode: p.mode, status: p.status, route: p.route }, this.routeNames);
  }

  /**
   * Centres the view on the route and zooms out until it fits (the camera only): into the part of
   * the screen below the top bar and, on phones, above the route box.
   */
  private showWholeRoute(): void {
    // the route, and the chosen stars (a partial route does not reach the destination)
    const pts = [...(this.route?.waypoints.map((w) => w.pos) ?? []), ...[this.planner.from, this.planner.to].filter((e) => !!e).map((e) => e!.pos)];
    const ext = routeBounds(pts);
    if (!ext) return;
    const view = this.renderer.domElement.getBoundingClientRect();
    const h = view.height || 1;
    let top = 0;
    let bottom = h;
    const bar = this.container.querySelector('.topbar')?.getBoundingClientRect();
    if (bar) top = MathUtils.clamp(bar.bottom - view.top, 0, h / 3);
    const stack = this.container.querySelector('.bottom-left')?.getBoundingClientRect();
    if (stack && stack.height > 0 && stack.width > view.width / 2) bottom = MathUtils.clamp(stack.top - view.top, h / 2, h);
    const free = bottom - top;
    const half = MathUtils.degToRad(this.camera.fov / 2);
    const freeHalf = Math.atan((Math.tan(half) * free) / h);
    const d = MathUtils.clamp(fitDistance(ext.radius, MathUtils.radToDeg(2 * freeHalf), view.width / free), 3, 150_000);
    // the route's centre in the middle of the free part: the view centre moves along the screen's up direction
    const up = new Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const shift = ((h / 2 - (top + bottom) / 2) / (h / 2)) * d * Math.tan(half);
    this.nav.flyTo(ext.centre.clone().addScaledVector(up, -shift), d);
  }

  /** A waypoint picked in the route box: select it and centre the view on it. */
  private pickWaypoint(k: number): void {
    const w = this.route?.waypoints[k];
    if (!w) return;
    const info = this.starInfo(w.data, w.index);
    this.select(info);
    const s = this.store.get();
    // radius following the zoom: close enough to see the jump network around it
    const dist = s.autoRadius
      ? Math.min(this.nav.distance, distanceForRadius(Math.min(20, 3 * s.jumpRange)))
      : MathUtils.clamp(this.nav.distance, 3, Math.max(s.radius * 1.8, 10));
    this.nav.flyTo(info.pos, dist);
  }

  /** Switches between the jump network and the route alone (zoomed out). */
  private setRouteOnly(only: boolean): void {
    this.routeOnly = only;
    const s = this.store.get();
    this.jumpLines.visible = s.jumps && !only;
    // the network region is loaded (or no longer) and the network computed for the current view
    this.lodDirty = true;
    if (!only) this.jumpDirty = true;
    this.updateLegend();
    this.updateJumpStatus();
    this.info.updateJumps();
  }

  private goToSun(): void {
    const s = this.store.get();
    // the default framing of the sphere (which the radius keeps by itself while it follows the zoom)
    const d = s.autoRadius ? this.nav.distance : distanceForRadius(s.radius);
    this.nav.flyTo(new Vector3(0, 0, 0), MathUtils.clamp(d, 5, 150_000));
  }

  /** Radius follows zoom: the radius tracks the camera distance in steps of about 1 %. */
  private radiusFollowsZoom(): void {
    const s = this.store.get();
    if (!s.autoRadius) return;
    const r = followZoom(s.radius, this.nav.distance);
    if (r === null) return;
    this.followingZoom = true;
    try {
      this.store.set({ radius: r });
    } finally {
      this.followingZoom = false;
    }
  }

  private shortcut(key: string, e: KeyboardEvent): void {
    switch (key) {
      case 'h':
      case 'H':
      case 'Home':
        this.goToSun();
        break;
      case 'l':
      case 'L':
        this.store.set({ labels: !this.store.get().labels });
        break;
      case 'g':
      case 'G':
        this.store.set({ grid: !this.store.get().grid });
        break;
      case 'j':
      case 'J':
        this.store.set({ jumps: !this.store.get().jumps });
        break;
      case '/':
        e.preventDefault();
        this.search.focus();
        break;
      case 'Escape':
        if (this.dialog.open) this.dialog.close();
        else if (this.panel.isOpen) this.panel.toggle(false);
        else this.select(null);
        break;
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ dialogs

  /**
   * A click on the backdrop of a modal dialog (outside its box) closes it. Only a press that also
   * started outside counts, so a text selection or a drag from inside the box never closes it.
   */
  private closeOnBackdrop(dialog: HTMLDialogElement): void {
    const outside = (e: MouseEvent) => {
      if (e.target !== dialog) return false;
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = outside(e);
    });
    dialog.addEventListener('click', (e) => {
      if (pressedOutside && outside(e)) dialog.close();
      pressedOutside = false;
    });
  }

  private openDialog(title: string, body: HTMLElement): void {
    this.dialog.replaceChildren();
    const head = el('div', 'dialog-head');
    head.appendChild(el('h2', '', title));
    const close = el('button', 'icon-btn', '×');
    close.setAttribute('aria-label', t('close'));
    close.addEventListener('click', () => this.dialog.close());
    head.appendChild(close);
    this.dialog.append(head, body);
    this.dialog.showModal();
  }

  private showHelp(): void {
    const body = el('div', 'dialog-body');
    body.innerHTML = t('helpText');
    this.openDialog(t('help'), body);
  }

  private showAbout(): void {
    const body = el('div', 'dialog-body');
    body.innerHTML = t('aboutText');
    const ul = el('ul', 'sources');
    for (const src of this.manifest?.sources ?? []) {
      const li = el('li');
      const name = el('b', '', src.title);
      li.appendChild(name);
      if (src.used !== undefined) li.appendChild(document.createTextNode(` — ${formatNumber(src.used)}`));
      if (src.citation) li.appendChild(el('div', 'cite', src.citation));
      if (src.license) li.appendChild(el('div', 'cite', src.license));
      if (src.url && /^https?:\/\//.test(src.url)) {
        const a = el('a', '', src.url);
        a.href = src.url;
        a.target = '_blank';
        a.rel = 'noopener';
        li.appendChild(a);
      }
      ul.appendChild(li);
    }
    body.appendChild(ul);
    if (this.manifest) {
      body.appendChild(
        el('p', 'cite', `${formatNumber(this.manifest.starCount)} ${t('stars')} · ${this.manifest.generated}`),
      );
    }
    this.openDialog(t('about'), body);
  }

  // ------------------------------------------------------------------ URL state

  private scheduleHash(): void {
    window.clearTimeout(this.hashTimer);
    this.hashTimer = window.setTimeout(() => {
      const [tx, ty, tz] = worldToGalactic(this.nav.target);
      const off = this.camera.position.clone().sub(this.nav.target);
      const [ox, oy, oz] = worldToGalactic(off);
      const f = (x: number) => Number(x.toFixed(3));
      const hash = `#c=${f(tx)},${f(ty)},${f(tz)}&o=${f(ox)},${f(oy)},${f(oz)}&r=${f(this.store.get().radius)}`;
      try {
        if (location.hash !== hash) history.replaceState(null, '', hash);
      } catch {
        // some embedding contexts do not allow history changes
      }
    }, 400);
  }

  private applyHash(initial = false): void {
    const params = new URLSearchParams(location.hash.slice(1));
    const parse = (k: string) => {
      const v = params.get(k)?.split(',').map(Number);
      return v && v.length === 3 && v.every(Number.isFinite) ? v : null;
    };
    const c = parse('c');
    const o = parse('o');
    const r = Number(params.get('r'));
    if (Number.isFinite(r) && r >= RADIUS_MIN && r <= RADIUS_MAX) this.store.set({ radius: r });
    if (c && o) {
      this.nav.setView(galacticToWorld(c[0], c[1], c[2]), galacticToWorld(o[0], o[1], o[2]));
    } else if (initial) {
      const R = this.store.get().radius;
      const d = MathUtils.clamp(distanceForRadius(R), 5, 150_000);
      const el2 = MathUtils.degToRad(28);
      // camera behind the Sun, looking towards the Galactic Centre (+X), slightly from above
      this.nav.setView(new Vector3(0, 0, 0), new Vector3(-Math.cos(el2) * d, Math.sin(el2) * d, d * 0.12));
    }
  }

  // ------------------------------------------------------------------ frame loop

  private resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.labels.resize(w, h, Math.min(window.devicePixelRatio, 2));
    this.routeLine.setResolution(w, h);
    this.lodDirty = true;
    this.candidatesDirty = true;
  }

  private loop = (): void => {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    this.nav.update(dt);
    this.radiusFollowsZoom();

    const s = this.store.get();
    const dist = this.nav.distance;
    this.camera.near = Math.max(dist * 1e-4, 1e-4);
    this.camera.far = dist + s.radius * 4 + 1000;
    // the route is drawn whole, however far it reaches
    const ext = this.routeLine.extent;
    if (ext) this.camera.far = Math.max(this.camera.far, this.camera.position.distanceTo(ext.centre) + ext.radius + 100);
    this.camera.updateProjectionMatrix();
    // labels and picking need this frame's camera matrix
    this.camera.updateMatrixWorld();

    const u = this.starfield.material.uniforms;
    this.starfield.setTarget(this.nav.target);
    const h = this.renderer.domElement.clientHeight || window.innerHeight;
    u.uScale.value = (h * this.renderer.getPixelRatio()) / (2 * Math.tan(MathUtils.degToRad(this.camera.fov) / 2));
    u.uPixelRatio.value = this.renderer.getPixelRatio();
    // the more stars are in view, the fainter the faintest ones, so dense regions do not saturate
    u.uMinAlpha.value = MathUtils.clamp(0.55 * Math.sqrt(2500 / Math.max(this.inView, 1)), 0.035, 0.55);
    u.uMinPx.value = 2.6 * this.renderer.getPixelRatio();
    // larger star sizes raise the cap too (gently), so that the brightest stars keep growing
    u.uMaxPx.value = 64 * this.renderer.getPixelRatio() * MathUtils.clamp(Math.sqrt(s.starSize), 1, 3);

    if (this.styleDirty && now - this.lastStyle > 150) {
      this.styleDirty = false;
      this.lastStyle = now;
      this.starfield.restyle();
      this.jumpLines.recolor();
      this.candidatesDirty = true;
    }
    if (this.lodDirty && now - this.lastLod > 120) {
      this.lodDirty = false;
      this.lastLod = now;
      this.updateLod();
    }
    const routeOnly = this.routeLine.shown && s.radius > 3 * s.jumpRange;
    if (routeOnly !== this.routeOnly) this.setRouteOnly(routeOnly);
    if (s.jumps && !this.routeOnly && this.octree) {
      const net = this.jumpLines.network;
      const c = this.nav.target;
      // a zoom in keeps a network whose region still holds the view's (no computation)
      if (this.jumpCheck) {
        this.jumpCheck = false;
        if (!this.jumpRegion || !networkServes(net, c, s.radius)) this.jumpDirty = true;
      }
      const moved = net ? Math.hypot(c.x - net.centre.x, c.y - net.centre.y, c.z - net.centre.z) : 0;
      if (moved > 0.05 * s.radius) this.jumpDirty = true;
      // a slow computation waits until the view rests, so that moving stays smooth, or until the
      // drawn links (the region minus one range) no longer cover the visible sphere
      const slack = Math.min(0.3 * s.radius, jumpMargin(s.jumpRange) - s.jumpRange);
      // while the radius changes (a zoom) and the drawn links still cover the sphere, any
      // computation waits until it rests: zooming in never needs one, zooming out only beyond them
      const covered = !!net && moved + s.radius <= net.region - s.jumpRange;
      const zooming = covered && now - this.lastRadiusChange < 300;
      const ready = !zooming && (this.jumpCost < 50 || now - this.lastViewChange > 300 || moved > slack);
      // after a pending restyle (shown stars), and spaced so that it takes at most ~20 % of the time
      if (this.jumpDirty && ready && !this.styleDirty && now - this.lastJump >= Math.max(250, 4 * this.jumpCost)) this.recomputeJumps();
      // like the faint stars: the more stars in view, the fainter the lines, so dense regions stay readable
      const density = MathUtils.clamp(Math.sqrt(1500 / Math.max(this.inView, 1)), 0.2, 1);
      this.jumpLines.update(c, s.radius, s.jumpOpacity * density);
    }
    if (this.candidatesDirty && now - this.lastCandidates > 200) {
      this.candidatesDirty = false;
      this.lastCandidates = now;
      this.rebuildCandidates();
      this.updateStatus();
    }

    this.routeLine.update(u.uScale.value, this.renderer.getPixelRatio());
    this.grid.update(this.nav.target, s.radius, (ly) => formatLy(ly), s.lang, t('galacticCentre'));

    this.labels.draw({
      camera: this.camera,
      target: this.nav.target,
      radius: s.radius,
      maxLabels: s.labelCount,
      enabled: s.labels,
      grid: s.grid ? this.grid.labels : null,
      gridHighlight: 'rgba(255, 200, 120, 0.85)',
      // labels keep clear of large sprites
      sprite: { scale: (s.starSize * u.uScale.value) / u.uPixelRatio.value, max: u.uMaxPx.value / u.uPixelRatio.value },
    });
    if (s.dropLines && s.labels) this.dropLines.set(this.labels.labelledPositions, this.nav.target);
    this.dropLines.lines.visible = s.dropLines && s.labels && s.grid;

    this.renderer.render(this.scene, this.camera);
  };
}
