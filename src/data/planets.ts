/**
 * Planets (docs/PLANETS.md): planets.json, written by pipeline/galmap/planets.py. Every orbit is
 * given by two unit vectors (P towards the periapsis, Q 90 degrees ahead in the orbital plane),
 * converted here to the world frame of the stars, and the mean anomaly at J2000.
 */
import { Vector3 } from 'three';
import { worldVelocity } from './motion';
import type { SourceInfo } from './octree';

export const AU_PER_LY = 63241.077;
/** Earth's equatorial radius in light years. */
export const EARTH_RADIUS_LY = 6378.137 / 9.4607304725808e12;
export const J2000 = 2451545.0;

export const PlanetFlag = {
  RADIUS_ESTIMATED: 1,
  INCLINATION_ASSUMED: 2,
  PHASE_ASSUMED: 4,
  ECCENTRICITY_ASSUMED: 8,
  SOLAR_SYSTEM: 16,
  CIRCUMBINARY: 32,
  /** Semi-major axis within the optimistic habitable zone of the star. */
  HABITABLE_ZONE: 64,
  /** ... within the conservative one. */
  HABITABLE_ZONE_CONSERVATIVE: 128,
  /** Potentially habitable: in the optimistic zone and small (radius up to 2.5 R⊕, or mass up to 10 M⊕). */
  POTENTIALLY_HABITABLE: 256,
  /** A moon (of the planet `parent`). */
  MOON: 512,
} as const;

/** [host, name, German name, a (AU), e, period (d), M0 (rad), P, Q, radius (R⊕), mass (M⊕), Teq (K), method, year, flags, inclination (deg)] */
type PlanetRow = [
  number, string, string | null, number, number, number, number, [number, number, number], [number, number, number],
  number | null, number | null, number | null, number, number | null, number, number | null, (number | null)?,
];

export interface PlanetFile {
  format: string;
  version: number;
  epoch: number;
  methods: string[];
  /**
   * [node path, index in the node, archive name, galactic position (ly), number of planets,
   * habitable zone (AU) or null, galactic velocity as the star tile stores it (km/s × 50) or null]
   */
  hosts: [string, number, string, [number, number, number], number, (HabitableZone | null)?, ([number, number, number] | null)?][];
  planets: PlanetRow[];
  sources: SourceInfo[];
}

/**
 * The habitable zone of a star (Kopparapu et al. 2013), AU: optimistic inner edge (recent
 * Venus), conservative inner (runaway greenhouse), conservative outer (maximum greenhouse),
 * optimistic outer (early Mars).
 */
export type HabitableZone = [number, number, number, number];

export interface PlanetHost {
  /** Star key in the map ("path:index"). */
  key: string;
  path: string;
  index: number;
  /** Name in the NASA Exoplanet Archive (Sun for the Solar System). */
  name: string;
  /** World position of the star (ly) at the date drawn (see moveHosts), exactly as the star is drawn. */
  pos: Vector3;
  /** Its position at the epoch (J2016.0) and its velocity (ly/yr, as the star's; null: unknown). */
  base: Vector3;
  vel: Vector3 | null;
  /** Indices of its planets, from the innermost. */
  planets: number[];
  /** Largest apoapsis of its planets (ly). */
  reach: number;
  /** Its habitable zone (null: the star's temperature or luminosity is unknown). */
  hz: HabitableZone | null;
  /** It has a potentially habitable planet. */
  habitable: boolean;
}

export interface Planet {
  host: number;
  name: string;
  nameDe: string | null;
  /** Semi-major axis (AU). */
  a: number;
  e: number;
  /** Orbital period (days). */
  period: number;
  /** Mean anomaly at J2000 (rad). */
  m0: number;
  /** World-frame unit vectors of the orbit. */
  P: Vector3;
  Q: Vector3;
  /** Radius (Earth radii; NaN unknown). */
  radius: number;
  mass: number;
  /** Equilibrium temperature (K; NaN unknown). */
  eqt: number;
  method: string;
  year: number | null;
  flags: number;
  /** Inclination (deg): to the sky plane for exoplanets, to the ecliptic for the Solar System. */
  incl: number;
  /** A moon's planet (index; null for a planet): its orbit is around that planet. */
  parent: number | null;
  /** A planet's moons (indices), from the innermost. */
  moons: number[];
}

