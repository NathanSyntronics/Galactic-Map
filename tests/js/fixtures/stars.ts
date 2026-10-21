import { DesigCat, Flag, UNKNOWN_I16, type NodeData } from '../../../src/data/format';
import type { PlaceSource } from '../../../src/network/places';

export interface Star {
  x: number;
  y?: number;
  z?: number;
  /** log10 L/Lsun. */
  logL: number;
  system?: number;
  hidden?: boolean;
}

/** A node with the given stars; systems get one systemInfo entry each. */
export function source(path: string, stars: Star[]): PlaceSource {
  const n = stars.length;
  const data: NodeData = {
    path,
    count: n,
    positions: new Float32Array(stars.flatMap((s) => [s.x, s.y ?? 0, s.z ?? 0])),
    absMag: new Int16Array(n).fill(UNKNOWN_I16),
    logL: new Int16Array(stars.map((s) => Math.round(s.logL * 1000))),
    teff: new Uint16Array(n),
    flags: new Uint16Array(stars.map((s) => (s.system !== undefined ? Flag.IN_SYSTEM : 0))),
    distErr: new Uint8Array(n),
    spec: new Uint8Array(n).fill(255),
    desigCat: new Uint8Array(n).fill(DesigCat.HIP),
    desigId: new Uint32Array(2 * n),
    names: new Map(),
    designations: new Map(),
    systems: new Map(stars.flatMap((s, i) => (s.system !== undefined ? [[i, s.system] as [number, number]] : []))),
    systemInfo: new Map(
      [...new Set(stars.flatMap((s) => (s.system !== undefined ? [s.system] : [])))].map((id) => [
        id,
        { nameEn: `System ${id}`, nameDe: null, members: 2, primary: null },
      ]),
    ),
    spectralTypes: new Map(),
    planets: new Map(),
  };
  return {
    data,
    sizes: new Float32Array(stars.map((s) => (s.hidden ? 0 : 0.2))),
    colors: new Uint8Array(3 * n).fill(200),
  };
}
