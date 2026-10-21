import type { AttributeStore, PaletteId } from '../data/attributes';
import { parseNumber } from '../data/csv';
import { t, formatNumber, type MessageKey } from '../i18n';
import {
  BUILTIN_ATTRIBUTES,
  COLOR_TEMPERATURE,
  SIZE_LUMINOSITY,
  SIZE_UNIFORM,
  attributeInfo,
  builtin,
} from '../render/style';
import { RADIUS_MAX, RADIUS_MIN, type MissingStyle, type Quality, type Settings, type SettingsStore } from '../settings';
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

  constructor(
    parent: HTMLElement,
    private readonly store: SettingsStore,
    private readonly attrs: AttributeStore,
  ) {
    this.root = el('aside', 'panel');
    this.root.id = 'settings-panel';
    this.body = el('div', 'panel-body');
    this.root.appendChild(this.body);
    parent.appendChild(this.root);
    this.render();
  }

  /**
   * Called by the app after a settings change, once the new language is active (the panel does
   * not subscribe to the store itself, so it never renders before the language has switched).
   */
  settingsChanged(changed: (keyof Settings)[]): void {
    if (changed.includes('lang')) this.render();
    else {
      this.sync();
      if (changed.some((k) => k === 'colorBy' || k === 'sizeBy')) this.renderLayers();
    }
  }

  /** The attribute list changed (added, renamed, deleted). */
  attributesChanged(): void {
    this.renderLayers();
  }

  toggle(open?: boolean): void {
    const isOpen = open ?? !this.root.classList.contains('open');
    this.root.classList.toggle('open', isOpen);
  }

  get isOpen(): boolean {
    return this.root.classList.contains('open');
  }

  private syncers: (() => void)[] = [];

  private sync(): void {
    for (const s of this.syncers) s();
    for (const s of this.layerSyncers) s();
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
      this.slider('starSize', 0.2, 4, 0.05, () => s().starSize, (v) => this.store.set({ starSize: v }), () => `${s().starSize.toFixed(2)}×`),
    );
    b.appendChild(
      this.slider('brightness', 0.2, 3, 0.05, () => s().brightness, (v) => this.store.set({ brightness: v }), () => `${s().brightness.toFixed(2)}×`),
    );
    b.appendChild(
      this.slider('saturation', 0, 3, 0.05, () => s().saturation, (v) => this.store.set({ saturation: v }), () => `${s().saturation.toFixed(2)}×`),
    );
    b.appendChild(this.checkbox('grid', () => s().grid, (v) => this.store.set({ grid: v })));
    b.appendChild(this.checkbox('dropLines', () => s().dropLines, (v) => this.store.set({ dropLines: v })));
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
      [t('userGroup'), defs.map((d) => [d.id, d.name] as Option)],
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
      [t('userGroup'), defs.filter((d) => d.type === 'number').map((d) => [d.id, d.name] as Option)],
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
      box.appendChild(this.checkbox('showLegend', () => this.store.get().legend, (v) => this.store.set({ legend: v })));
    }
    const manage = el('button', 'btn', t('manageAttributes'));
    manage.addEventListener('click', () => this.onManageAttributes());
    box.appendChild(manage);
    this.layerSyncers = this.syncers;
    this.syncers = panelSyncers;
    if (focusIndex >= 0) all()[focusIndex]?.focus();
  }

  /** Palette, range, log and reverse of a numeric attribute. */
  private scaleControls(id: string, withPalette = true): HTMLElement {
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
      input.value = v === undefined ? '' : formatValue(v);
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
    flag('reverse', 'reverseScale');
    wrap.appendChild(flags);
    return wrap;
  }

  /** A select with plain options plus option groups (empty groups are left out). */
  private dynSelect(label: string, options: Option[], groups: OptGroup[], get: () => string, set: (v: string) => void): HTMLElement {
    const wrap = el('label', 'row select');
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
    input.addEventListener('input', () => {
      set(Number(input.value));
      value.textContent = display();
    });
    wrap.append(head, input);
    this.syncers.push(() => {
      if (document.activeElement !== input) input.value = String(get());
      value.textContent = display();
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