export interface PlanetCatalogue {
  hosts: PlanetHost[];
  planets: Planet[];
  /** Host by star key. */
  byStar: Map<string, number>;
  sources: SourceInfo[];
}

const world = (v: [number, number, number]) => new Vector3(v[0], v[2], -v[1]);
const num = (v: number | null) => (v === null ? NaN : v);

export function decodePlanets(file: PlanetFile): PlanetCatalogue {
  const hosts: PlanetHost[] = file.hosts.map(([path, index, name, pos, , hz, vel]) => {
    const base = new Vector3(Math.fround(pos[0]), Math.fround(pos[2]), Math.fround(-pos[1]));
    const v = Array.isArray(vel) && vel.length === 3 ? worldVelocity(vel[0], vel[1], vel[2]) : null;
    return {
      key: `${path}:${index}`,
      path,
      index,
      name,
      pos: base.clone(),
      base,
      vel: v ? new Vector3(v[0], v[1], v[2]) : null,
      planets: [],
      reach: 0,
      hz: Array.isArray(hz) && hz.length === 4 && hz.every(Number.isFinite) ? hz : null,
      habitable: false,
    };
  });
  const planets: Planet[] = file.planets.map((r, i) => {
    const [host, name, nameDe, a, e, period, m0, P, Q, radius, mass, eqt, method, year, flags, incl, parent] = r;
    const h = hosts[host];
    const isMoon = typeof parent === 'number';
    // a moon is not one of its star's planets: it belongs to its planet (below)
    if (!isMoon) {
      h.planets.push(i);
      h.reach = Math.max(h.reach, (a * (1 + e)) / AU_PER_LY);
    }
    if (flags & PlanetFlag.POTENTIALLY_HABITABLE) h.habitable = true;
    return {
      host, name, nameDe, a, e, period, m0, P: world(P), Q: world(Q), radius: num(radius), mass: num(mass), eqt: num(eqt),
      method: file.methods[method] ?? '', year, flags, incl: num(incl), parent: isMoon ? parent : null, moons: [],
    };
  });
  planets.forEach((p, i) => {
    if (p.parent !== null && planets[p.parent]) planets[p.parent].moons.push(i);
  });
  for (const p of planets) p.moons.sort((x, y) => planets[x].a - planets[y].a);
  return { hosts, planets, byStar: new Map(hosts.map((h, i) => [h.key, i])), sources: file.sources ?? [] };
}

/** Moves the planet hosts to `dt` years after the epoch (in place: everything keeps the same vectors). */
export function moveHosts(cat: PlanetCatalogue, dt: number): void {
  for (const h of cat.hosts) {
    if (h.vel) h.pos.copy(h.base).addScaledVector(h.vel, dt);
  }
}

