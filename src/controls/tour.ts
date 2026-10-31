import { CatmullRomCurve3, Vector3 } from 'three';

/** Seconds per star of a route flyby (the choices of the route box). */
export const FLYBY_STEPS = [0.5, 1, 2.5, 5] as const;

/** Elevation of the camera above the direction of travel while it follows the route (radians). */
const ELEVATION = (22 * Math.PI) / 180;
const UP = new Vector3(0, 1, 0);

/**
 * A flight along a route: a smooth curve through its waypoints (centripetal Catmull-Rom, no
 * loops between uneven jumps), one waypoint per `step` seconds. It starts and stops smoothly:
 * it accelerates over the first 0.6 step and brakes over the last 0.6 jump.
 */
export class Tour {
  readonly segments: number;
  private readonly curve: CatmullRomCurve3 | null;
  /** Progress in jumps: waypoint k at k. */
  s: number;
  private elapsed = 0;
  private readonly lastDir = new Vector3(0, 0, -1);

  constructor(
    readonly points: Vector3[],
    /** Seconds per waypoint (may change during the flight). */
    public step: number,
    from = 0,
  ) {
    this.segments = Math.max(points.length - 1, 0);
    this.curve = points.length >= 2 ? new CatmullRomCurve3(points, false, 'centripetal') : null;
    this.s = Math.min(Math.max(from, 0), this.segments);
    this.direction(this.s, this.lastDir);
  }

  get done(): boolean {
    return this.s >= this.segments;
  }

  /** The waypoint the flight is nearest to. */
  get index(): number {
    return Math.round(this.s);
  }

  /** Advances the flight by dt seconds. */
  advance(dt: number): void {
    if (this.done) return;
    this.elapsed += dt;
    const vmax = 1 / Math.max(this.step, 0.05);
    const rem = this.segments - this.s;
    const v = vmax * Math.min(1, Math.max(this.elapsed / (0.6 * this.step), 0.05), Math.sqrt(rem / 0.6));
    this.s = Math.min(this.segments, this.s + v * dt);
    if (this.segments - this.s < 1e-4) this.s = this.segments;
  }

  /** Position on the route at progress s (jumps). */
  position(s: number, out = new Vector3()): Vector3 {
    if (!this.curve) return out.copy(this.points[0] ?? out.set(0, 0, 0));
    return this.curve.getPoint(Math.min(Math.max(s, 0), this.segments) / this.segments, out);
  }

  /**
   * Direction of travel at progress s, over the next jumps (from one back to four ahead), so that
   * the view turns gently where the route zigzags.
   */
  direction(s: number, out = new Vector3()): Vector3 {
    if (!this.curve) return out.copy(this.lastDir);
    const a = this.position(Math.max(s - 1, 0));
    const b = this.position(Math.min(s + 4, this.segments));
    out.subVectors(b, a);
    if (out.lengthSq() < 1e-18) return out.copy(this.lastDir);
    out.normalize();
    this.lastDir.copy(out);
    return out;
  }

  /** The view direction (view centre -> camera) that follows the route: behind and a little above. */
  viewDirection(s: number, out = new Vector3()): Vector3 {
    return cameraBehind(this.direction(s), out);
  }
}

/** The direction from the view centre to a camera behind it and a little above, looking along `travel`. */
export function cameraBehind(travel: Vector3, out = new Vector3()): Vector3 {
  out.copy(travel).multiplyScalar(-Math.cos(ELEVATION)).addScaledVector(UP, Math.sin(ELEVATION));
  // not straight up or down (the orbit controls turn about the up axis)
  out.y = Math.min(Math.max(out.y, -0.97), 0.97);
  const h = Math.hypot(out.x, out.z);
  const k = h > 1e-9 ? Math.sqrt(1 - out.y * out.y) / h : 0;
  if (k === 0) out.set(Math.sqrt(1 - out.y * out.y), out.y, 0);
  else {
    out.x *= k;
    out.z *= k;
  }
  return out;
}

/**
 * Where a flyby starts: at the waypoint nearest to the view centre if the view is close to the
 * route there (within two typical jumps, zoomed in to at most 20 of them) and not at its end;
 * otherwise at the start.
 */
export function tourStart(points: Vector3[], centre: Vector3, distance: number, typicalJump: number): number {
  if (points.length < 2 || distance > 20 * typicalJump) return 0;
  let best = 0;
  let bestD = Infinity;
  points.forEach((p, k) => {
    const d = p.distanceTo(centre);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  });
  return bestD <= 2 * typicalJump && best < points.length - 1 ? best : 0;
}

/** The median of the jumps of a route (0 without any). */
export function medianJump(jumps: number[]): number {
  const j = jumps.filter((x) => x > 0).sort((a, b) => a - b);
  if (!j.length) return 0;
  const m = j.length >> 1;
  return j.length % 2 ? j[m] : (j[m - 1] + j[m]) / 2;
}
