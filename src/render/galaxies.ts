/**
 * The galaxies (docs/GALAXIES.md): disk galaxies as quads in their disk plane with a procedural
 * pattern, ellipticals and spheroidals as camera-facing ellipses, a small camera-facing glow for
 * every galaxy (so that disks seen edge-on and tiny galaxies stay visible), and the Milky Way as a
 * model. Like the stars, a galaxy is drawn while it lies in the visible sphere.
 *
 * Positions are stored relative to an origin near the view centre (the group's position), so that
 * float32 keeps them precise at hundreds of millions of light years; three.js combines the
 * group's matrix and the camera's in double precision.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import { GalaxyClass, GalaxyFlag, type GalaxyCatalogue } from '../data/galaxies';

const QUAD = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];

/** Brightness (0..1) for a luminosity: log L 6.45 and below 0.35, 11 full. */
export function galaxyBrightness(logL: number): number {
  if (!Number.isFinite(logL)) return 0.55;
  return Math.min(Math.max((logL - 4) / 7, 0.35), 1);
}

/**
 * Symbol size of a galaxy as a fraction of the visible radius (before the density factor): like
 * the stars, galaxies are drawn larger than they are, the more so the more luminous (L^0.18), so
 * that their distribution shows at every scale. The Milky Way and Andromeda (log L 10.8) get 9 %
 * of the radius, the Large Magellanic Cloud 5 %, a dwarf of log L 5 0.8 %. A galaxy is never
 * drawn smaller than it is.
 */
export function galaxySymbolFactor(logL: number): number {
  const l = Number.isFinite(logL) ? Math.min(Math.max(logL, 3), 11.5) : 8;
  return 0.065 * Math.pow(10, 0.18 * (l - 10));
}

/**
 * Density factor of the symbol sizes: with many galaxies in the visible sphere they shrink (as
 * stars dim in dense regions), so that thousands of them do not merge into one glow; with tens of
 * thousands (Cosmicflows-4) nearly all are drawn as small glows.
 */
export function galaxyDensityFactor(inView: number): number {
  return Math.min(Math.max(Math.pow(300 / Math.max(inView, 1), 0.75), 0.01), 1);
}

/** Brightness factor of the point-like galaxies in a crowded view (Cosmicflows-4: about a quarter). */
export function galaxyCrowdFactor(inView: number): number {
  return Math.min(Math.max(Math.sqrt(2500 / Math.max(inView, 1)), 0.22), 1);
}

/** How much larger than its true radius a galaxy is drawn (1: true size). */
export function galaxyScale(trueRadius: number, factor: number, exaggeration: number): number {
  return Math.max(1, (exaggeration * factor) / Math.max(trueRadius, 1e-6));
}

/** A stable number in [0, 1) per galaxy (arm phase, noise). */
function seedOf(cat: GalaxyCatalogue, i: number): number {
  let h = (cat.pgc[i] || i + 1) * 2654435761;
  h ^= h >>> 15;
  return ((h >>> 0) % 10007) / 10007;
}

const isDisk = (cls: number) => cls === GalaxyClass.Spiral || cls === GalaxyClass.Lenticular || cls === GalaxyClass.Irregular;

const common = /* glsl */ `
uniform vec3 uTargetRel;
uniform float uRadius;
uniform float uFade;
uniform float uScale;
uniform float uMinPx;
uniform float uOpacity;
uniform float uExagg;
uniform float uCrowd;
float sphereFade(vec3 c) {
  return 1.0 - smoothstep(uRadius * uFade, uRadius, distance(c, uTargetRel));
}
`;

