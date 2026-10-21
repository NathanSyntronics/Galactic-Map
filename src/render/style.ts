import type { AttrType, AttrValue, AttributeScale, AttributeStore, PaletteId } from '../data/attributes';
import { Flag, UNKNOWN_I16, spectralClassOf, type NodeData } from '../data/format';
import type { MessageKey } from '../i18n';
export type { MissingStyle };

import type { MissingStyle } from '../settings';

/** Size mode: '' luminosity (default), 'uniform', or an attribute id. */
export const SIZE_LUMINOSITY = '';
export const SIZE_UNIFORM = 'uniform';
/** Colour mode '' is the temperature colour. */
export const COLOR_TEMPERATURE = '';

export interface BuiltinAttribute {
  id: string;
  label: MessageKey;
  type: Exclude<AttrType, 'color'>;
  /** Default scale (numeric) or category order (text). */
  scale: AttributeScale;
  categories?: string[];
  value(node: NodeData, i: number): AttrValue | undefined;
}

const SPEC_LETTERS = ['O', 'B', 'A', 'F', 'G', 'K', 'M', 'L', 'T', 'Y'];

/** log10(L/Lsun) of star i with the same fallbacks as the symbol size. */
function logLOf(node: NodeData, i: number): number {
  const l = node.logL[i];
  if (l !== UNKNOWN_I16) return l / 1000;
  const m = node.absMag[i];
  if (m !== UNKNOWN_I16) return (4.74 - m / 100) / 2.5;
  return node.flags[i] & Flag.BROWN_DWARF ? -4.5 : -1.5;
}

/** Known planets of star i; the Sun's eight are not in the exoplanet archive. */
export function planetsOf(node: NodeData, i: number): number {
  return node.flags[i] & Flag.SUN ? 8 : (node.planets.get(i) ?? 0);
}

/** Attributes every star has from the catalogue data; ids start with '@'. */
export const BUILTIN_ATTRIBUTES: BuiltinAttribute[] = [
  {
    id: '@planets',
    label: 'knownPlanets',
    type: 'number',
    scale: { min: 1, max: 8, palette: 'turbo' },
    value: (n, i) => planetsOf(n, i) || undefined,
  },
  {
    id: '@spec',
    label: 'spectralClass',
    type: 'text',
    // hues along the temperature sequence, more distinct than the natural star colours
    scale: {
      colors: {
        O: '#6f8cff', B: '#9db4ff', A: '#e8eeff', F: '#fff1b8', G: '#ffd84d', K: '#ffa040',
        M: '#ff5a4a', L: '#d93f6a', T: '#b45ad6', Y: '#7e6cf0', D: '#5ad6e0',
      },
    },
    categories: [...SPEC_LETTERS, 'D'],
    value: (n, i) => {
      if (n.flags[i] & Flag.WHITE_DWARF) return 'D';
      const c = spectralClassOf(n.spec[i]);
      return c && SPEC_LETTERS.includes(c[0]) ? c[0] : undefined;
    },
  },
  {
    id: '@teff',
    label: 'temperature',
    type: 'number',
    scale: { min: 2500, max: 12000, log: true, palette: 'turbo', reverse: true },
    value: (n, i) => n.teff[i] || undefined,
  },
  {
    id: '@lum',
    label: 'luminosity',
    type: 'number',
    scale: { min: 1e-3, max: 1e4, log: true, palette: 'plasma' },
    value: (n, i) => (n.flags[i] & Flag.SUN ? 1 : Math.pow(10, logLOf(n, i))),
  },
  {
    id: '@absmag',
    label: 'absMag',
    type: 'number',
    scale: { min: -5, max: 16, palette: 'plasma', reverse: true },
    value: (n, i) => (n.absMag[i] === UNKNOWN_I16 ? undefined : n.absMag[i] / 100),
  },
  {
    id: '@dist',
    label: 'distanceFromSun',
    type: 'number',
    scale: { min: 1, max: 1000, log: true, palette: 'viridis' },
    value: (n, i) => Math.hypot(n.positions[3 * i], n.positions[3 * i + 1], n.positions[3 * i + 2]),
  },
  {
    id: '@disterr',
    label: 'distUncertainty',
    type: 'number',
    scale: { min: 0, max: 20, palette: 'blueRed' },
    value: (n, i) => (n.distErr[i] === 255 ? undefined : n.distErr[i] / 2),
  },
];

