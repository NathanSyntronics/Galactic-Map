import { Color, MathUtils, Matrix4, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { Navigation } from './controls/navigation';
import { Flag, designationOf, type NodeData } from './data/format';
import { galacticToWorld, worldToGalactic } from './data/galactic';
import { NodeLoader, Octree, selectNodes, type Manifest, type OctreeNode } from './data/octree';
import { formatLy, localName, setLang, t } from './i18n';
import { DropLines, Marker, PolarGrid } from './render/overlays';
import { Starfield, starLogL } from './render/starfield';
import { QUALITY_BUDGET, RADIUS_MAX, RADIUS_MIN, SettingsStore, type Settings } from './settings';
import { InfoPanel, displayName, type StarInfo } from './ui/info';
import { LabelLayer, type LabelCandidate } from './ui/labels';
import { SettingsPanel } from './ui/panel';
import { SearchBox, SearchIndex, type SearchHit, type SearchTuple } from './ui/search';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class App {
  private readonly store = new SettingsStore();
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly nav: Navigation;
  private readonly starfield: Starfield;
  private readonly grid = new PolarGrid();
  private readonly dropLines = new DropLines();
  private readonly selMarker = new Marker(0xffc861, 30);
  private readonly labels: LabelLayer;
  private readonly panel: SettingsPanel;
  private readonly info: InfoPanel;
  private readonly searchIndex = new SearchIndex();
  private readonly search: SearchBox;
  private readonly status: HTMLElement;
  private readonly loadingEl: HTMLElement;
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

    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(new Color(0x02040b));
    this.renderer.domElement.className = 'gl-canvas';
    container.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(55, 1, 0.001, 1e6);
    this.nav = new Navigation(this.camera, this.renderer.domElement);
    this.starfield = new Starfield(() => this.store.get());

    this.scene.add(this.grid.group, this.dropLines.lines, this.starfield.group, this.selMarker.points);

    this.labels = new LabelLayer(container);

    // --- UI chrome
    const top = el('header', 'topbar');
    const menuBtn = el('button', 'icon-btn menu-btn', '☰');
    menuBtn.setAttribute('aria-label', t('settings'));
    menuBtn.addEventListener('click', () => this.panel.toggle());
    const title = el('div', 'app-title', t('appTitle'));
    top.append(menuBtn, title);
    container.appendChild(top);
    this.search = new SearchBox(top, this.searchIndex);
    const helpBtn = el('button', 'icon-btn help-btn', '?');
    helpBtn.setAttribute('aria-label', t('help'));
    helpBtn.addEventListener('click', () => this.showHelp());
    top.appendChild(helpBtn);

    this.panel = new SettingsPanel(container, this.store);
    this.panel.onGoToSun = () => this.goToSun();
    this.panel.onHelp = () => this.showHelp();
    this.panel.onAbout = () => this.showAbout();

    this.info = new InfoPanel(container);
    this.info.onClose = () => this.select(null);
    this.info.onFlyTo = (info) => this.nav.flyTo(info.pos);

    this.status = el('div', 'status');
    container.appendChild(this.status);
    this.loadingEl = el('div', 'loading', t('loading'));
    container.appendChild(this.loadingEl);
    this.dialog = el('dialog', 'dialog');
    container.appendChild(this.dialog);

    this.search.onPick = (hit) => this.pickSearch(hit);
    this.search.onFocus = () => void this.loadSearch();

    this.nav.onChange = () => {
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
      const res = await fetch(`${this.baseUrl}manifest.json`);
      if (!res.ok) throw new Error(res.status === 404 ? 'nodata' : `HTTP ${res.status}`);
      this.manifest = (await res.json()) as Manifest;
    } catch (err) {
      console.error(err);
      this.loadingEl.textContent = (err as Error).message === 'nodata' ? t('noData') : t('loadError');
      this.loadingEl.classList.add('error');
      this.loop();
      return;
    }
    this.octree = new Octree(this.manifest);
    this.loader = new NodeLoader(this.baseUrl, this.manifest.packs);
    this.loader.onLoaded = (node, data) => this.nodeLoaded(node, data);
    this.loader.onEvicted = (path) => this.starfield.remove(path);
    this.lodDirty = true;
    this.loop();

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
    if (has('lang')) {
      setLang(s.lang);
      this.search.updateTexts();
      this.info.refresh(this.nav.target);
      this.refreshChrome();
    }
    if (has('showBrownDwarfs', 'showWhiteDwarfs', 'maxDistErr', 'saturation')) this.starfield.restyle();
    if (has('radius', 'quality')) this.lodDirty = true;
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
  }

  private refreshChrome(): void {
    const title = this.container.querySelector('.app-title');
    if (title) title.textContent = t('appTitle');
    if (this.loadingEl.classList.contains('error')) this.loadingEl.textContent = t('noData');
    else this.loadingEl.textContent = t('loading');
    document.title = t('appTitle');
  }

  // ------------------------------------------------------------------ data

  private nodeLoaded(node: OctreeNode, data: NodeData): void {
    const r = this.starfield.add(node, data);
    r.points.visible = this.selectedPaths.has(node.path);
    this.candidatesDirty = true;
    if (node.path === 'r') this.loadingEl.classList.add('hidden');
    if (this.pendingSelect && this.pendingSelect.path === node.path) {
      const hit = this.pendingSelect;
      this.pendingSelect = null;
      this.select(this.starInfo(data, hit.index));
    }
  }

  private updateLod(): void {
    if (!this.octree || !this.loader) return;
    const s = this.store.get();
    const budget = QUALITY_BUDGET[s.quality];
    const h = this.renderer.domElement.clientHeight || window.innerHeight;
    const pxPerUnit = h / (2 * Math.tan(MathUtils.degToRad(this.camera.fov) / 2));
    const selected = selectNodes(this.octree, {
      cameraPos: this.camera.position,
      target: this.nav.target,
      radius: s.radius,
      budget,
      pixelsPerUnitAtUnitDistance: pxPerUnit,
    });
    this.selectedPaths = new Set(selected.map((n) => n.path));
    this.loader.request(selected, budget * 2);
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
          cands.push({
            key: `${d.path}:${i}`,
            pos: new Vector3(x, y, z),
            text: f & Flag.SUN ? t('theSun') : localName(name!.en, name!.de),
            rank: f & Flag.SUN ? 0 : name!.rank,
            logL: starLogL(d, i),
            sun: (f & Flag.SUN) !== 0,
            sys: d.systems.get(i),
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
      });
    }
    this.labels.candidates = cands;
    this.inView = inView;
    if (this.selected) this.info.refresh(this.nav.target);
  }

  private updateStatus(): void {
    if (!this.loader) return;
    const loaded = this.starfield.visiblePointCount();
    let text = t('stats', {
      loaded: loaded.toLocaleString(),
      visible: this.inView.toLocaleString(),
    });
    const pending = this.loader.pendingCount;
    if (pending > 0) text += ` · ${t('statsLoading', { pending })}`;
    this.status.textContent = text;
  }

  // ------------------------------------------------------------------ picking & selection

  private setupPointer(): void {
    const dom = this.renderer.domElement;
    let down: { x: number; y: number; time: number; id: number } | null = null;
    dom.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, time: performance.now(), id: e.pointerId };
    });
    dom.addEventListener('pointerup', (e) => {
      if (!down || down.id !== e.pointerId) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const dt = performance.now() - down.time;
      down = null;
      if (moved > 6 || dt > 600) return;
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
      system:
        sysId !== undefined && sys
          ? { id: sysId, nameEn: sys.nameEn ?? designationOf(d, i), nameDe: sys.nameDe, members: sys.members }
          : null,
    };
  }

  private select(info: StarInfo | null): void {
    this.selected = info;
    this.labels.selectedKey = info?.key ?? null;
    this.selMarker.show(info?.pos ?? null, this.renderer.getPixelRatio());
    this.info.show(info, this.nav.target);
    this.candidatesDirty = true;
  }

  private pickSearch(hit: SearchHit): void {
    const s = this.store.get();
    const dist = MathUtils.clamp(this.nav.distance, 3, Math.max(s.radius * 1.8, 10));
    this.nav.flyTo(hit.pos, dist);
    const data = this.loader?.get(hit.path);
    if (data) {
      this.select(this.starInfo(data, hit.index));
    } else {
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
      if (src.used !== undefined) li.appendChild(document.createTextNode(` — ${src.used.toLocaleString()}`));
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
        el('p', 'cite', `${this.manifest.starCount.toLocaleString()} ${t('stars')} · ${this.manifest.generated}`),
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

    const u = this.starfield.material.uniforms;
    u.uTarget.value.copy(this.nav.target);
    const h = this.renderer.domElement.clientHeight || window.innerHeight;
    u.uScale.value = (h * this.renderer.getPixelRatio()) / (2 * Math.tan(MathUtils.degToRad(this.camera.fov) / 2));
    u.uPixelRatio.value = this.renderer.getPixelRatio();
    // the more stars are in view, the fainter the faintest ones, so dense regions do not saturate
    u.uMinAlpha.value = MathUtils.clamp(0.55 * Math.sqrt(2500 / Math.max(this.inView, 1)), 0.035, 0.55);
    u.uMinPx.value = 2.6 * this.renderer.getPixelRatio();
    u.uMaxPx.value = 64 * this.renderer.getPixelRatio();

    if (this.lodDirty && now - this.lastLod > 120) {
      this.lodDirty = false;
      this.lastLod = now;
      this.updateLod();
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
    if (s.dropLines && s.labels) this.dropLines.set(this.labels.labelledPositions, this.nav.target.y);
    this.dropLines.lines.visible = s.dropLines && s.labels && s.grid;

    this.renderer.render(this.scene, this.camera);
  };
}