const diskVertex = /* glsl */ `
${common}
attribute vec3 aCenter;
attribute vec3 aAxisA;
attribute vec3 aAxisB;
attribute vec4 aParams; // class, brightness, seed, symbol factor
varying vec2 vUv;
varying float vAlpha;
varying vec4 vParams;
varying float vSym;
void main() {
  float a = sphereFade(aCenter);
  vec4 mvC = modelViewMatrix * vec4(aCenter, 1.0);
  float rTrue = length(aAxisA);
  // drawn larger than it is at large scales (a symbol, like the stars)
  float k = max(1.0, uExagg * aParams.w / max(rTrue, 1e-6));
  float px = k * rTrue / max(-mvC.z, 1e-6) * uScale;
  if (a <= 0.0 || px < 1.5 || mvC.z > 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    return;
  }
  vec3 p = aCenter + k * (position.x * aAxisA + position.y * aAxisB);
  // a symbol (drawn larger than the galaxy) is drawn brighter, so that it reads at a glance
  vSym = clamp(k - 1.0, 0.0, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  vUv = position.xy;
  vParams = aParams;
  // fades in as it grows beyond a few pixels (the glow carries the small ones)
  vAlpha = a * uOpacity * smoothstep(1.5, 6.0, px);
}
`;

const noise = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const diskFragment = /* glsl */ `
${noise}
varying vec2 vUv;
varying float vAlpha;
varying vec4 vParams;
varying float vSym;
void main() {
  if (vAlpha <= 0.0) discard;
  float r = length(vUv);
  if (r > 1.0) discard;
  float cls = vParams.x;
  float seed = vParams.z;
  float edge = 1.0 - smoothstep(0.7, 1.0, r);
  float I;
  vec3 col;
  if (cls < 0.5) {
    // spiral: exponential disk, two logarithmic arms (pitch 15 deg), bulge
    float th = atan(vUv.y, vUv.x);
    float arms = cos(2.0 * (th - log(r + 0.03) * 3.73) + seed * 6.2832);
    float armI = pow(0.5 + 0.5 * arms, 2.5);
    float disk = exp(-r * 3.0);
    float bulge = exp(-r * r / 0.012);
    float clumps = 0.75 + 0.5 * noise(vUv * 11.0 + seed * 50.0);
    I = disk * (0.25 + 1.0 * armI) * clumps + 1.3 * bulge;
    col = mix(vec3(0.68, 0.78, 1.0), vec3(1.0, 0.85, 0.62), clamp(bulge * 1.6 + (1.0 - armI) * 0.25, 0.0, 1.0));
  } else if (cls < 1.5) {
    // lenticular: smooth disk and bulge
    float bulge = exp(-r * r / 0.02);
    I = exp(-r * 3.8) * 0.8 + 1.2 * bulge;
    col = vec3(1.0, 0.87, 0.7);
  } else {
    // irregular: clumps
    float n1 = noise(vUv * 4.0 + seed * 37.0);
    float n2 = noise(vUv * 9.0 + seed * 13.0);
    float c = n1 * 0.6 + n2 * 0.4;
    I = exp(-r * 2.0) * (0.45 + 1.8 * c * c);
    col = vec3(0.72, 0.82, 1.0);
  }
  gl_FragColor = vec4(col, clamp(I * edge * vParams.y * vAlpha * (1.0 + 0.8 * vSym), 0.0, 1.0));
}
`;

const glowVertex = /* glsl */ `
${common}
attribute vec3 aCenter;
attribute vec3 aMajor;
attribute vec4 aParams; // radius (ly), axis ratio, brightness, class
attribute vec2 aSymbol; // symbol factor, true radius of the galaxy (ly)
varying vec2 vUv;
varying float vAlpha;
varying float vCls;
varying float vPoint;
varying float vSym;
void main() {
  float a = sphereFade(aCenter);
  vec4 mv = modelViewMatrix * vec4(aCenter, 1.0);
  float dist = -mv.z;
  if (a <= 0.0 || dist <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    return;
  }
  float k = max(1.0, uExagg * aSymbol.x / max(aSymbol.y, 1e-6));
  vSym = clamp(k - 1.0, 0.0, 1.0);
  float r = aParams.x * k;
  float q = aParams.y;
  float px = r / dist * uScale;
  // smaller than uMinPx: a round glow of that size, as bright as the galaxy would be
  vPoint = 1.0 - smoothstep(uMinPx, uMinPx * 2.0, px);
  if (px < uMinPx) {
    r = uMinPx * dist / uScale;
    q = 1.0;
  }
  vec2 mj = (modelViewMatrix * vec4(aMajor, 0.0)).xy;
  mj = length(mj) > 1e-4 ? normalize(mj) : vec2(1.0, 0.0);
  vec2 mn = vec2(-mj.y, mj.x);
  mv.xy += position.x * mj * r + position.y * mn * r * q;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy;
  vCls = aParams.w;
  // point-like galaxies in a crowded view are fainter (as the faint stars are in dense regions)
  vAlpha = a * uOpacity * aParams.z * mix(1.0, uCrowd, vPoint);
}
`;

