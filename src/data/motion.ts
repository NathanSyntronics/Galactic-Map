/**
 * Star motion (docs/DATA_FORMAT.md, "Velocities"): every star moves in a straight line with its
 * heliocentric space velocity, from the positions' epoch (J2016.0, Gaia DR3) to the date the map
 * is drawn for. The Sun stays at the origin: the map is heliocentric.
 */
import type { Vector3 } from 'three';

/** km/s in light years per Julian year. */
export const LY_PER_YR_PER_KMS = 1.0227121650537077e-6 * 3.261563777;
/** The tiles store km/s times this (unless the manifest says otherwise). */
export const DEFAULT_VELOCITY_SCALE = 50;
/** Julian date of J2016.0, the epoch of the positions. */
export const EPOCH_JD = 2451545.0 + 16 * 365.25;

/** Julian years since the positions' epoch at a Julian date. */
export function yearsSinceEpoch(jd: number): number {
  return (jd - EPOCH_JD) / 365.25;
}

/** World-frame velocity (ly/yr, float32 like the shader's) of a stored galactic (vx, vy, vz) in km/s × scale; null if unknown. */
export function worldVelocity(vx: number, vy: number, vz: number, scale = DEFAULT_VELOCITY_SCALE): [number, number, number] | null {
  if (vx === -32768) return null;
  const k = LY_PER_YR_PER_KMS / scale;
  // galactic (X, Y, Z) -> world (X, Z, -Y)
  return [Math.fround(vx * k), Math.fround(vz * k), Math.fround(-vy * k) || 0];
}

/** The parts of a star node that move. */
export interface Moving {
  count: number;
  /** Current positions (moved to `movedTo`), 3 per star. */
  positions: Float32Array;
  /** Positions at the epoch. */
  base: Float32Array;
  /** World-frame velocities (ly/yr), 3 per star; null when the node has none. */
  vel: Float32Array | null;
  /** Largest speed in the node (ly/yr). */
  vmax: number;
  /** Years since the epoch the positions are moved to. */
  movedTo: number;
}

/** Moves a node's positions to `dt` years after the epoch (float32, like the data). */
export function moveTo(d: Moving, dt: number): void {
  d.movedTo = dt;
  const v = d.vel;
  if (!v) return;
  const p = d.positions;
  const b = d.base;
  for (let k = 0; k < 3 * d.count; k++) p[k] = b[k] + v[k] * dt;
}

/** Position of star i at `dt` years after the epoch, in double precision (labels, planets, close views). */
export function starPosition(d: Moving, i: number, dt: number, out: Vector3): Vector3 {
  const b = d.base;
  const v = d.vel;
  if (!v) return out.set(b[3 * i], b[3 * i + 1], b[3 * i + 2]);
  return out.set(b[3 * i] + v[3 * i] * dt, b[3 * i + 1] + v[3 * i + 1] * dt, b[3 * i + 2] + v[3 * i + 2] * dt);
}
