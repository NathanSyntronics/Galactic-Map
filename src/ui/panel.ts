import { t, formatNumber, type MessageKey } from '../i18n';
import { RADIUS_MAX, RADIUS_MIN, type Quality, type Settings, type SettingsStore } from '../settings';

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

  constructor(
    parent: HTMLElement,
    private readonly store: SettingsStore,
  ) {
    this.root = el('aside', 'panel');
    this.root.id = 'settings-panel';
    this.body = el('div', 'panel-body');
    this.root.appendChild(this.body);
    parent.appendChild(this.root);
    this.render();
    store.subscribe((_s, changed) => {
      if (changed.includes('lang')) this.render();
      else this.sync();
    });
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
  }

  private render(): void {
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

export type { Settings };