const glowFragment = /* glsl */ `
varying vec2 vUv;
varying float vAlpha;
varying float vCls;
varying float vPoint;
varying float vSym;
void main() {
  if (vAlpha <= 0.0) discard;
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float r = sqrt(r2);
  float I;
  vec3 col;
  if (vCls > 1.5 && vCls < 2.5) {
    // elliptical: steep (de Vaucouleurs-like) profile
    I = exp(-5.5 * sqrt(r)) * 2.2;
    col = vec3(1.0, 0.85, 0.66);
  } else if (vCls > 3.5 && vCls < 4.5) {
    // dwarf spheroidal: faint and shallow
    I = exp(-3.0 * r) * 0.9;
    col = vec3(0.93, 0.87, 0.78);
  } else if (vCls > 2.5 && vCls < 3.5) {
    // irregular: a soft bluish glow
    I = exp(-r2 * 5.0) * 0.6;
    col = vec3(0.75, 0.84, 1.0);
  } else {
    // bulge of a disk galaxy (and of the Milky Way)
    I = exp(-r2 * 6.0);
    col = vec3(1.0, 0.88, 0.68);
  }
  // a point-like galaxy: a plain glow
  float p = exp(-r2 * 4.0);
  I = mix(I, p, vPoint) * (1.0 + 0.6 * vSym * (1.0 - vPoint));
  gl_FragColor = vec4(col, clamp(I * vAlpha, 0.0, 1.0));
}
`;

// The Milky Way model (galactic plane, centred on the Galactic Centre): local coordinates in kly,
// x towards the Galactic Centre as seen from the Sun, y towards l = 90 deg; the Sun at (-26.7, 0).
const mwVertex = /* glsl */ `
uniform float uHalf;
uniform float uK;
varying vec2 vP;
void main() {
  // PlaneGeometry lies in xy; the galactic plane is world xz with galactic y = -world z; uK: drawn
  // larger than it is at large scales, like the other galaxies
  vP = position.xy * uHalf / 1000.0;
  float h = uHalf * uK;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.x * h, 0.0, -position.y * h, 1.0);
}
`;

