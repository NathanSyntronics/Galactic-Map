/**
 * The spacecraft leaving the Solar System (docs/PROBES.md): probes.json, written by
 * pipeline/galmap/probes.py from JPL Horizons. Positions for a date are interpolated linearly in
 * time between the points of the trajectory and continue in a straight line with the last velocity.
 */
import { Vector3 } from 'three';
import { AU_PER_LY } from './planets';
import type { SourceInfo } from './octree';

export interface ProbeFile {
  format: string;
  version: number;
  probes: { key: string; name: string; launch: string; t: number[]; p: [number, number, number][]; v: [number, number, number] }[];
  sources: SourceInfo[];
}

export interface Probe {
  key: string;
  name: string;
  /** Launch date (UTC, yyyy-mm-dd). */
  launch: string;
  /** Julian dates of the trajectory points. */
  t: Float64Array;
  /** World positions of the points (ly; the Sun at the origin), 3 per point. */
  p: Float64Array;
  /** World velocity after the last point (ly per day). */
  v: Vector3;
}

export interface ProbeCatalogue {
  probes: Probe[];
  sources: SourceInfo[];
}

export function decodeProbes(file: ProbeFile): ProbeCatalogue {
  const probes = file.probes.map((r) => {
    const p = new Float64Array(3 * r.p.length);
    // galactic (x, y, z) AU -> world (x, z, -y) ly, as for the stars
    r.p.forEach(([x, y, z], i) => p.set([x / AU_PER_LY, z / AU_PER_LY, -y / AU_PER_LY], 3 * i));
    return {
      key: r.key,
      name: r.name,
      launch: r.launch,
      t: Float64Array.from(r.t),
      p,
      v: new Vector3(r.v[0], r.v[2], -r.v[1]).divideScalar(AU_PER_LY),
    };
  });
  return { probes, sources: file.sources ?? [] };
}

/** The index of the last trajectory point at or before a date (-1 before the first). */
export function probeIndex(probe: Probe, jd: number): number {
  const t = probe.t;
  if (jd < t[0]) return -1;
  let lo = 0;
  let hi = t.length - 1;
  if (jd >= t[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= jd) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The probe's position at a date (world, ly), or null before its trajectory begins. */
export function probePosition(probe: Probe, jd: number, out = new Vector3()): Vector3 | null {
  const i = probeIndex(probe, jd);
  if (i < 0) return null;
  const p = probe.p;
  const n = probe.t.length;
  if (i === n - 1) return out.set(p[3 * i], p[3 * i + 1], p[3 * i + 2]).addScaledVector(probe.v, jd - probe.t[i]);
  const f = (jd - probe.t[i]) / (probe.t[i + 1] - probe.t[i]);
  return out.set(
    p[3 * i] + f * (p[3 * i + 3] - p[3 * i]),
    p[3 * i + 1] + f * (p[3 * i + 4] - p[3 * i + 1]),
    p[3 * i + 2] + f * (p[3 * i + 5] - p[3 * i + 2]),
  );
}

/** The probe's speed relative to the Sun at a date (km/s), from its motion over a day. */
export function probeSpeed(probe: Probe, jd: number): number {
  const a = probePosition(probe, jd - 0.5);
  const b = probePosition(probe, jd + 0.5);
  if (!a || !b) return NaN;
  return (b.distanceTo(a) * 9.4607304725808e12) / 86400;
}

export async function loadProbes(baseUrl: string): Promise<ProbeCatalogue> {
  const res = await fetch(`${baseUrl}probes.json`);
  if (!res.ok) throw new Error(`probes.json: HTTP ${res.status}`);
  return decodeProbes((await res.json()) as ProbeFile);
}
