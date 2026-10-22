import { Color, MathUtils, Matrix4, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { Navigation } from './controls/navigation';
import { TapDetector } from './controls/tap';
import { AttributeStore } from './data/attributes';
import { Flag, designationOf, type NodeData } from './data/format';
import { decodeCsv } from './data/csv';
import { exportCsv, importCsv, type ImportReport, type StarResolver } from './data/importer';
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
  placeOfStar,
  type CapacityRule,
  type JumpNetwork,
  type NetworkOptions,
} from './network/places';
import { JumpLines } from './render/links';
import { DropLines, Marker, PolarGrid } from './render/overlays';
import { Starfield, apparentMag, starLogL } from './render/starfield';
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
import { QUALITY_BUDGET, RADIUS_MAX, RADIUS_MIN, SettingsStore, type Settings } from './settings';
import { AttributesDialog } from './ui/attributes-dialog';
import { InfoPanel, displayName, type JumpListing, type StarInfo } from './ui/info';
import { Legend } from './ui/legend';
import { LabelLayer, type LabelCandidate } from './ui/labels';
import { SettingsPanel } from './ui/panel';
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
/** Settings that change the jump network. */
const JUMP_KEYS: (keyof Settings)[] = ['jumps', 'jumpRange', 'jumpFaint', 'jumpSun', 'jumpBright', 'jumpBy', 'jumpHub', 'jumpConnect', 'radius'];

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
  /** The jump network needs to be recomputed. */
  private jumpDirty = true;
  private lastJump = -Infinity;
  /** Duration of the last network computation (ms); recomputations are spaced by a multiple of it. */
  private jumpCost = 0;
  /** Time of the last view change; a slow network computation waits until the view rests. */
  private lastViewChange = -Infinity;
  /** The level of detail holds all stars of the network region (not cut by the point budget). */
  private jumpRegion = false;
  /**
   * The last network exceeded the limits: the level of detail goes back to the visible sphere
   * until a setting changes or the view centre moves by more than the radius.
   */
  private jumpBlocked: { kind: 'places' | 'pairs'; centre: Vector3 } | null = null;
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
  private searchLoaded: Promise<void> | null = null;
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

    this.scene.add(this.grid.group, this.dropLines.lines, this.jumpLines.group, this.starfield.group, this.selMarker.points);

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

    this.panel = new SettingsPanel(container, this.store, this.attrs);
    this.panel.onManageAttributes = () => this.showAttributes();
    this.panel.onGoToSun = () => this.goToSun();
    this.panel.onHelp = () => this.showHelp();
    this.panel.onAbout = () => this.showAbout();

    this.info = new InfoPanel(container, this.attrs);
    this.info.onManageAttributes = () => this.showAttributes();
    this.info.onClose = () => this.select(null);
    this.info.onFlyTo = (info) => this.nav.flyTo(info.pos);
    this.info.jumpsOf = (info) => this.jumpListing(info);

    this.legend = new Legend(container);
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

    this.search.onPick = (hit) => this.pickSearch(hit);
    this.search.onFocus = () => void this.loadSearch();

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
    this.loop();
    if (!AttributeStore.readStored()) void this.loadSiteData();
  }

  // ------------------------------------------------------------------ user attributes

  /** Loads the site's attribute dataset for visitors without data of their own. */
  private async loadSiteData(): Promise<void> {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}user/attributes.csv`);
      if (!res.ok) return;
      const text = await res.text();
      // dev servers answer unknown paths with the app page
      if (/^\s*</.test(text)) return;
      this.siteData = text;
      await this.applySiteData();
    } catch (err) {
      console.warn('site attributes unavailable', err);
    }
  }

  private async applySiteData(): Promise<void> {
    if (!this.siteData) return;
    const resolver = await this.resolver();
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
    const resolver = await this.resolver();
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

  /** The search index is loaded on first use of the search box. */
  private loadSearch(): Promise<void> {
    if (!this.searchLoaded) {
      this.searchLoaded = (async () => {
        try {
          const res = await fetch(`${this.baseUrl}search.json`);
          if (!res.ok) return;
          this.searchIndex.load((await res.json()) as SearchTuple[]);
          if (this.search.input.value) this.search.update();
        } catch (err) {
          console.warn('search index unavailable', err);
        }
      })();
    }
    return this.searchLoaded;
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
      this.refreshChrome();
    }
    if (has('colorBy', 'sizeBy', 'missingStyle')) this.stylePlan = buildPlan(s, this.attrs);
    if (has('showBrownDwarfs', 'showWhiteDwarfs', 'maxDistErr', 'saturation', 'colorBy', 'sizeBy', 'missingStyle')) {
      this.styleDirty = true;
    }
    if (has('colorBy', 'sizeBy', 'missingStyle', 'legend', 'lang', 'jumps', 'jumpRange', 'jumpColor')) this.updateLegend();
    if (has('radius', 'quality', 'jumps', 'jumpRange')) this.lodDirty = true;
    // a new radius, range or set of shown stars may fit the network's limits again
    if (this.jumpBlocked && has('jumps', 'radius', 'jumpRange', ...VISIBILITY_KEYS)) {
      this.jumpBlocked = null;
      this.lodDirty = true;
    }
    if (has(...JUMP_KEYS, ...VISIBILITY_KEYS)) this.jumpDirty = true;
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
    this.jumpLines.visible = s.jumps;
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
    this.legend.update(s, this.attrs, s.jumps && !!this.jumpLines.network?.overflow);
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
  }

  /** A node could not be loaded even after retries. */
  private nodeFailed(node: OctreeNode): void {
    this.candidatesDirty = true; // status line
    if (node.path === 'r') this.showLoadError('loadError');
    if (this.pendingSelect?.path === node.path) this.pendingSelect = null;
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
    const margin = s.jumps && !this.jumpBlocked ? jumpMargin(s.jumpRange) : 0;
    const { nodes: selected, wide } = selectWithMargin(
      this.octree,
      { cameraPos: this.camera.position, target: this.nav.target, radius: s.radius, budget, pixelsPerUnitAtUnitDistance: pxPerUnit },
      margin,
    );
    const before = this.selectedPaths;
    this.selectedPaths = new Set(selected.map((n) => n.path));
    if (before.size !== this.selectedPaths.size || [...before].some((p) => !this.selectedPaths.has(p))) {
      this.jumpDirty = true;
      // labels and the status line (also when no node has to be loaded for the change)
      this.candidatesDirty = true;
    }
    if (wide !== this.jumpRegion) this.jumpDirty = true;
    this.jumpRegion = wide;
    // keep loading the node of a star picked in the search even if the LOD does not choose it
    const pending = this.pendingSelect ? this.octree.nodes.get(this.pendingSelect.path) : undefined;
    const request = pending && !this.selectedPaths.has(pending.path) ? [...selected, pending] : selected;
    this.loader.request(request, budget * 2);
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
    const K = s.labelDesignations ? Math.min(s.labelCount, 200) : 0;
    // min-heap of unnamed stars by apparent prominence
    const heap: { score: number; path: string; i: number; data: NodeData }[] = [];
    const heapPush = (item: (typeof heap)[number]) => {
      if (heap.length < K) {
        heap.push(item);
        let i = heap.length - 1;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (heap[p].score <= heap[i].score) break;
          [heap[p], heap[i]] = [heap[i], heap[p]];
          i = p;
        }
      } else if (K > 0 && item.score > heap[0].score) {
        heap[0] = item;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const rr = l + 1;
          let m = i;
          if (l < heap.length && heap[l].score < heap[m].score) m = l;
          if (rr < heap.length && heap[rr].score < heap[m].score) m = rr;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
    };

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
        const f = d.flags[i];
        if (name || f & Flag.SUN) {
          const sys = d.systems.get(i);
          const sysInfo = sys !== undefined ? d.systemInfo.get(sys) : undefined;
          cands.push({
            key: `${d.path}:${i}`,
            pos: new Vector3(x, y, z),
            text: f & Flag.SUN ? t('theSun') : localName(name!.en, name!.de),
            rank: f & Flag.SUN ? 0 : name!.rank,
            logL: starLogL(d, i),
            sun: (f & Flag.SUN) !== 0,
            sys,
            sysName: sysInfo?.nameEn ? localName(sysInfo.nameEn, sysInfo.nameDe) : undefined,
            appMag: apparentMag(d, i),
          });
        } else if (K > 0) {
          const ex = x - cx;
          const ey = y - cy;
          const ez = z - cz;
          const dc2 = Math.max(ex * ex + ey * ey + ez * ez, 1e-6);
          const score = starLogL(d, i) - Math.log10(dc2);
          if (heap.length < K || score > heap[0].score) heapPush({ score, path: d.path, i, data: d });
        }
      }
    }
    for (const h of heap) {
      const p = h.data.positions;
      cands.push({
        key: `${h.path}:${h.i}`,
        pos: new Vector3(p[3 * h.i], p[3 * h.i + 1], p[3 * h.i + 2]),
        text: designationOf(h.data, h.i),
        rank: 99,
        logL: starLogL(h.data, h.i),
      });
    }
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
    // a tap is a single pointer that went down and up without moving; pinches never count
    const taps = new TapDetector(6, 600);
    dom.addEventListener('pointerdown', (e) => {
      taps.down(e.pointerId, e.clientX, e.clientY, performance.now(), e.isPrimary);
    });
    dom.addEventListener('pointercancel', (e) => taps.cancel(e.pointerId));
    dom.addEventListener('pointerup', (e) => {
      if (!taps.up(e.pointerId, e.clientX, e.clientY, performance.now())) return;
      const hit = this.pickAt(e.clientX, e.clientY, e.pointerType === 'touch' ? 22 : 14);
      const now = performance.now();
      const isDouble =
        now - this.lastTap.time < 350 && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 30;
      this.lastTap = { time: now, x: e.clientX, y: e.clientY };
      if (hit) {
        this.select(hit);
        if (isDouble) this.nav.flyTo(hit.pos);
      } else if (!isDouble) {
        this.select(null);
      }
    });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
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
        if (dist > radiusPx) continue;
        // prefer named / brighter stars when several are under the cursor
        const score = dist - (d.names.has(i) ? 4 : 0) - starLogL(d, i);
        if (!best || score < best.d) best = { d: score, data: d, i };
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
        this.jumpBlocked = { kind: net.overflow, centre: centre.clone() };
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
    if (!this.store.get().jumps || !net || net.overflow) return null;
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
    const dist = MathUtils.clamp(this.nav.distance, 3, Math.max(s.radius * 1.8, 10));
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

  private goToSun(): void {
    const s = this.store.get();
    this.nav.flyTo(new Vector3(0, 0, 0), MathUtils.clamp(s.radius * 2.2, 5, 150_000));
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
      const d = MathUtils.clamp(R * 2.2, 5, 150_000);
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
    this.lodDirty = true;
    this.candidatesDirty = true;
  }

  private loop = (): void => {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    this.nav.update(dt);

    const s = this.store.get();
    const dist = this.nav.distance;
    this.camera.near = Math.max(dist * 1e-4, 1e-4);
    this.camera.far = dist + s.radius * 4 + 1000;
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
    u.uMaxPx.value = 64 * this.renderer.getPixelRatio();

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
    if (s.jumps && this.octree) {
      const net = this.jumpLines.network;
      const c = this.nav.target;
      const moved = net ? Math.hypot(c.x - net.centre.x, c.y - net.centre.y, c.z - net.centre.z) : 0;
      if (moved > 0.05 * s.radius) this.jumpDirty = true;
      // a slow computation waits until the view rests, so that moving stays smooth, or until the
      // drawn links (the region minus one range) no longer cover the visible sphere
      const slack = Math.min(0.3 * s.radius, jumpMargin(s.jumpRange) - s.jumpRange);
      const ready = this.jumpCost < 50 || now - this.lastViewChange > 300 || moved > slack;
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

    this.grid.update(this.nav.target, s.radius, (ly) => formatLy(ly), s.lang, t('galacticCentre'));

    this.labels.draw({
      camera: this.camera,
      target: this.nav.target,
      radius: s.radius,
      maxLabels: s.labelCount,
      enabled: s.labels,
      grid: s.grid ? this.grid.labels : null,
      gridHighlight: 'rgba(255, 200, 120, 0.85)',
    });
    if (s.dropLines && s.labels) this.dropLines.set(this.labels.labelledPositions, this.nav.target);
    this.dropLines.lines.visible = s.dropLines && s.labels && s.grid;

    this.renderer.render(this.scene, this.camera);
  };
}