const mwFragment = /* glsl */ `
${noise}
uniform float uOpacity;
varying vec2 vP;
float wrapAngle(float a) { return mod(a + 3.14159265, 6.2831853) - 3.14159265; }
void main() {
  if (uOpacity <= 0.0) discard;
  float r = length(vP);
  if (r > 60.0) discard;
  float th = atan(vP.y, vP.x);
  // bar: half length 16 kly, 27 deg from the Sun-centre line, near end at positive longitudes
  vec2 b = vec2(-0.891, 0.454);
  float along = dot(vP, b);
  float across = dot(vP, vec2(-b.y, b.x));
  float bar = exp(-pow(along / 13.0, 2.0) - pow(across / 3.5, 2.0));
  float bulge = exp(-r * r / 9.0);
  float disk = exp(-r / 10.0) * (1.0 - smoothstep(42.0, 58.0, r));
  // four logarithmic arms, pitch 12 deg, the Sun between two of them; two major arms
  // (Scutum-Centaurus, Perseus) and two minor ones
  float lr = log(max(r, 0.5) / 13.0);
  float phi = th - lr * 4.705;
  float arms = cos(4.0 * phi + 4.115);
  float major = 0.5 + 0.5 * cos(2.0 * phi + 2.0575);
  float armI = pow(0.5 + 0.5 * arms, 4.0) * (0.45 + 0.55 * major) * smoothstep(9.0, 16.0, r);
  // the Local Arm: a short spur through the Sun (pitch 12 deg)
  float dth = wrapAngle(th - 3.14159265);
  float dl = log(max(r, 0.5) / 26.7) - dth * 0.2126;
  float local = exp(-pow(dl / 0.035, 2.0)) * exp(-pow(dth / 0.3, 2.0)) * 0.7;
  float knots = 0.7 + 0.6 * noise(vP * 0.9);
  float armFall = exp(-r / 16.0) * (1.0 - smoothstep(42.0, 58.0, r));
  float I = 1.6 * bulge + 0.9 * bar + disk * 0.2 + armFall * 1.4 * (armI + local) * knots;
  vec3 col = mix(vec3(0.66, 0.76, 1.0), vec3(1.0, 0.84, 0.6), clamp(1.4 * bulge + bar + (1.0 - armI) * 0.3, 0.0, 1.0));
  gl_FragColor = vec4(col, clamp(I * uOpacity * 0.85, 0.0, 1.0));
}
`;

export class GalaxyLayer {
  readonly group = new Group();
  private cat: GalaxyCatalogue | null = null;
  private disks: Mesh<InstancedBufferGeometry, ShaderMaterial> | null = null;
  private glows: Mesh<InstancedBufferGeometry, ShaderMaterial> | null = null;
  private diskIndex = new Int32Array(0);
  private readonly origin = new Vector3();
  private readonly uniforms = {
    uTargetRel: { value: new Vector3() },
    uRadius: { value: 1 },
    uFade: { value: 0.85 },
    uScale: { value: 1 },
    uMinPx: { value: 2.5 },
    uOpacity: { value: 1 },
    uExagg: { value: 0 },
    uCrowd: { value: 1 },
  };
  /** Symbol factor per galaxy (galaxySymbolFactor of its luminosity). */
  private symbol = new Float32Array(0);
  /** Smoothed density factor (galaxyDensityFactor of the galaxies in view). */
  private density = 1;
  private lastInView = 0;
  private lastUpdate = 0;
  readonly milkyWay: Mesh<PlaneGeometry, ShaderMaterial>;
  // the Galactic Centre (Sgr A*, 8.178 kpc) in world coordinates, until the catalogue says otherwise
  private readonly mwCentre = new Vector3(26673, -21.41, 26.07);
  private mwIndex = -1;

