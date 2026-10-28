import { attrName, type AttributeStore, type PaletteId } from '../data/attributes';
import { parseNumber } from '../data/csv';
import { getLang, t, formatNumber, numberText, type MessageKey } from '../i18n';
import {
  BUILTIN_ATTRIBUTES,
  COLOR_TEMPERATURE,
  SIZE_LUMINOSITY,
  SIZE_UNIFORM,
  attributeInfo,
  builtin,
} from '../render/style';
import {
  RADIUS_MAX,
  RADIUS_MIN,
  sliderToStarSize,
  starSizeText,
  starSizeToSlider,
  type JumpColor,
  type MissingStyle,
  type Quality,
  type Settings,
  type SettingsStore,
} from '../settings';
import { formatValue } from './legend';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const radiusToSlider = (r: number) => Math.log(r / RADIUS_MIN) / Math.log(RADIUS_MAX / RADIUS_MIN);
const sliderToRadius = (v: number) => {
  const r = RADIUS_MIN * Math.pow(RADIUS_MAX / RADIUS_MIN, v);
  // round to 2 significant digits for a tidy display
  const p = Math.pow(10, Math.floor(Math.log10(r)) - 1);
  return Math.round(r / p) * p;
};

/** Settings side panel. Rebuilt on language change. */
export class SettingsPanel {
  readonly root: HTMLElement;
  private body: HTMLElement;
  onGoToSun: () => void = () => {};
  onHelp: () => void = () => {};
  onAbout: () => void = () => {};
  onManageAttributes: () => void = () => {};
  /** The data layer controls; rebuilt when the chosen attributes or the attribute list change. */
  private readonly layers = el('div', 'layers');
  /** The jump network controls; rebuilt when the network is switched or its attribute changes. */
  private readonly jumpBox = el('div', 'jumps');
  /** Link count or the reason why there is no network (kept across rebuilds). */
  private readonly jumpStatus = el('p', 'hint jump-status');
  /**
   * Transparent layer over the map and the other controls while the panel is open: a press
   * anywhere outside the panel only closes it (no star pick, no rotation). It stays until that
   * press has ended, so that its release and click land nowhere either.
   */
  private readonly scrim = el('div', 'panel-scrim');
  /** Pointers of the press that closed the panel, still down. */
  private readonly held = new Set<number>();
  private releaseTimer = 0;
  /** A wheel turned over the scrim (the app zooms the map with it). */
  onScrimWheel: (e: WheelEvent) => void = () => {};

  constructor(
    parent: HTMLElement,
    private readonly store: SettingsStore,
    private readonly attrs: AttributeStore,
  ) {
    this.root = el('aside', 'panel');
    this.root.id = 'settings-panel';
    this.body = el('div', 'panel-body');
    this.root.appendChild(this.body);
    this.scrim.setAttribute('aria-hidden', 'true');
    parent.append(this.scrim, this.root);
    this.setupScrim();
    this.render();
  }

