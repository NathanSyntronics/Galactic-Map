/**
 * Planets (docs/PLANETS.md): planets.json, written by pipeline/galmap/planets.py. Every orbit is
 * given by two unit vectors (P towards the periapsis, Q 90 degrees ahead in the orbital plane),
 * converted here to the world frame of the stars, and the mean anomaly at J2000.
 */
import { Vector3 } from 'three';
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
} as const;

/** [host, name, German name, a (AU), e, period (d), M0 (rad), P, Q, radius (R⊕), mass (M⊕), Teq (K), method, year, flags, inclination (deg)] */
type PlanetRow = [
  number, string, string | null, number, number, number, number, [number, number, number], [number, number, number],
  number | null, number | null, number | null, number, number | null, number, number | null,
];

export interface PlanetFile {
  format: string;
  version: number;
  epoch: number;
  methods: string[];
  /** [node path, index in the node, archive name, galactic position (ly), number of planets] */
  hosts: [string, number, string, [number, number, number], number][];
  planets: PlanetRow[];
  sources: SourceInfo[];
}

export interface PlanetHost {
  /** Star key in the map ("path:index"). */
  key: string;
  path: string;
  index: number;
  /** Name in the NASA Exoplanet Archive (Sun for the Solar System). */
  name: string;
  /** World position of the star (ly), exactly as the star is drawn. */
  pos: Vector3;
  /** Indices of its planets, from the innermost. */
  planets: number[];
  /** Largest apoapsis of its planets (ly). */
  reach: number;
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
  const hosts: PlanetHost[] = file.hosts.map(([path, index, name, pos]) => ({
    key: `${path}:${index}`,
    path,
    index,
    name,
    pos: new Vector3(Math.fround(pos[0]), Math.fround(pos[2]), Math.fround(-pos[1])),
    planets: [],
    reach: 0,
  }));
  const planets: Planet[] = file.planets.map((r, i) => {
    const [host, name, nameDe, a, e, period, m0, P, Q, radius, mass, eqt, method, year, flags, incl] = r;
    const h = hosts[host];
    h.planets.push(i);
    h.reach = Math.max(h.reach, (a * (1 + e)) / AU_PER_LY);
    return {
      host, name, nameDe, a, e, period, m0, P: world(P), Q: world(Q), radius: num(radius), mass: num(mass), eqt: num(eqt),
      method: file.methods[method] ?? '', year, flags, incl: num(incl),
    };
  });
  return { hosts, planets, byStar: new Map(hosts.map((h, i) => [h.key, i])), sources: file.sources ?? [] };
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
export function planetOffset(p: Planet, jd: number, out = new Vector3()): Vector3 {
  const m = p.m0 + (2 * Math.PI * (jd - J2000)) / p.period;
  return orbitPoint(p, eccentricAnomaly(m, p.e), out);
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
