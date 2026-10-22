import { formatNumber } from './i18n';
export type Lang = 'en' | 'de';
export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export type MissingStyle = 'dim' | 'hide' | 'normal';
export type JumpColor = 'stars' | 'uniform' | 'length';

export interface Settings {
  lang: Lang;
  /** Radius of the visibility sphere around the view centre, in light years. */
  radius: number;
  /** The radius follows the zoom: camera distance / AUTO_RADIUS_RATIO. */
  autoRadius: boolean;
  labels: boolean;
  /** Maximum number of labels on screen. */
  labelCount: number;
  /** Also label stars that only have catalogue designations. */
  labelDesignations: boolean;
  showBrownDwarfs: boolean;
  showWhiteDwarfs: boolean;
  /** Hide stars whose relative distance uncertainty exceeds this (percent); >= 100 disables the filter. */
  maxDistErr: number;
  starSize: number;
  brightness: number;
  saturation: number;
  grid: boolean;
  dropLines: boolean;
  quality: Quality;
  /** Attribute that sets the star colours ('' natural temperature colour). */
  colorBy: string;
  /** Attribute that sets the symbol sizes ('' luminosity, 'uniform'). */
  sizeBy: string;
  /** Stars without a value for colorBy / sizeBy. */
  missingStyle: MissingStyle;
  legend: boolean;
  /** Jump network (docs/JUMP_NETWORK.md). */
  jumps: boolean;
  /** Longest link in light years. */
  jumpRange: number;
  /** Links wanted by faint stars (log L <= -4.5), Sun-like stars and bright stars (log L >= 1.5). */
  jumpFaint: number;
  jumpSun: number;
  jumpBright: number;
  /** Numeric attribute that sets the number of links ('' luminosity). */
  jumpBy: string;
  /** Hub preference: 0 pure distance, higher values serve big stars first. */
  jumpHub: number;
  /** Add the shortest links that join otherwise separate groups. */
  jumpConnect: boolean;
  jumpColor: JumpColor;
  jumpOpacity: number;
}

export const DEFAULT_SETTINGS: Settings = {
  lang: 'en',
  radius: 20,
  autoRadius: true,
  labels: true,
  labelCount: 30,
  labelDesignations: true,
  showBrownDwarfs: false,
  showWhiteDwarfs: true,
  maxDistErr: 20,
  starSize: 1,
  brightness: 1,
  saturation: 1.6,
  grid: true,
  dropLines: true,
  quality: 'medium',
  colorBy: '',
  sizeBy: '',
  missingStyle: 'dim',
  legend: true,
  jumps: true,
  jumpRange: 9,
  jumpFaint: 2,
  jumpSun: 6,
  jumpBright: 12,
  jumpBy: '',
  jumpHub: 1,
  jumpConnect: true,
  jumpColor: 'length',
  jumpOpacity: 0.6,
};

/** Allowed values of the settings with a fixed set of choices. */
const CHOICES: Partial<Record<keyof Settings, readonly unknown[]>> = {
  lang: ['en', 'de'],
  quality: ['low', 'medium', 'high', 'ultra'],
  missingStyle: ['dim', 'hide', 'normal'],
  jumpColor: ['stars', 'uniform', 'length'],
};

/** Range of numeric settings whose controls are sliders with fixed ends. */
const RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  starSize: [0.2, 12],
  jumpRange: [2, 25],
  jumpFaint: [0, 20],
  jumpSun: [0, 20],
  jumpBright: [0, 20],
  jumpHub: [0, 2],
  jumpOpacity: [0.05, 1],
};

export const QUALITY_BUDGET: Record<Quality, number> = {
  low: 250_000,
  medium: 600_000,
  high: 1_500_000,
  ultra: 4_000_000,
};

export const RADIUS_MIN = 2;
export const RADIUS_MAX = 50_000;

/** Camera distance per light year of radius in the default view (44 ly for 20 ly). */
export const AUTO_RADIUS_RATIO = 2.2;
/** While the radius follows the zoom, it changes once it is off by more than this fraction. */
export const AUTO_RADIUS_STEP = 0.01;

/** Visible radius for a camera distance (radius follows zoom), to three significant digits. */
export function radiusForDistance(distance: number): number {
  const r = Math.min(Math.max(distance / AUTO_RADIUS_RATIO, RADIUS_MIN), RADIUS_MAX);
  return Number(r.toPrecision(3));
}

/** Camera distance that shows a radius (radius follows zoom). */
export function distanceForRadius(radius: number): number {
  return radius * AUTO_RADIUS_RATIO;
}

