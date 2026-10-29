/**
 * Planetary systems (docs/PLANETS.md): the orbits as ellipses and the planets as symbols at their
 * positions for a date. Only the systems whose star lies in the visible sphere and whose orbits are
 * large enough on screen are drawn. Like the stars and the galaxies, a planet is drawn larger than
 * it is (a share of the visible radius, by its size), but never larger than a third of its orbit.
 *
 * A system's objects sit in a group at the star's position: three.js combines the group's and the
 * camera's matrices in double precision, so orbits of a hundredth of an AU stay sharp anywhere.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  LineBasicMaterial,
  LineLoop,
  PerspectiveCamera,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import {
  AU_PER_LY,
  EARTH_RADIUS_LY,
  PlanetFlag,
  orbitPoint,
  planetKind,
  planetOffset,
  type Planet,
  type PlanetCatalogue,
} from '../data/planets';

const ORBIT_POINTS = 256;
/** At most this many systems are drawn at once (the nearest to the camera). */
const MAX_SYSTEMS = 16;

const SOLAR_COLORS: Record<string, string> = {
  Mercury: '#b9b2aa',
  Venus: '#ecd9a6',
  Earth: '#5a9cf0',
  Mars: '#dd6b3d',
  Jupiter: '#dcb78c',
  Saturn: '#ead293',
  Uranus: '#a6e0e6',
  Neptune: '#5f7fe8',
};

const KIND_COLORS = {
  rocky: '#c9a27c',
  subNeptune: '#9cc9e6',
  iceGiant: '#6fa8e0',
  gasGiant: '#e2c08f',
};

/** Colour of a planet: the Solar System's their own, the others by kind; hot ones redder. */
export function planetColor(p: Planet): string {
  if (p.flags & PlanetFlag.SOLAR_SYSTEM && SOLAR_COLORS[p.name]) return SOLAR_COLORS[p.name];
  if (Number.isFinite(p.eqt) && p.eqt > 1300) return '#ff9a6a';
  return KIND_COLORS[planetKind(p)];
}

/**
 * Symbol radius of a planet as a share of the visible radius: 1.4 % for the Earth's size, 3.1 %
 * for Jupiter's (radius^0.33); unknown sizes as a mini-Neptune.
 */
export function planetSymbolFactor(radiusEarth: number): number {
  const r = Number.isFinite(radiusEarth) ? Math.min(Math.max(radiusEarth, 0.3), 25) : 2;
  return 0.014 * Math.pow(r, 0.33);
}

