import { Vector3 } from 'three';

// Galactic heliocentric frame (X -> Galactic Centre, Y -> rotation, Z -> North Galactic Pole)
// is mapped onto the y-up three.js world as world = (X, Z, -Y).

export const LY_PER_PC = 3.261563777;

export function galacticToWorld(x: number, y: number, z: number, out = new Vector3()): Vector3 {
  return out.set(x, z, -y);
}

export function worldToGalactic(v: Vector3): [number, number, number] {
  return [v.x, -v.z, v.y];
}

/** Galactic longitude/latitude in degrees of a world-frame position relative to the Sun. */
export function galacticLB(v: Vector3): { l: number; b: number } {
  const [x, y, z] = worldToGalactic(v);
  const r = Math.hypot(x, y, z);
  if (r === 0) return { l: 0, b: 0 };
  let l = (Math.atan2(y, x) * 180) / Math.PI;
  if (l < 0) l += 360;
  const b = (Math.asin(z / r) * 180) / Math.PI;
  return { l, b };
}