export function builtin(id: string): BuiltinAttribute | undefined {
  return BUILTIN_ATTRIBUTES.find((b) => b.id === id);
}

// ------------------------------------------------------------------ palettes

export const PALETTES: Record<PaletteId, string[]> = {
  // the darkest ends of the usual maps are left out: they would vanish on the black sky
  turbo: ['#4662d7', '#36aaf9', '#1ae4b6', '#72fe5e', '#c8ef34', '#faba39', '#f66b19', '#d23105'],
  plasma: ['#7e03a8', '#a62098', '#c5407e', '#de6164', '#f2844b', '#fca636', '#fcce25', '#f0f921'],
  viridis: ['#3e4a89', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  blueRed: ['#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#fee090', '#fdae61', '#f46d43', '#d73027'],
};

/** Colours of text values, distinct on a dark background. */
export const CATEGORY_COLORS = [
  '#4e9bff', '#ff9f43', '#3ddc84', '#ff5c6c', '#b58cff', '#ffd84d',
  '#3fd3d3', '#ff7ac6', '#a6d96a', '#d9a066', '#8fa1ff', '#e8e8e8',
];

export const MISSING_COLOR = '#5d6375';

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1, 7), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const LUT_SIZE = 256;
const lutCache = new Map<PaletteId, Uint8Array>();

function paletteLut(id: PaletteId): Uint8Array {
  let lut = lutCache.get(id);
  if (lut) return lut;
  const stops = (PALETTES[id] ?? PALETTES.turbo).map(hexToRgb);
  lut = new Uint8Array(LUT_SIZE * 3);
  for (let k = 0; k < LUT_SIZE; k++) {
    const f = (k / (LUT_SIZE - 1)) * (stops.length - 1);
    const j = Math.min(Math.floor(f), stops.length - 2);
    const w = f - j;
    for (let c = 0; c < 3; c++) lut[3 * k + c] = Math.round(stops[j][c] * (1 - w) + stops[j + 1][c] * w);
  }
  lutCache.set(id, lut);
  return lut;
}