  private setupScrim(): void {
    const s = this.scrim;
    s.addEventListener('pointerdown', (e) => {
      // a new gesture: forget pointers whose release was never seen
      if (e.isPrimary) this.held.clear();
      this.held.add(e.pointerId);
      window.clearTimeout(this.releaseTimer);
      try {
        s.setPointerCapture(e.pointerId);
      } catch {
        // the pointer is already gone
      }
      this.toggle(false);
    });
    const up = (e: PointerEvent) => {
      if (!this.held.delete(e.pointerId) || this.held.size) return;
      // the click of a tap follows the release; a drag has none
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = window.setTimeout(() => this.releaseScrim(), 400);
    };
    s.addEventListener('pointerup', up);
    s.addEventListener('pointercancel', up);
    s.addEventListener('lostpointercapture', up);
    s.addEventListener('click', () => {
      if (!this.held.size) this.releaseScrim();
    });
    s.addEventListener('contextmenu', (e) => e.preventDefault());
    s.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.onScrimWheel(e);
      },
      { passive: false },
    );
  }

  private releaseScrim(): void {
    window.clearTimeout(this.releaseTimer);
    this.held.clear();
    if (!this.isOpen) this.scrim.classList.remove('active');
  }

  /**
   * Called by the app after a settings change, once the new language is active (the panel does
   * not subscribe to the store itself, so it never renders before the language has switched).
   */
  settingsChanged(changed: (keyof Settings)[]): void {
    if (changed.includes('lang')) this.render();
    else {
      this.sync();
      if (changed.some((k) => k === 'colorBy' || k === 'sizeBy' || k === 'jumps')) this.renderLayers();
      if (changed.some((k) => k === 'jumps' || k === 'jumpBy' || k === 'colorBy' || k === 'sizeBy')) this.renderJumps();
    }
  }

  /** The attribute list changed (added, renamed, deleted). */
  attributesChanged(): void {
    this.renderLayers();
    this.renderJumps();
  }

  /** Status line of the jump network; `warn` marks a reason why it is not shown. */
  setJumpStatus(text: string, warn = false): void {
    if (this.jumpStatus.textContent !== text) this.jumpStatus.textContent = text;
    this.jumpStatus.classList.toggle('warn', warn);
    this.jumpStatus.hidden = !text;
  }

  toggle(open?: boolean): void {
    const isOpen = open ?? !this.root.classList.contains('open');
    this.root.classList.toggle('open', isOpen);
    if (isOpen) {
      this.held.clear();
      window.clearTimeout(this.releaseTimer);
      this.scrim.classList.add('active');
    } else if (!this.held.size) {
      // closed by its own button or a key: no press to wait for
      this.releaseScrim();
    }
  }

  get isOpen(): boolean {
    return this.root.classList.contains('open');
  }

  private syncers: (() => void)[] = [];

  private sync(): void {
    for (const s of this.syncers) s();
    for (const s of this.layerSyncers) s();
    for (const s of this.jumpSyncers) s();
  }

  private focusables(): HTMLElement[] {
    return [...this.body.querySelectorAll<HTMLElement>('input, select, button')];
  }

  private render(): void {
    // a re-render (language switch) keeps keyboard focus on the same control
    const active = document.activeElement;
    const focusIndex = active instanceof HTMLElement ? this.focusables().indexOf(active) : -1;
    this.body.replaceChildren();
    this.syncers = [];
    const s = () => this.store.get();
    const b = this.body;

    const header = el('div', 'panel-header');
    header.appendChild(el('h2', '', t('settings')));
    const close = el('button', 'icon-btn', '×');
    close.setAttribute('aria-label', t('close'));
    close.addEventListener('click', () => this.toggle(false));
    header.appendChild(close);
    b.appendChild(header);

    // --- View
    b.appendChild(el('h3', '', t('view')));
    const radiusRow = this.slider(
      'radius',
      0,
      1,
      0.001,
      () => radiusToSlider(s().radius),
      (v) => this.store.set({ radius: sliderToRadius(v) }),
      () => `${formatNumber(s().radius, s().radius < 10 ? 1 : 0)} ${t('ly')}`,
    );
    b.appendChild(radiusRow);
    b.appendChild(this.checkbox('autoRadius', () => s().autoRadius, (v) => this.store.set({ autoRadius: v })));
    b.appendChild(el('p', 'hint', t('radiusHint')));
    const sunBtn = el('button', 'btn', `☉ ${t('goToSun')}`);
    sunBtn.addEventListener('click', () => this.onGoToSun());
    b.appendChild(sunBtn);

    // --- Stars
    b.appendChild(el('h3', '', t('stars')));
    b.appendChild(this.checkbox('brownDwarfs', () => s().showBrownDwarfs, (v) => this.store.set({ showBrownDwarfs: v })));
    b.appendChild(this.checkbox('whiteDwarfs', () => s().showWhiteDwarfs, (v) => this.store.set({ showWhiteDwarfs: v })));
    b.appendChild(
      this.slider(
        'maxDistErr',
        1,
        100,
        1,
        () => s().maxDistErr,
        (v) => this.store.set({ maxDistErr: v }),
        () => (s().maxDistErr >= 100 ? t('noLimit') : `${s().maxDistErr} %`),
      ),
    );

    // --- Data layers
    b.appendChild(el('h3', '', t('dataLayers')));
    b.appendChild(this.layers);
    this.renderLayers();

    // --- Jump network
    b.appendChild(el('h3', '', t('jumpSection')));
    b.appendChild(this.jumpBox);
    this.renderJumps();

    // --- Labels
    b.appendChild(el('h3', '', t('labelsSection')));
    b.appendChild(this.checkbox('labels', () => s().labels, (v) => this.store.set({ labels: v })));
    b.appendChild(
      this.slider('labelCount', 5, 300, 1, () => s().labelCount, (v) => this.store.set({ labelCount: v }), () => String(s().labelCount)),
    );
    b.appendChild(
      this.checkbox('labelDesignations', () => s().labelDesignations, (v) => this.store.set({ labelDesignations: v })),
    );

    // --- Display
    b.appendChild(el('h3', '', t('display')));
    b.appendChild(
      // logarithmic, so that small sizes stay as easy to set as large ones
      this.slider(
        'starSize',
        0,
        1,
        0.001,
        () => starSizeToSlider(s().starSize),
        (v) => this.store.set({ starSize: sliderToStarSize(v) }),
        () => starSizeText(s().starSize),
      ),
    );
    b.appendChild(
      this.slider('brightness', 0.2, 3, 0.05, () => s().brightness, (v) => this.store.set({ brightness: v }), () => `${formatNumber(s().brightness, 2)}×`),
    );
    b.appendChild(
      this.slider('saturation', 0, 3, 0.05, () => s().saturation, (v) => this.store.set({ saturation: v }), () => `${formatNumber(s().saturation, 2)}×`),
    );
    b.appendChild(this.checkbox('grid', () => s().grid, (v) => this.store.set({ grid: v })));
    b.appendChild(this.checkbox('dropLines', () => s().dropLines, (v) => this.store.set({ dropLines: v })));
    b.appendChild(this.checkbox('galaxies', () => s().galaxies, (v) => this.store.set({ galaxies: v })));
    b.appendChild(this.checkbox('milkyWay', () => s().milkyWay, (v) => this.store.set({ milkyWay: v })));
    b.appendChild(
      this.select<Quality>(
        'quality',
        [
          ['low', 'qualityLow'],
          ['medium', 'qualityMedium'],
          ['high', 'qualityHigh'],
          ['ultra', 'qualityUltra'],
        ],
        () => s().quality,
        (v) => this.store.set({ quality: v }),
      ),
    );
    b.appendChild(el('p', 'hint', t('qualityHint')));
    b.appendChild(
      this.select<'en' | 'de'>(
        'language',
        [
          ['en', 'English' as MessageKey],
          ['de', 'Deutsch' as MessageKey],
        ],
        () => s().lang,
        (v) => this.store.set({ lang: v }),
        true,
      ),
    );

    const footer = el('div', 'panel-footer');
    const help = el('button', 'btn', t('help'));
    help.addEventListener('click', () => this.onHelp());
    const about = el('button', 'btn', t('about'));
    about.addEventListener('click', () => this.onAbout());
    const reset = el('button', 'btn subtle', t('resetSettings'));
    reset.addEventListener('click', () => this.store.reset());
    footer.append(help, about, reset);
    b.appendChild(footer);
    if (focusIndex >= 0) this.focusables()[focusIndex]?.focus();
  }

  private layerSyncers: (() => void)[] = [];

  private renderLayers(): void {
    const box = this.layers;
    const active = document.activeElement;
    const all = () => [...box.querySelectorAll<HTMLElement>('input, select, button')];
    const focusIndex = active instanceof HTMLElement ? all().indexOf(active) : -1;
    box.replaceChildren();
    // the control helpers register their syncers in this.syncers: collect the layer ones apart
    const panelSyncers = this.syncers;
    this.syncers = [];
    const s = this.store.get();
    const defs = this.attrs.defs;

    // colour
    const colorOpts: Option[] = [[COLOR_TEMPERATURE, t('colorTemperature')]];
    const colorGroups: OptGroup[] = [
      [t('builtinGroup'), BUILTIN_ATTRIBUTES.filter((a) => a.id !== '@teff').map((a) => [a.id, t(a.label)] as Option)],
      [t('userGroup'), defs.map((d) => [d.id, attrName(d, getLang())] as Option)],
    ];
    box.appendChild(
      this.dynSelect(t('colorBy'), colorOpts, colorGroups, () => this.store.get().colorBy, (v) => this.store.set({ colorBy: v })),
    );
    const color = s.colorBy ? attributeInfo(s.colorBy, this.attrs) : null;
    if (color?.type === 'number') box.appendChild(this.scaleControls(color.id));

    // size
    const sizeOpts: Option[] = [
      [SIZE_LUMINOSITY, t('sizeLuminosity')],
      [SIZE_UNIFORM, t('sizeUniform')],
    ];
    const sizeGroups: OptGroup[] = [
      [t('builtinGroup'), BUILTIN_ATTRIBUTES.filter((a) => a.type === 'number' && a.id !== '@lum').map((a) => [a.id, t(a.label)] as Option)],
      [t('userGroup'), defs.filter((d) => d.type === 'number').map((d) => [d.id, attrName(d, getLang())] as Option)],
    ];
    box.appendChild(
      this.dynSelect(t('sizeBy'), sizeOpts, sizeGroups, () => this.store.get().sizeBy, (v) => this.store.set({ sizeBy: v })),
    );
    const size = s.sizeBy && s.sizeBy !== SIZE_UNIFORM ? attributeInfo(s.sizeBy, this.attrs) : null;
    if (size?.type === 'number' && size.id !== color?.id) box.appendChild(this.scaleControls(size.id, false));

    if (color || size) {
      box.appendChild(
        this.select<MissingStyle>(
          'missingStyle',
          [
            ['dim', 'missingDim'],
            ['hide', 'missingHide'],
            ['normal', 'missingNormal'],
          ],
          () => this.store.get().missingStyle,
          (v) => this.store.set({ missingStyle: v }),
        ),
      );
    }
    if (color || size || s.jumps) {
      box.appendChild(this.checkbox('showLegend', () => this.store.get().legend, (v) => this.store.set({ legend: v })));
    }
    const manage = el('button', 'btn', t('manageAttributes'));
    manage.addEventListener('click', () => this.onManageAttributes());
    box.appendChild(manage);
    this.layerSyncers = this.syncers;
    this.syncers = panelSyncers;
    if (focusIndex >= 0) all()[focusIndex]?.focus();
  }

  private jumpSyncers: (() => void)[] = [];

  private renderJumps(): void {
    const box = this.jumpBox;
    const active = document.activeElement;
    const all = () => [...box.querySelectorAll<HTMLElement>('input, select, button')];
    const focusIndex = active instanceof HTMLElement ? all().indexOf(active) : -1;
    box.replaceChildren();
    const panelSyncers = this.syncers;
    this.syncers = [];
    const s = () => this.store.get();
    const set = (patch: Partial<Settings>) => this.store.set(patch);

    box.appendChild(this.checkbox('jumps', () => s().jumps, (v) => set({ jumps: v })));
    if (s().jumps) {
      box.appendChild(el('p', 'hint', t('jumpIntro')));
      const ly = (v: number) => `${formatNumber(v, Number.isInteger(v) ? 0 : 1)} ${t('ly')}`;
      box.appendChild(this.slider('jumpRange', 2, 25, 0.5, () => s().jumpRange, (v) => set({ jumpRange: v }), () => ly(s().jumpRange)));

      const defs = this.attrs.defs;
      const groups: OptGroup[] = [
        [t('builtinGroup'), BUILTIN_ATTRIBUTES.filter((a) => a.type === 'number' && a.id !== '@lum').map((a) => [a.id, t(a.label)] as Option)],
        [t('userGroup'), defs.filter((d) => d.type === 'number').map((d) => [d.id, attrName(d, getLang())] as Option)],
      ];
      box.appendChild(this.dynSelect(t('jumpBy'), [['', t('sizeLuminosity')]], groups, () => s().jumpBy, (v) => set({ jumpBy: v })));
      const by = s().jumpBy ? attributeInfo(s().jumpBy, this.attrs) : null;
      const byAttr = by?.type === 'number';
      if (byAttr) {
        // the scale controls are already in the data layers when the map is coloured or sized by it
        const shown = [s().colorBy, s().sizeBy].some((id) => id === by.id);
        // without 'reverse': a higher value always gives more links
        if (!shown) box.appendChild(this.scaleControls(by.id, false, false));
      }
      const count = (v: number) => String(v);
      box.appendChild(
        this.slider(byAttr ? 'jumpLow' : 'jumpFaint', 0, 20, 1, () => s().jumpFaint, (v) => set({ jumpFaint: v }), () => count(s().jumpFaint)),
      );
      if (!byAttr) {
        box.appendChild(this.slider('jumpSun', 0, 20, 1, () => s().jumpSun, (v) => set({ jumpSun: v }), () => count(s().jumpSun)));
      }
      box.appendChild(
        this.slider(byAttr ? 'jumpHigh' : 'jumpBright', 0, 20, 1, () => s().jumpBright, (v) => set({ jumpBright: v }), () => count(s().jumpBright)),
      );
      box.appendChild(el('p', 'hint', t(byAttr ? 'jumpAttrHint' : 'jumpCapacityHint')));
      box.appendChild(this.slider('jumpHub', 0, 2, 0.1, () => s().jumpHub, (v) => set({ jumpHub: v }), () => formatNumber(s().jumpHub, 1)));
      box.appendChild(el('p', 'hint', t('jumpHubHint')));
      box.appendChild(this.checkbox('jumpConnect', () => s().jumpConnect, (v) => set({ jumpConnect: v })));
      box.appendChild(el('p', 'hint', t('jumpConnectHint')));
      box.appendChild(
        this.select<JumpColor>(
          'jumpColor',
          [
            ['stars', 'jumpColorStars'],
            ['uniform', 'jumpColorUniform'],
            ['length', 'jumpColorLength'],
          ],
          () => s().jumpColor,
          (v) => set({ jumpColor: v }),
        ),
      );
      box.appendChild(
        this.slider('jumpOpacity', 0.05, 1, 0.05, () => s().jumpOpacity, (v) => set({ jumpOpacity: v }), () => `${Math.round(s().jumpOpacity * 100)} %`),
      );
      box.appendChild(this.jumpStatus);
    }
    this.jumpSyncers = this.syncers;
    this.syncers = panelSyncers;
    if (focusIndex >= 0) all()[focusIndex]?.focus();
  }

  /** Palette, range, log and reverse of a numeric attribute. */
  private scaleControls(id: string, withPalette = true, withReverse = true): HTMLElement {
    const wrap = el('div', 'scale-controls');
    const sc = this.attrs.scale(id);
    const defaults = builtin(id)?.scale ?? {};
    if (withPalette) {
      const sel = el('select');
      const palettes: [PaletteId, MessageKey][] = [
        ['turbo', 'paletteTurbo'],
        ['plasma', 'palettePlasma'],
        ['viridis', 'paletteViridis'],
        ['blueRed', 'paletteBlueRed'],
      ];
      for (const [v, k] of palettes) {
        const o = el('option', '', t(k));
        o.value = v;
        sel.appendChild(o);
      }
      sel.value = sc.palette ?? defaults.palette ?? 'turbo';
      sel.setAttribute('aria-label', t('palette'));
      sel.addEventListener('change', () => this.attrs.setScale(id, { palette: sel.value as PaletteId }));
      const row = el('label', 'row select');
      row.append(el('span', '', t('palette')), sel);
      wrap.appendChild(row);
    }
    const range = el('div', 'row range');
    const num = (key: 'min' | 'max', label: MessageKey) => {
      const input = el('input');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.size = 7;
      const v = sc[key];
      input.value = v === undefined ? '' : numberText(v);
      const auto = defaults[key];
      input.placeholder = auto === undefined ? t('scaleAuto') : formatValue(auto);
      input.setAttribute('aria-label', t(label));
      input.addEventListener('change', () => {
        const raw = input.value.trim();
        const n = raw ? parseNumber(raw, true) : null;
        input.classList.toggle('invalid', !!raw && n === null);
        if (raw && n === null) return;
        this.attrs.setScale(id, { [key]: n ?? undefined });
      });
      range.append(el('span', '', t(label)), input);
    };
    num('min', 'scaleFrom');
    num('max', 'scaleTo');
    wrap.appendChild(range);
    const flags = el('div', 'row flags');
    const flag = (key: 'log' | 'reverse', label: MessageKey) => {
      const l = el('label', 'check');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = sc[key] ?? defaults[key] ?? false;
      input.addEventListener('change', () => this.attrs.setScale(id, { [key]: input.checked }));
      l.append(input, el('span', '', t(label)));
      flags.appendChild(l);
    };
    flag('log', 'logScale');
    if (withReverse) flag('reverse', 'reverseScale');
    wrap.appendChild(flags);
    return wrap;
  }

  /** A select with plain options plus option groups (empty groups are left out). */
  private dynSelect(label: string, options: Option[], groups: OptGroup[], get: () => string, set: (v: string) => void): HTMLElement {
    const wrap = el('label', 'row select stacked');
    wrap.appendChild(el('span', '', label));
    const sel = el('select');
    const add = (parent: HTMLElement, [v, text]: Option) => {
      const o = el('option', '', text);
      o.value = v;
      parent.appendChild(o);
    };
    for (const o of options) add(sel, o);
    for (const [name, opts] of groups) {
      if (!opts.length) continue;
      const g = el('optgroup');
      g.label = name;
      for (const o of opts) add(g, o);
      sel.appendChild(g);
    }
    sel.value = get();
    if (sel.value !== get()) sel.selectedIndex = 0;
    sel.addEventListener('change', () => set(sel.value));
    wrap.appendChild(sel);
    return wrap;
  }

  private checkbox(key: MessageKey, get: () => boolean, set: (v: boolean) => void): HTMLElement {
    const label = el('label', 'row check');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = get();
    input.addEventListener('change', () => set(input.checked));
    label.append(input, el('span', '', t(key)));
    this.syncers.push(() => (input.checked = get()));
    return label;
  }

  private slider(
    key: MessageKey,
    min: number,
    max: number,
    step: number,
    get: () => number,
    set: (v: number) => void,
    display: () => string,
  ): HTMLElement {
    const wrap = el('label', 'row slider');
    const head = el('div', 'slider-head');
    const value = el('span', 'value', display());
    head.append(el('span', '', t(key)), value);
    const input = el('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(get());
    // the thumb is not moved under the user's hand (a value can also change from elsewhere, like
    // the radius while it follows the zoom)
    let busy = false;
    let dragging = false;
    input.addEventListener('pointerdown', () => {
      dragging = true;
      const up = () => {
        dragging = false;
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    // released (also when the pointerup went elsewhere)
    input.addEventListener('change', () => (dragging = false));
    input.addEventListener('input', () => {
      busy = true;
      try {
        set(Number(input.value));
      } finally {
        busy = false;
      }
      value.textContent = display();
    });
    wrap.append(head, input);
    this.syncers.push(() => {
      if (!busy && !dragging) input.value = String(get());
      const text = display();
      if (value.textContent !== text) value.textContent = text;
    });
    return wrap;
  }

  private select<T extends string>(
    key: MessageKey,
    options: [T, MessageKey][],
    get: () => T,
    set: (v: T) => void,
    literalLabels = false,
  ): HTMLElement {
    const wrap = el('label', 'row select');
    wrap.appendChild(el('span', '', t(key)));
    const sel = el('select');
    for (const [v, labelKey] of options) {
      const o = el('option', '', literalLabels ? labelKey : t(labelKey));
      o.value = v;
      sel.appendChild(o);
    }
    sel.value = get();
    sel.addEventListener('change', () => set(sel.value as T));
    wrap.appendChild(sel);
    this.syncers.push(() => (sel.value = get()));
    return wrap;
  }
}

type Option = [string, string];
type OptGroup = [string, Option[]];

export type { Settings };