/** Eccentric anomaly of a mean anomaly (Newton's method). */
export function eccentricAnomaly(m: number, e: number): number {
  const mm = ((m % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let E = e < 0.8 ? mm : Math.PI;
  for (let k = 0; k < 30; k++) {
    const d = (E - e * Math.sin(E) - mm) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

/** Position of a planet relative to its star (world frame, ly) at a Julian date. */
/** A planet's (or moon's) offset from its star at a date (a moon: its planet's plus its own). */
export function bodyOffset(cat: PlanetCatalogue, i: number, jd: number, out = new Vector3()): Vector3 {
  const p = cat.planets[i];
  planetOffset(p, jd, out);
  if (p.parent !== null) out.add(planetOffset(cat.planets[p.parent], jd, tmpOffset));
  return out;
}
const tmpOffset = new Vector3();

/** A planet's (or moon's) eccentric anomaly at a date. */
export function planetAnomaly(p: Planet, jd: number): number {
  return eccentricAnomaly(p.m0 + (2 * Math.PI * (jd - J2000)) / p.period, p.e);
}

/** A planet's (a moon's: around its planet) offset at a date, world frame, ly. */
export function planetOffset(p: Planet, jd: number, out = new Vector3()): Vector3 {
  return orbitPoint(p, planetAnomaly(p, jd), out);
}

/** How much denser than even the points of a drawn orbit lie at the planet (see orbitSamples). */
export const ORBIT_CROWDING = 0.95;

/**
 * Points of a planet's orbit for a line through them (3 per point, relative to the star), the
 * first one exactly at eccentric anomaly E0 (the planet) and the others crowded around it: the
 * line is a polygon, and close up its corners would lie up to a/40,000 off the ellipse (17,000 km
 * for Mars), the planet moving off its line and back. Eccentric anomaly E0 + u − c·sin u for even
 * steps of u: the steps at the planet (1 − c) times, on the far side (1 + c) times the even step.
 */
export function orbitSamples(p: Planet, E0: number, out: Float32Array, v = new Vector3()): Float32Array {
  const n = out.length / 3;
  for (let k = 0; k < n; k++) {
    const u = (2 * Math.PI * k) / n;
    orbitPoint(p, E0 + u - ORBIT_CROWDING * Math.sin(u), v);
    out[3 * k] = v.x;
    out[3 * k + 1] = v.y;
    out[3 * k + 2] = v.z;
  }
  return out;
}

/**
 * Whether an orbit drawn by orbitSamples around E0 must be drawn again for a planet at E: when the
 * planet would lie more than about half a pixel (`pixel`: ly per pixel at the planet) off its line.
 */
export function orbitStale(p: Planet, E0: number, E: number, points: number, pixel: number): boolean {
  let dE = Math.abs(E - E0) % (2 * Math.PI);
  if (dE > Math.PI) dE = 2 * Math.PI - dE;
  const step = ((1 - ORBIT_CROWDING) * 2 * Math.PI) / points;
  return (p.a / AU_PER_LY) * dE * step > 0.5 * pixel;
}

/** The point of a planet's orbit at eccentric anomaly E (world frame, ly, relative to the star). */
export function orbitPoint(p: Planet, E: number, out = new Vector3()): Vector3 {
  const a = p.a / AU_PER_LY;
  const x = a * (Math.cos(E) - p.e);
  const y = a * Math.sqrt(1 - p.e * p.e) * Math.sin(E);
  return out.copy(p.P).multiplyScalar(x).addScaledVector(p.Q, y);
}

/** Julian date of a time (ms since 1970). */
export function julianDate(ms: number): number {
  return ms / 86_400_000 + 2440587.5;
}

/** The planet's kind, by its radius: rocky, mini-Neptune, ice giant, gas giant (unknown: by mass). */
export function planetKind(p: Planet): 'rocky' | 'subNeptune' | 'iceGiant' | 'gasGiant' {
  const r = Number.isFinite(p.radius) ? p.radius : Number.isFinite(p.mass) ? (p.mass < 2 ? 1 : p.mass < 10 ? 2.5 : p.mass < 50 ? 4.5 : 11) : 4.5;
  if (r < 1.6) return 'rocky';
  if (r < 4) return 'subNeptune';
  if (r < 8) return 'iceGiant';
  return 'gasGiant';
}

/** Display name in a language. */
export function planetName(p: Planet, lang: 'en' | 'de'): string {
  return (lang === 'de' && p.nameDe) || p.name;
}

export async function loadPlanets(baseUrl: string, fetchFn: typeof fetch = fetch): Promise<PlanetCatalogue> {
  const res = await fetchFn(`${baseUrl}planets.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for planets.json`);
  const file = (await res.json()) as PlanetFile;
  if (file.format !== 'galmap-planets') throw new Error('not a planet file');
  return decodePlanets(file);
}
