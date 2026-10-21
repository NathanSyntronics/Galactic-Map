export type Lang = 'en' | 'de';
export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface Settings {
  lang: Lang;
  /** Radius of the visibility sphere around the view centre, in light years. */
  radius: number;
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
}

export const DEFAULT_SETTINGS: Settings = {
  lang: 'en',
  radius: 20,
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
};

export const QUALITY_BUDGET: Record<Quality, number> = {
  low: 250_000,
  medium: 600_000,
  high: 1_500_000,
  ultra: 4_000_000,
};

export const RADIUS_MIN = 2;
export const RADIUS_MAX = 50_000;

const STORAGE_KEY = 'galactic-map:settings:v1';
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

  constructor() {
    this.state = { ...DEFAULT_SETTINGS, ...loadStored() };
    if (window.matchMedia?.('(max-width: 700px)').matches && !hasStored()) {
      this.state.quality = 'low';
      this.state.labelCount = 25;
    }
  }

  get(): Readonly<Settings> {
    return this.state;
  }

  set(patch: Partial<Settings>): void {
    const changed = (Object.keys(patch) as (keyof Settings)[]).filter((k) => patch[k] !== this.state[k]);
    if (changed.length === 0) return;
    this.state = { ...this.state, ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(storedForm(this.state)));
    } catch {
      // storage unavailable (private mode etc.) – settings simply are not persisted
    }
    for (const l of this.listeners) l(this.state, changed);
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
    (out as Record<string, unknown>)[k] = parsed[k];
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