/** The radius for a new camera distance, or null while it is within AUTO_RADIUS_STEP of the current one. */
export function followZoom(radius: number, distance: number): number | null {
  const r = radiusForDistance(distance);
  return Math.abs(r - radius) > AUTO_RADIUS_STEP * radius ? r : null;
}

export const STAR_SIZE_MIN = 0.2;
export const STAR_SIZE_MAX = 12;
const STAR_SIZE_SPAN = Math.log(STAR_SIZE_MAX / STAR_SIZE_MIN);

/** Position (0..1) of a star size on its logarithmic slider. */
export function starSizeToSlider(size: number): number {
  const v = Math.log(size / STAR_SIZE_MIN) / STAR_SIZE_SPAN;
  return Math.min(Math.max(v, 0), 1);
}

/** Star size at a slider position, rounded as displayed: 0.01 below 2×, 0.1 from 2× up. */
export function sliderToStarSize(v: number): number {
  const size = STAR_SIZE_MIN * Math.exp(Math.min(Math.max(v, 0), 1) * STAR_SIZE_SPAN);
  const d = size < 2 ? 100 : 10;
  return Math.min(Math.max(Math.round(size * d) / d, STAR_SIZE_MIN), STAR_SIZE_MAX);
}

/** Display text of a star size ("0.85×", "1.00×", "8.0×"; decimal comma in German). */
export function starSizeText(size: number): string {
  return `${formatNumber(size, size < 2 ? 2 : 1)}×`;
}

const STORAGE_KEY = 'galactic-map:settings:v1';
/** Settings are written this long after the last change (the radius changes while zooming). */
export const SAVE_DELAY_MS = 400;
/** Marker of the stored format that holds only the values that differ from the defaults. */
const STORED_FORMAT = 2;
/**
 * Defaults of the first version, which stored the complete settings: values equal to these were
 * almost certainly never changed by the user, so they give way to the current defaults.
 */
const LEGACY_DEFAULTS: Partial<Settings> = { radius: 50, labelCount: 60 };

type Listener = (s: Settings, changed: (keyof Settings)[]) => void;

export class SettingsStore {
  private state: Settings;
  private listeners: Listener[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.state = { ...DEFAULT_SETTINGS, ...loadStored() };
    if (window.matchMedia?.('(max-width: 700px)').matches && !hasStored()) {
      this.state.quality = 'low';
      this.state.labelCount = 25;
    }
    // a pending change is written before the page goes away
    window.addEventListener('pagehide', () => this.flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush();
    });
  }

  get(): Readonly<Settings> {
    return this.state;
  }

  set(patch: Partial<Settings>): void {
    const changed = (Object.keys(patch) as (keyof Settings)[]).filter((k) => patch[k] !== this.state[k]);
    if (changed.length === 0) return;
    this.state = { ...this.state, ...patch };
    // written once the changes pause, not on every step of a zoom
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    for (const l of this.listeners) l(this.state, changed);
  }

  /** Writes a pending change now. */
  flush(): void {
    if (this.saveTimer === null) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(storedForm(this.state)));
    } catch {
      // storage unavailable (private mode etc.) – settings simply are not persisted
    }
  }

  reset(): void {
    const lang = this.state.lang;
    this.set({ ...DEFAULT_SETTINGS, lang });
  }

  subscribe(l: Listener): void {
    this.listeners.push(l);
  }
}

function hasStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** Only the values that differ from the defaults are stored, so changed defaults reach every user. */
export function storedForm(s: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = { v: STORED_FORMAT };
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (s[k] !== DEFAULT_SETTINGS[k]) out[k] = s[k];
  }
  return out;
}

/** Settings from their stored form (current or first version). */
export function parseStored(raw: string | null): Partial<Settings> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Partial<Settings> & { v?: number };
  const legacy = parsed.v === undefined;
  const out: Partial<Settings> = {};
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (!(k in parsed) || typeof parsed[k] !== typeof DEFAULT_SETTINGS[k]) continue;
    if (legacy && k in LEGACY_DEFAULTS && parsed[k] === LEGACY_DEFAULTS[k]) continue;
    const choices = CHOICES[k];
    if (choices && !choices.includes(parsed[k])) continue;
    let v = parsed[k];
    const range = RANGES[k];
    if (range && typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      v = Math.min(Math.max(v, range[0]), range[1]);
    }
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function loadStored(): Partial<Settings> {
  try {
    return parseStored(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}