  constructor() {
    this.group.renderOrder = -2;
    const mwMat = new ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uHalf: { value: 60000 }, uK: { value: 1 } },
      vertexShader: mwVertex,
      fragmentShader: mwFragment,
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
    });
    this.milkyWay = new Mesh(new PlaneGeometry(2, 2, 1, 1), mwMat);
    this.milkyWay.renderOrder = -3;
    this.milkyWay.frustumCulled = false;
    this.milkyWay.visible = false;
  }

  get catalogue(): GalaxyCatalogue | null {
    return this.cat;
  }

  setCatalogue(cat: GalaxyCatalogue): void {
    this.cat = cat;
    this.group.clear();
    const n = cat.count;
    this.symbol = new Float32Array(n);
    for (let i = 0; i < n; i++) this.symbol[i] = galaxySymbolFactor(cat.logL[i]);
    const diskIdx: number[] = [];
    for (let i = 0; i < n; i++) if (isDisk(cat.cls[i]) && !(cat.flags[i] & GalaxyFlag.MODEL)) diskIdx.push(i);
    this.diskIndex = Int32Array.from(diskIdx);

    // disks
    const dg = new InstancedBufferGeometry();
    dg.setAttribute('position', new BufferAttribute(QUAD, 3));
    dg.setIndex(QUAD_INDEX);
    const m = diskIdx.length;
    const axisA = new Float32Array(3 * m);
    const axisB = new Float32Array(3 * m);
    const dParams = new Float32Array(4 * m);
    diskIdx.forEach((i, k) => {
      const r = cat.diam[i] / 2;
      const mx = cat.major[3 * i], my = cat.major[3 * i + 1], mz = cat.major[3 * i + 2];
      const nx = cat.normal[3 * i], ny = cat.normal[3 * i + 1], nz = cat.normal[3 * i + 2];
      // minor axis in the disk plane: normal x major
      const bx = ny * mz - nz * my, by = nz * mx - nx * mz, bz = nx * my - ny * mx;
      axisA.set([mx * r, my * r, mz * r], 3 * k);
      axisB.set([bx * r, by * r, bz * r], 3 * k);
      dParams.set([cat.cls[i], galaxyBrightness(cat.logL[i]), seedOf(cat, i), this.symbol[i]], 4 * k);
    });
    dg.setAttribute('aCenter', new InstancedBufferAttribute(new Float32Array(3 * m), 3));
    dg.setAttribute('aAxisA', new InstancedBufferAttribute(axisA, 3));
    dg.setAttribute('aAxisB', new InstancedBufferAttribute(axisB, 3));
    dg.setAttribute('aParams', new InstancedBufferAttribute(dParams, 4));
    dg.instanceCount = m;
    this.disks = new Mesh(dg, this.material(diskVertex, diskFragment));

    // glows: every galaxy (ellipticals and spheroidals: the galaxy itself; disks: their bulge)
    const gg = new InstancedBufferGeometry();
    gg.setAttribute('position', new BufferAttribute(QUAD, 3));
    gg.setIndex(QUAD_INDEX);
    const gMajor = new Float32Array(3 * n);
    const gParams = new Float32Array(4 * n);
    const gSymbol = new Float32Array(2 * n);
    for (let i = 0; i < n; i++) {
      const cls = cat.cls[i];
      const whole = cls === GalaxyClass.Elliptical || cls === GalaxyClass.Spheroidal;
      const r = cat.diam[i] / 2;
      const radius = whole ? r : cls === GalaxyClass.MilkyWay ? r * 0.12 : r * (cls === GalaxyClass.Irregular ? 0.45 : 0.18);
      gMajor.set([cat.major[3 * i], cat.major[3 * i + 1], cat.major[3 * i + 2]], 3 * i);
      gParams.set([radius, whole ? Math.max(cat.q[i], 0.3) : 1, galaxyBrightness(cat.logL[i]), cls], 4 * i);
      gSymbol.set([this.symbol[i], r], 2 * i);
    }
    gg.setAttribute('aCenter', new InstancedBufferAttribute(new Float32Array(3 * n), 3));
    gg.setAttribute('aMajor', new InstancedBufferAttribute(gMajor, 3));
    gg.setAttribute('aParams', new InstancedBufferAttribute(gParams, 4));
    gg.setAttribute('aSymbol', new InstancedBufferAttribute(gSymbol, 2));
    gg.instanceCount = n;
    this.glows = new Mesh(gg, this.material(glowVertex, glowFragment));
    for (const mesh of [this.disks, this.glows]) {
      mesh.frustumCulled = false;
      mesh.renderOrder = -2;
      this.group.add(mesh);
    }
    // the Milky Way model sits at the first record (the Galactic Centre)
    const mw = [...Array(n).keys()].find((i) => cat.flags[i] & GalaxyFlag.MODEL);
    this.mwIndex = mw ?? -1;
    if (mw !== undefined) this.mwCentre.set(cat.pos[3 * mw], cat.pos[3 * mw + 1], cat.pos[3 * mw + 2]);
    this.rebase(this.origin, true);
  }

  private material(vertexShader: string, fragmentShader: string): ShaderMaterial {
    return new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      // a disk is seen from either side
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
    });
  }

  /** Moves the origin of the float32 positions to `o` (when the view has moved far from it). */
  private rebase(o: Vector3, force = false): void {
    const cat = this.cat;
    if (!cat || !this.disks || !this.glows) return;
    if (!force && o.equals(this.origin)) return;
    this.origin.copy(o);
    this.group.position.copy(o);
    const dc = this.disks.geometry.getAttribute('aCenter') as InstancedBufferAttribute;
    const gc = this.glows.geometry.getAttribute('aCenter') as InstancedBufferAttribute;
    const da = dc.array as Float32Array;
    const ga = gc.array as Float32Array;
    for (let i = 0; i < cat.count; i++) {
      ga[3 * i] = cat.pos[3 * i] - o.x;
      ga[3 * i + 1] = cat.pos[3 * i + 1] - o.y;
      ga[3 * i + 2] = cat.pos[3 * i + 2] - o.z;
    }
    this.diskIndex.forEach((i, k) => {
      da[3 * k] = ga[3 * i];
      da[3 * k + 1] = ga[3 * i + 1];
      da[3 * k + 2] = ga[3 * i + 2];
    });
    dc.needsUpdate = true;
    gc.needsUpdate = true;
  }

  /**
   * Per frame: the visible sphere (`target`, `radius`), the projection scale (pixels per unit size
   * at unit distance) and what is shown. `mwOpacity`: the Milky Way model's opacity; `inView`:
   * the galaxies in the visible sphere (their symbols shrink when there are many).
   */
  update(target: Vector3, radius: number, scale: number, pixelRatio: number, show: boolean, mwOpacity: number, inView = 0): void {
    const u = this.uniforms;
    // eases towards the density factor (the count changes in steps while zooming); a jump (the
    // first count, a new view) is taken at once
    const now = performance.now();
    const goal = galaxyDensityFactor(inView);
    const jump = inView > 3 * this.lastInView || 3 * inView < this.lastInView;
    const ease = 1 - Math.exp(-Math.min(now - this.lastUpdate, 1000) / 300);
    this.density = jump ? goal : this.density + (goal - this.density) * ease;
    this.lastInView = inView;
    this.lastUpdate = now;
    u.uExagg.value = radius * this.density;
    u.uCrowd.value = galaxyCrowdFactor(inView);
    u.uRadius.value = radius;
    u.uScale.value = scale;
    u.uMinPx.value = 2.2 * pixelRatio;
    this.group.visible = show && !!this.cat;
    // a new origin once the view centre has moved by a hundredth of the radius from it
    if (this.cat && this.origin.distanceTo(target) > radius * 0.01) this.rebase(target.clone());
    u.uTargetRel.value.copy(target).sub(this.origin);
    const mw = this.milkyWay;
    const mat = mw.material;
    // the model fades with the visible sphere like a galaxy
    const d = this.mwCentre.distanceTo(target);
    const sphere = 1 - smoothstep(radius * 0.85, radius + 60000, d);
    mat.uniforms.uOpacity.value = mwOpacity * sphere;
    mat.uniforms.uK.value = this.mwIndex >= 0 ? this.displayScale(this.mwIndex) : 1;
    mw.visible = mat.uniforms.uOpacity.value > 0.001;
    mw.position.copy(this.mwCentre);
  }

  /** How much larger than its true size galaxy i is drawn now (1: true size). */
  displayScale(i: number): number {
    const cat = this.cat;
    if (!cat) return 1;
    return galaxyScale(cat.diam[i] / 2, this.symbol[i], this.uniforms.uExagg.value);
  }

  /** World position of galaxy i. */
  position(i: number, out = new Vector3()): Vector3 {
    const p = this.cat!.pos;
    return out.set(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Opacity of the Milky Way model for a visible radius: from 4,000 to 30,000 ly. */
export function milkyWayOpacity(radius: number): number {
  return smoothstep(4000, 30000, radius);
}