/** CSS linear-gradient of a palette (legend). */
export function paletteGradient(id: PaletteId, reverse = false): string {
  const stops = [...(PALETTES[id] ?? PALETTES.turbo)];
  if (reverse) stops.reverse();
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

// ------------------------------------------------------------------ attribute access

export interface AttributeInfo {
  id: string;
  type: AttrType;
  /** User attribute name, or the message key of a built-in one. */
  name: string;
  builtin: boolean;
}

export function attributeInfo(id: string, store: AttributeStore): AttributeInfo | null {
  const b = builtin(id);
  if (b) return { id, type: b.type, name: b.label, builtin: true };
  const d = store.def(id);
  return d ? { id, type: d.type, name: d.name, builtin: false } : null;
}

export type Getter = (node: NodeData, i: number) => AttrValue | undefined;

/** Reads an attribute of star i; whole-system attributes fall back to the system primary's value. */
export function valueGetter(id: string, store: AttributeStore): Getter | null {
  const b = builtin(id);
  if (b) return b.value;
  const def = store.def(id);
  if (!def) return null;
  const map = store.values(id);
  if (!def.system) return (node, i) => map.get(node, i);
  return (node, i) => {
    const own = map.get(node, i);
    if (own !== undefined) return own;
    const sid = node.systems.get(i);
    if (sid === undefined) return undefined;
    const primary = node.systemInfo.get(sid)?.primary;
    return primary ? map.getExact(primary) : undefined;
  };
}

/** Effective numeric scale: user settings over built-in defaults over the value range. */
export function numericScale(id: string, store: AttributeStore): Required<Pick<AttributeScale, 'min' | 'max'>> & AttributeScale {
  const base = builtin(id)?.scale ?? {};
  const user = store.scale(id);
  const sc: AttributeScale = { ...base, ...user };
  const log = !!sc.log;
  let { min, max } = sc;
  if (min === undefined || max === undefined) {
    const r = builtin(id) ? null : store.range(id, log);
    if (min === undefined) min = r ? r[0] : 0;
    if (max === undefined) max = r ? r[1] : 1;
  }
  if (log) {
    min = Math.max(min, 1e-12);
    max = Math.max(max, min * 1.0001);
  }
  return { palette: 'turbo', ...sc, min, max, log };
}

/** Position 0..1 of a value on a numeric scale. */
export function scalePosition(v: number, sc: { min: number; max: number; log?: boolean; reverse?: boolean }): number {
  let t: number;
  if (sc.log) {
    t = v <= 0 ? 0 : (Math.log(v) - Math.log(sc.min)) / (Math.log(sc.max) - Math.log(sc.min));
  } else {
    t = sc.max === sc.min ? 0.5 : (v - sc.min) / (sc.max - sc.min);
  }
  if (!Number.isFinite(t)) t = 0.5;
  t = Math.min(Math.max(t, 0), 1);
  return sc.reverse ? 1 - t : t;
}

/** Categories of a text attribute in legend order and their colours. */
export function categoryColors(id: string, store: AttributeStore): Map<string, string> {
  const b = builtin(id);
  const cats = b?.categories ?? store.distinct(id).sort((a, c) => a.localeCompare(c, undefined, { numeric: true }));
  const user = store.scale(id).colors ?? {};
  const preset = b?.scale.colors ?? {};
  const out = new Map<string, string>();
  cats.forEach((c, k) => out.set(c, user[c] ?? preset[c] ?? CATEGORY_COLORS[k % CATEGORY_COLORS.length]));
  return out;
}

// ------------------------------------------------------------------ plan

export interface StyleOptions {
  colorBy: string;
  sizeBy: string;
  missingStyle: MissingStyle;
}

/**
 * Colour and size rules for one restyle, compiled from the settings and the attribute store
 * (everything per star is a plain lookup).
 */
export interface StylePlan {
  /** Writes the colour of star i and returns true, or returns false if the star has no value. Null: temperature. */
  color: ((node: NodeData, i: number, out: Uint8Array, o: number) => boolean) | null;
  /** Symbol radius in ly, or undefined if the star has no value. Null: luminosity. */
  size: ((node: NodeData, i: number) => number | undefined) | null;
  missing: MissingStyle;
}

/** Symbol radius for a position 0..1 on a size scale (the Sun's luminosity symbol is 0.2 ly). */
export function sizeForPosition(t: number): number {
  return 0.2 * Math.pow(10, -0.4 + 1.4 * t);
}

/** Symbol radius of stars drawn 'grey and small' for lack of a value. */
export const MISSING_SIZE = 0.04;

export const UNIFORM_SIZE = 0.2;

export function buildPlan(opt: StyleOptions, store: AttributeStore): StylePlan {
  return { color: colorRule(opt.colorBy, store), size: sizeRule(opt.sizeBy, store), missing: opt.missingStyle };
}

function colorRule(id: string, store: AttributeStore): StylePlan['color'] {
  if (id === COLOR_TEMPERATURE) return null;
  const info = attributeInfo(id, store);
  const get = valueGetter(id, store);
  if (!info || !get) return null;
  if (info.type === 'number') {
    const sc = numericScale(id, store);
    const lut = paletteLut(sc.palette ?? 'turbo');
    return (node, i, out, o) => {
      const v = get(node, i);
      if (typeof v !== 'number') return false;
      const k = 3 * Math.round(scalePosition(v, sc) * (LUT_SIZE - 1));
      out[o] = lut[k];
      out[o + 1] = lut[k + 1];
      out[o + 2] = lut[k + 2];
      return true;
    };
  }
  const colors = new Map<string, [number, number, number]>();
  if (info.type === 'text') for (const [c, css] of categoryColors(id, store)) colors.set(c, hexToRgb(css));
  return (node, i, out, o) => {
    const v = get(node, i);
    if (v === undefined) return false;
    let rgb = colors.get(String(v));
    if (!rgb) {
      // colour attributes hold the colour itself
      if (info.type !== 'color') return false;
      rgb = hexToRgb(String(v));
      colors.set(String(v), rgb);
    }
    out[o] = rgb[0];
    out[o + 1] = rgb[1];
    out[o + 2] = rgb[2];
    return true;
  };
}

function sizeRule(id: string, store: AttributeStore): StylePlan['size'] {
  if (id === SIZE_LUMINOSITY) return null;
  if (id === SIZE_UNIFORM) return () => UNIFORM_SIZE;
  const info = attributeInfo(id, store);
  const get = valueGetter(id, store);
  if (!info || info.type !== 'number' || !get) return null;
  const sc = numericScale(id, store);
  return (node, i) => {
    const v = get(node, i);
    return typeof v === 'number' ? sizeForPosition(scalePosition(v, sc)) : undefined;
  };
}
