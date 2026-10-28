/**
 * Galaxies (docs/GALAXIES.md): galaxies.bin (36-byte records) and galaxies.json (names, sources).
 * Positions and directions are converted to the world frame of the stars here.
 */
import type { SourceInfo } from './octree';

export const GALAXY_RECORD_BYTES = 36;

export const enum GalaxyClass {
  Spiral = 0,
  Lenticular = 1,
  Elliptical = 2,
  Irregular = 3,
  Spheroidal = 4,
  MilkyWay = 5,
}

export const GalaxyFlag = {
  LVDB: 1,
  UNGC: 2,
  CF4: 4,
  LOCAL_GROUP: 8,
  NAMED: 16,
  MODEL: 32,
} as const;

/** [index, English name, German name or null, rank, designation, other designations?] */
export type GalaxyNameRow = [number, string | null, string | null, number, string, string[]?];

export interface GalaxyMeta {
  format: string;
  version: number;
  count: number;
  recordBytes: number;
  /** File of the records, relative to galaxies.json (default galaxies.bin). */
  data?: string;
  classes: string[];
  methods: string[];
  names: GalaxyNameRow[];
  sources: SourceInfo[];
  stats?: Record<string, number>;
}

export interface GalaxyName {
  en: string | null;
  de: string | null;
  /** 0 common name, 1 Messier, 2 NGC, 3 IC, 4 other catalogue or LVDB / UNGC name. */
  rank: number;
  designation: string;
  alt: string[];
}

export interface GalaxyCatalogue {
  count: number;
  /** World-frame positions (ly), 3 per galaxy (double precision for subtracting an origin). */
  pos: Float64Array;
  /** Diameter in ly. */
  diam: Float32Array;
  /** World-frame unit vectors: major axis and disk normal, 3 per galaxy. */
  major: Float32Array;
  normal: Float32Array;
  /** Axis ratio (minor / major). */
  q: Float32Array;
  cls: Uint8Array;
  /** log10 L / L☉ (NaN: unknown). */
  logL: Float32Array;
  /** Relative distance error (NaN: unknown). */
  distErr: Float32Array;
  method: Uint8Array;
  flags: Uint8Array;
  pgc: Uint32Array;
  names: Map<number, GalaxyName>;
  methods: string[];
  sources: SourceInfo[];
}

/** Decodes the records; galactic (x, y, z) become world (x, z, -y) as for the stars. */
export function decodeGalaxies(bin: ArrayBuffer, meta: GalaxyMeta): GalaxyCatalogue {
  const rb = meta.recordBytes || GALAXY_RECORD_BYTES;
  const n = Math.min(meta.count, Math.floor(bin.byteLength / rb));
  const v = new DataView(bin);
  const cat: GalaxyCatalogue = {
    count: n,
    pos: new Float64Array(3 * n),
    diam: new Float32Array(n),
    major: new Float32Array(3 * n),
    normal: new Float32Array(3 * n),
    q: new Float32Array(n),
    cls: new Uint8Array(n),
    logL: new Float32Array(n),
    distErr: new Float32Array(n),
    method: new Uint8Array(n),
    flags: new Uint8Array(n),
    pgc: new Uint32Array(n),
    names: new Map(),
    methods: meta.methods ?? [],
    sources: meta.sources ?? [],
  };
  const unit = (o: number, out: Float32Array, k: number) => {
    let x = v.getInt8(o) / 127;
    let y = v.getInt8(o + 1) / 127;
    let z = v.getInt8(o + 2) / 127;
    const len = Math.hypot(x, y, z) || 1;
    x /= len;
    y /= len;
    z /= len;
    out[3 * k] = x;
    out[3 * k + 1] = z;
    out[3 * k + 2] = -y;
  };
  for (let k = 0; k < n; k++) {
    const o = k * rb;
    const gx = v.getFloat32(o, true);
    const gy = v.getFloat32(o + 4, true);
    const gz = v.getFloat32(o + 8, true);
    cat.pos[3 * k] = gx;
    cat.pos[3 * k + 1] = gz;
    cat.pos[3 * k + 2] = -gy;
    cat.diam[k] = v.getFloat32(o + 12, true);
    unit(o + 16, cat.major, k);
    unit(o + 19, cat.normal, k);
    cat.q[k] = v.getUint8(o + 22) / 255;
    cat.cls[k] = v.getUint8(o + 23);
    const l = v.getInt16(o + 24, true);
    cat.logL[k] = l === -32768 ? NaN : l / 1000;
    const e = v.getUint8(o + 26);
    cat.distErr[k] = e === 255 ? NaN : e / 200;
    cat.method[k] = v.getUint8(o + 27);
    cat.flags[k] = v.getUint8(o + 28);
    cat.pgc[k] = v.getUint32(o + 32, true);
  }
  for (const row of meta.names ?? []) {
    const [i, en, de, rank, designation, alt] = row;
    if (i >= 0 && i < n) cat.names.set(i, { en, de, rank, designation, alt: alt ?? [] });
  }
  return cat;
}

/** The galaxy's primary designation: its name row's, else its PGC number. */
export function galaxyDesignation(cat: GalaxyCatalogue, i: number): string {
  return cat.names.get(i)?.designation ?? `PGC ${cat.pgc[i]}`;
}

/** Display name in a language (German name where there is one). */
export function galaxyName(cat: GalaxyCatalogue, i: number, lang: 'en' | 'de'): string {
  const n = cat.names.get(i);
  if (!n) return `PGC ${cat.pgc[i]}`;
  return (lang === 'de' && n.de) || n.en || n.designation;
}

/** Name rank for labels and the search: 0 common name … 4 other names, 99 PGC number only. */
export function galaxyRank(cat: GalaxyCatalogue, i: number): number {
  return cat.names.get(i)?.rank ?? 99;
}

/** Distance from the Sun (ly). */
export function galaxyDistance(cat: GalaxyCatalogue, i: number): number {
  return Math.hypot(cat.pos[3 * i], cat.pos[3 * i + 1], cat.pos[3 * i + 2]);
}

/** Loads galaxies.json and the records it names. */
export async function loadGalaxies(baseUrl: string, fetchFn: typeof fetch = fetch): Promise<GalaxyCatalogue> {
  const metaRes = await fetchFn(`${baseUrl}galaxies.json`);
  if (!metaRes.ok) throw new Error(`HTTP ${metaRes.status} for galaxies.json`);
  const meta = (await metaRes.json()) as GalaxyMeta;
  if (meta.format !== 'galmap-galaxies') throw new Error('not a galaxy file');
  const file = meta.data ?? 'galaxies.bin';
  const binRes = await fetchFn(`${baseUrl}${file}`);
  if (!binRes.ok) throw new Error(`HTTP ${binRes.status} for ${file}`);
  return decodeGalaxies(await binRes.arrayBuffer(), meta);
}
