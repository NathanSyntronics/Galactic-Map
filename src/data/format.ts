// Decoder for the binary node files described in docs/DATA_FORMAT.md.

export const MAGIC = 0x4d4c4147; // "GALM"
export const FORMAT_VERSION = 1;
export const HEADER_BYTES = 64;

export const UNKNOWN_I16 = -32768;

export const Flag = {
  BROWN_DWARF: 1 << 0,
  WHITE_DWARF: 1 << 1,
  IN_SYSTEM: 1 << 2,
  SYSTEM_PRIMARY: 1 << 3,
  NAMED: 1 << 4,
  SRC_CENSUS20: 1 << 5,
  SRC_GCNS: 1 << 6,
  SRC_ATHYG: 1 << 7,
  SRC_HYG: 1 << 8,
  DIST_NO_PARALLAX: 1 << 9,
  SUN: 1 << 10,
  GIANT: 1 << 11,
  VARIABLE: 1 << 12,
  SRC_GAIA: 1 << 13,
} as const;

export const DesigCat = {
  STRING: 0,
  HIP: 1,
  HD: 2,
  TYC: 3,
  GAIA_DR3: 4,
  HR: 5,
} as const;

/** One named star entry: [localIndex, rank, nameEn, nameDe | null, altDesignations]. */
export type NameTuple = [number, number, string, string | null, string[]?];

export interface NodeExtra {
  d?: Record<string, string>;
  n?: NameTuple[];
  s?: Record<string, number>;
  S?: Record<string, [string | null, string | null, number, (string | null)?]>;
  t?: Record<string, string>;
  p?: Record<string, number>;
}

export interface SystemInfo {
  nameEn: string | null;
  nameDe: string | null;
  members: number;
  /** Primary designation of the system's primary star (the key of whole-system user data). */
  primary: string | null;
}

export interface StarName {
  rank: number;
  en: string;
  de: string | null;
  alt: string[];
}

/** Decoded content of one octree node. Positions are in the three.js world frame (see galactic.ts). */
export interface NodeData {
  path: string;
  count: number;
  /** World-frame positions (x, y, z) in light years, 3 * count. */
  positions: Float32Array;
  absMag: Int16Array;
  logL: Int16Array;
  teff: Uint16Array;
  flags: Uint16Array;
  distErr: Uint8Array;
  spec: Uint8Array;
  desigCat: Uint8Array;
  desigId: Uint32Array;
  names: Map<number, StarName>;
  designations: Map<number, string>;
  systems: Map<number, number>;
  systemInfo: Map<number, SystemInfo>;
  spectralTypes: Map<number, string>;
  /** Number of known exoplanets (NASA Exoplanet Archive) of the host stars in this node. */
  planets: Map<number, number>;
}

export class FormatError extends Error {}

const textDecoder = new TextDecoder('utf-8');

export function decodeNode(buffer: ArrayBuffer, path: string): NodeData {
  if (buffer.byteLength < HEADER_BYTES) throw new FormatError(`node ${path}: file too short`);
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) throw new FormatError(`node ${path}: bad magic 0x${magic.toString(16)}`);
  const version = view.getUint16(4, true);
  if (version !== FORMAT_VERSION) throw new FormatError(`node ${path}: unsupported version ${version}`);
  const count = view.getUint32(8, true);
  const off = (i: number) => view.getUint32(12 + 4 * i, true);
  const offPos = off(0);
  const offAbsMag = off(1);
  const offLogL = off(2);
  const offTeff = off(3);
  const offFlags = off(4);
  const offDistErr = off(5);
  const offSpec = off(6);
  const offDesigCat = off(7);
  const offDesigId = off(8);
  const offExtra = off(9);
  const lenExtra = off(10);

  const gal = new Float32Array(buffer, offPos, count * 3);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // galactic (X, Y, Z) -> world (x, y, z) = (X, Z, -Y)
    positions[3 * i] = gal[3 * i];
    positions[3 * i + 1] = gal[3 * i + 2];
    positions[3 * i + 2] = -gal[3 * i + 1];
  }

  let extra: NodeExtra = {};
  if (lenExtra > 0) {
    const bytes = new Uint8Array(buffer, offExtra, lenExtra);
    extra = JSON.parse(textDecoder.decode(bytes)) as NodeExtra;
  }

  const names = new Map<number, StarName>();
  for (const [idx, rank, en, de, alt] of extra.n ?? []) {
    names.set(idx, { rank, en, de, alt: alt ?? [] });
  }
  const toMap = <T>(rec: Record<string, T> | undefined) => {
    const m = new Map<number, T>();
    if (rec) for (const k of Object.keys(rec)) m.set(Number(k), rec[k]);
    return m;
  };

  return {
    path,
    count,
    positions,
    absMag: new Int16Array(buffer, offAbsMag, count),
    logL: new Int16Array(buffer, offLogL, count),
    teff: new Uint16Array(buffer, offTeff, count),
    flags: new Uint16Array(buffer, offFlags, count),
    distErr: new Uint8Array(buffer, offDistErr, count),
    spec: new Uint8Array(buffer, offSpec, count),
    desigCat: new Uint8Array(buffer, offDesigCat, count),
    desigId: new Uint32Array(buffer, offDesigId, count * 2),
    names,
    designations: toMap(extra.d),
    systems: toMap(extra.s),
    systemInfo: new Map(
      Object.entries(extra.S ?? {}).map(([k, v]) => [Number(k), { nameEn: v[0], nameDe: v[1], members: v[2], primary: v[3] ?? null }]),
    ),
    spectralTypes: toMap(extra.t),
    planets: toMap(extra.p),
  };
}

/** Primary catalogue designation of star i (e.g. "HIP 70890", "Gaia DR3 5853498713190525696"). */
export function designationOf(node: NodeData, i: number): string {
  const cat = node.desigCat[i];
  const lo = node.desigId[2 * i];
  const hi = node.desigId[2 * i + 1];
  switch (cat) {
    case DesigCat.HIP:
      return `HIP ${lo}`;
    case DesigCat.HD:
      return `HD ${lo}`;
    case DesigCat.TYC:
      return `TYC ${lo & 0xffff}-${lo >>> 16}-${hi}`;
    case DesigCat.GAIA_DR3:
      return `Gaia DR3 ${(BigInt(hi) << 32n) | BigInt(lo)}`;
    case DesigCat.HR:
      return `HR ${lo}`;
    default:
      return node.designations.get(i) ?? `#${node.path}:${i}`;
  }
}

const SPEC_CLASSES = ['O', 'B', 'A', 'F', 'G', 'K', 'M', 'L', 'T', 'Y', 'D', '?'];

/** Spectral class letter + subclass from the `spec` code, or null if unknown. */
export function spectralClassOf(code: number): string | null {
  if (code === 255) return null;
  const cls = Math.floor(code / 10);
  if (cls >= SPEC_CLASSES.length) return null;
  if (cls === 11) return SPEC_CLASSES[cls];
  return `${SPEC_CLASSES[cls]}${code % 10}`;
}

/** Relative distance uncertainty in percent, or null if unknown. */
export function distErrPercent(code: number): number | null {
  return code === 255 ? null : code / 2;
}