/** Drawn radius (ly) of a planet at a visible radius: the symbol, at least its true size, at most a third of its periapsis. */
export function planetDrawRadius(p: Planet, viewRadius: number): number {
  const trueR = (Number.isFinite(p.radius) ? p.radius : 2) * EARTH_RADIUS_LY;
  const sym = Math.max(trueR, viewRadius * planetSymbolFactor(p.radius));
  return Math.max(trueR, Math.min(sym, ((p.a * (1 - p.e)) / AU_PER_LY) / 3));
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

interface SystemView {
  group: Group;
  orbits: LineLoop<BufferGeometry, LineBasicMaterial>[];
  sprites: Sprite[];
  lastUsed: number;
}

/** A planet drawn this frame (for labels and picking). */
export interface DrawnPlanet {
  index: number;
  /** World position (updated every frame: labels may keep the reference). */
  pos: Vector3;
  /** Radius on screen (CSS px). */
  px: number;
  /** Radius of its orbit on screen (CSS px). */
  orbitPx: number;
  alpha: number;
}

export class PlanetLayer {
  readonly group = new Group();
  private cat: PlanetCatalogue | null = null;
  private readonly systems = new Map<number, SystemView>();
  private texture: CanvasTexture | null = null;
  private frame = 0;
  /** Live world positions of the planets (kept, so that labels can follow them). */
  private readonly live = new Map<number, Vector3>();
  /** The planets drawn in the last frame. */
  drawn: DrawnPlanet[] = [];

  constructor() {
    this.group.renderOrder = 4;
  }

  get catalogue(): PlanetCatalogue | null {
    return this.cat;
  }

  setCatalogue(cat: PlanetCatalogue): void {
    this.cat = cat;
    for (const v of this.systems.values()) this.dispose(v);
    this.systems.clear();
    this.live.clear();
  }

  /** Live world position of planet i (the object labels keep; updated while it is drawn). */
  livePosition(i: number): Vector3 {
    let v = this.live.get(i);
    if (!v) {
      v = new Vector3();
      this.live.set(i, v);
    }
    return v;
  }

  /** World position of planet i at a date. */
  position(i: number, jd: number, out = new Vector3()): Vector3 {
    const cat = this.cat!;
    const p = cat.planets[i];
    return planetOffset(p, jd, out).add(cat.hosts[p.host].pos);
  }

  /**
   * Per frame: the systems in the visible sphere (`target`, `radius`) at date `jd`; `scale`: device
   * pixels per unit size at unit distance.
   */
  update(target: Vector3, radius: number, camera: PerspectiveCamera, scale: number, pixelRatio: number, jd: number, show: boolean): void {
    this.frame++;
    this.drawn = [];
    const cat = this.cat;
    this.group.visible = show && !!cat;
    if (!cat || !show) return;
    const css = scale / pixelRatio;
    const active: { h: number; camD: number; fade: number }[] = [];
    for (let h = 0; h < cat.hosts.length; h++) {
      const host = cat.hosts[h];
      const d = host.pos.distanceTo(target);
      if (d > radius) continue;
      const camD = Math.max(host.pos.distanceTo(camera.position), 1e-12);
      if ((host.reach / camD) * css < 2) continue;
      active.push({ h, camD, fade: 1 - smoothstep(radius * 0.85, radius, d) });
    }
    active.sort((a, b) => a.camD - b.camD);
    const shown = new Set<number>();
    const tmp = new Vector3();
    for (const { h, camD, fade } of active.slice(0, MAX_SYSTEMS)) {
      shown.add(h);
      const view = this.system(h);
      view.lastUsed = this.frame;
      view.group.visible = true;
      const host = cat.hosts[h];
      host.planets.forEach((k, j) => {
        const p = cat.planets[k];
        const orbitPx = (p.a / AU_PER_LY / camD) * css;
        const orbitAlpha = smoothstep(3, 14, orbitPx) * fade;
        const alpha = smoothstep(2, 8, orbitPx) * fade;
        const line = view.orbits[j];
        line.material.opacity = 0.45 * orbitAlpha;
        line.visible = orbitAlpha > 0.01;
        const sprite = view.sprites[j];
        planetOffset(p, jd, tmp);
        sprite.position.copy(tmp);
        const r = planetDrawRadius(p, radius);
        // the disk fills 68 % of the symbol (the rest is its glow)
        sprite.scale.setScalar((2 * r) / 0.68);
        (sprite.material as SpriteMaterial).opacity = alpha;
        sprite.visible = alpha > 0.01;
        if (alpha > 0.01) {
          const pos = this.livePosition(k).copy(tmp).add(host.pos);
          const dist = Math.max(pos.distanceTo(camera.position), 1e-12);
          this.drawn.push({ index: k, pos, px: (r / dist) * css, orbitPx, alpha });
        }
      });
    }
    for (const [h, view] of this.systems) {
      if (shown.has(h)) continue;
      view.group.visible = false;
      // forget systems not drawn for a while (beyond the 40 last used)
      if (this.systems.size > 40 && this.frame - view.lastUsed > 600) {
        this.dispose(view);
        this.systems.delete(h);
      }
    }
  }

  private system(h: number): SystemView {
    const existing = this.systems.get(h);
    if (existing) return existing;
    const cat = this.cat!;
    const host = cat.hosts[h];
    const group = new Group();
    group.position.copy(host.pos);
    const orbits: SystemView['orbits'] = [];
    const sprites: Sprite[] = [];
    const tex = this.symbolTexture();
    const v = new Vector3();
    for (const k of host.planets) {
      const p = cat.planets[k];
      const pts = new Float32Array(3 * ORBIT_POINTS);
      for (let n = 0; n < ORBIT_POINTS; n++) {
        orbitPoint(p, (2 * Math.PI * n) / ORBIT_POINTS, v);
        pts.set([v.x, v.y, v.z], 3 * n);
      }
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(pts, 3));
      const line = new LineLoop(
        geo,
        new LineBasicMaterial({ color: planetColor(p), transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
      );
      line.frustumCulled = false;
      line.renderOrder = 4;
      const sprite = new Sprite(new SpriteMaterial({ map: tex, color: planetColor(p), transparent: true, depthTest: false, depthWrite: false }));
      sprite.frustumCulled = false;
      sprite.renderOrder = 5;
      group.add(line, sprite);
      orbits.push(line);
      sprites.push(sprite);
    }
    this.group.add(group);
    const view = { group, orbits, sprites, lastUsed: this.frame };
    this.systems.set(h, view);
    return view;
  }

  private dispose(view: SystemView): void {
    for (const l of view.orbits) {
      l.geometry.dispose();
      l.material.dispose();
    }
    for (const s of view.sprites) (s.material as SpriteMaterial).dispose();
    this.group.remove(view.group);
  }

  /** A shaded disk: a lit side, a soft edge and a faint glow around it. */
  private symbolTexture(): CanvasTexture {
    if (this.texture) return this.texture;
    const n = 64;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d')!;
    const glow = g.createRadialGradient(n / 2, n / 2, n * 0.3, n / 2, n / 2, n / 2);
    glow.addColorStop(0, 'rgba(255,255,255,0.35)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, n, n);
    const body = g.createRadialGradient(n * 0.4, n * 0.4, n * 0.02, n / 2, n / 2, n * 0.34);
    body.addColorStop(0, 'rgba(255,255,255,1)');
    body.addColorStop(0.7, 'rgba(225,225,225,1)');
    body.addColorStop(1, 'rgba(150,150,150,1)');
    g.fillStyle = body;
    g.beginPath();
    g.arc(n / 2, n / 2, n * 0.34, 0, 2 * Math.PI);
    g.fill();
    this.texture = new CanvasTexture(c);
    return this.texture;
  }
}
