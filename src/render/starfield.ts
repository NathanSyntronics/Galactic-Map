import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Camera,
  Group,
  Matrix3,
  Points,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';
import { Flag, UNKNOWN_I16, type NodeData } from '../data/format';
import { LY_PER_PC } from '../data/galactic';
import type { OctreeNode } from '../data/octree';
import type { Settings } from '../settings';
import { temperatureColor } from './colors';
import { MISSING_COLOR, MISSING_SIZE, hexToRgb, type StylePlan } from './style';

const MISSING_RGB = hexToRgb(MISSING_COLOR);
const DEFAULT_PLAN: StylePlan = { color: null, size: null, missing: 'dim' };

// Each octree node is rendered relative to its own render origin (see renderOrigin): the position
// attribute holds `position - origin` and the Points object sits at the origin. The origin is
// chosen so that this subtraction is exact in float32, so origin + attribute is bit for bit the
// decoded position that CPU-side picking and labels use.
// Multiplying the node-relative positions by modelViewMatrix in float32 would still cancel the
// camera-to-origin translation (up to tens of thousands of light years in the root node, which
// holds distant luminous stars) against the position and leave errors of ~1e-3 ly: stars would
// jitter and drift from their labels when the camera is close to them. So the shader first
// subtracts uCamLocal, the camera position in node coordinates rounded to float32: that difference
// is exact for stars near the camera (Sterbenz lemma), and the small rest of the camera offset
// (uCamRest, in view space) is computed in double precision on the CPU. These uniforms are set per
// node in onBeforeRender (see Starfield.add).
const vertexShader = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
uniform vec3 uCamLocal;
uniform vec3 uCamRest;
uniform vec3 uTargetRel;
uniform float uRadius;
uniform float uFade;
uniform float uScale;
uniform float uSizeMul;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uMinAlpha;
varying vec3 vColor;
varying float vAlpha;
varying float vPx;
void main() {
  vec3 rel = position - uCamLocal;
  float d = distance(rel, uTargetRel);
  float a = 1.0 - smoothstep(uRadius * uFade, uRadius, d);
  if (a <= 0.0 || aSize <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    vColor = vec3(0.0);
    vPx = 0.0;
    return;
  }
  vec4 mv = vec4(mat3(modelViewMatrix) * rel + uCamRest, 1.0);
  float depth = max(-mv.z, 1e-5);
  float px = 2.0 * aSize * uSizeMul * uScale / depth;
  float intensity = 1.0;
  if (px < uMinPx) {
    // stars that would be smaller than the minimum sprite are drawn at the minimum size but
    // dimmed roughly like their apparent brightness, down to a density-dependent floor
    float f = px / uMinPx;
    intensity = max(f * sqrt(f), uMinAlpha);
    px = uMinPx;
  }
  px = min(px, uMaxPx);
  gl_PointSize = px;
  gl_Position = projectionMatrix * mv;
  vColor = aColor;
  vAlpha = a * intensity;
  vPx = px;
}
`;

const fragmentShader = /* glsl */ `
uniform float uBrightness;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vAlpha;
varying float vPx;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float r = sqrt(r2);
  // tiny sprites: solid soft disk; large sprites: bright core with a glow
  float large = clamp((vPx / uPixelRatio - 4.0) / 8.0, 0.0, 1.0);
  float disk = 1.0 - smoothstep(0.55, 1.0, r);
  float core = 1.0 - smoothstep(0.16, 0.4, r);
  float glow = exp(-r2 * 5.0) * (1.0 - r2);
  float profile = mix(disk, core * 0.95 + glow * 0.6, large);
  float a = clamp(profile * vAlpha * uBrightness, 0.0, 1.0);
  vec3 col = mix(vColor, vec3(1.0), core * 0.3 * large);
  gl_FragColor = vec4(col, a);
}
`;

/** Sprite size in device pixels, as the vertex shader computes it (size: symbol radius in ly). */
export function spritePx(size: number, sizeMul: number, scale: number, depth: number, minPx: number, maxPx: number): number {
  const px = (2 * size * sizeMul * scale) / Math.max(depth, 1e-5);
  return Math.min(Math.max(px, minPx), maxPx);
}

export function createStarMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uCamLocal: { value: new Vector3() },
      uCamRest: { value: new Vector3() },
      uTargetRel: { value: new Vector3() },
      uRadius: { value: 50 },
      uFade: { value: 0.85 },
      uScale: { value: 1000 },
      uSizeMul: { value: 1 },
      uMinPx: { value: 2.5 },
      uMaxPx: { value: 72 },
      uMinAlpha: { value: 0.45 },
      uBrightness: { value: 1 },
      uPixelRatio: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: AdditiveBlending,
  });
}

/**
 * Render origin of an octree node: per axis, the node centre snapped to the float32 grid of the
 * node's largest coordinates, or 0 when the node reaches close to 0 on that axis. For every star
 * inside the node, `position - origin` is then exactly representable in float32 (the difference is
 * a multiple of the position's own ulp and not larger than the position itself), and it stays
 * within a few node half sizes.
 */
export function renderOrigin(center: Vector3, halfSize: number, out = new Vector3()): Vector3 {
  const axis = (c: number): number => {
    if (!(Math.abs(c) >= 3 * halfSize)) return 0;
    const grid = 2 ** (Math.floor(Math.log2(Math.abs(c) + 2 * halfSize)) - 23);
    return Math.round(c / grid) * grid;
  };
  return out.set(axis(center.x), axis(center.y), axis(center.z));
}

/**
 * Positions relative to `origin` as float32. An axis on which a difference would not be exact (a
 * star outside its node's cube) falls back to origin 0, so origin + result always equals the input
 * exactly. Updates `origin` accordingly.
 */
export function relativePositions(positions: Float32Array, origin: Vector3): Float32Array {
  const out = new Float32Array(positions.length);
  const o = [origin.x, origin.y, origin.z];
  for (let a = 0; a < 3; a++) {
    let exact = true;
    for (let i = a; i < positions.length; i += 3) {
      const v = positions[i] - o[a];
      out[i] = v;
      if (out[i] !== v) exact = false;
    }
    if (!exact) {
      o[a] = 0;
      for (let i = a; i < positions.length; i += 3) out[i] = positions[i];
    }
  }
  origin.set(o[0], o[1], o[2]);
  return out;
}

const viewRotation = new Matrix3();

/**
 * Sets the camera-dependent uniforms of the star material for a node rendered relative to
 * `origin` (see the vertex shader). The camera's world matrix must be up to date.
 */
export function setNodeView(material: ShaderMaterial, camera: Camera, target: Vector3, origin: Vector3): void {
  const u = material.uniforms;
  const cam = camera.position;
  const camLocal = (u.uCamLocal.value as Vector3).set(
    Math.fround(cam.x - origin.x),
    Math.fround(cam.y - origin.y),
    Math.fround(cam.z - origin.z),
  );
  viewRotation.setFromMatrix4(camera.matrixWorldInverse);
  (u.uCamRest.value as Vector3).copy(origin).add(camLocal).sub(cam).applyMatrix3(viewRotation);
  (u.uTargetRel.value as Vector3).copy(target).sub(origin).sub(camLocal);
}

/** Estimated log10(L/Lsun) for star i (falls back to absolute magnitude, then a dwarf default). */
export function starLogL(node: NodeData, i: number): number {
  const l = node.logL[i];
  if (l !== UNKNOWN_I16) return l / 1000;
  const m = node.absMag[i];
  if (m !== UNKNOWN_I16) return (4.74 - m / 100) / 2.5;
  return node.flags[i] & Flag.BROWN_DWARF ? -4.5 : -1.5;
}

/**
 * Apparent visual magnitude of star i as seen from the Sun (from the absolute magnitude, else from
 * the bolometric luminosity); undefined for the Sun itself or without either value.
 */
export function apparentMag(node: NodeData, i: number): number | undefined {
  const p = node.positions;
  const dLy = Math.hypot(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
  if (dLy < 1e-6) return undefined;
  let absMag: number;
  if (node.absMag[i] !== UNKNOWN_I16) absMag = node.absMag[i] / 100;
  else if (node.logL[i] !== UNKNOWN_I16) absMag = 4.74 - 2.5 * (node.logL[i] / 1000);
  else return undefined;
  return absMag + 5 * Math.log10(dLy / LY_PER_PC) - 5;
}

/** Symbolic star radius in light years for the size of its sprite. */
export function symbolRadius(logL: number): number {
  // L^0.2 maps 1e-5..1e6 Lsun to a factor ~0.1..16; the Sun gets 0.2 ly.
  return 0.2 * Math.pow(10, 0.2 * Math.min(Math.max(logL, -6), 6.5));
}

export function isStarVisible(node: NodeData, i: number, s: Settings): boolean {
  const f = node.flags[i];
  if (f & Flag.SUN) return true;
  if (f & Flag.BROWN_DWARF && !s.showBrownDwarfs) return false;
  if (f & Flag.WHITE_DWARF && !s.showWhiteDwarfs) return false;
  if (s.maxDistErr < 100) {
    const e = node.distErr[i];
    if (e !== 255 && e / 2 > s.maxDistErr) return false;
  }
  return true;
}

function temperatureStyle(node: NodeData, i: number, s: Settings, colors: Uint8Array): void {
  const f = node.flags[i];
  const teff = node.teff[i];
  if (teff > 0) {
    temperatureColor(teff, s.saturation, colors, 3 * i);
  } else if (f & Flag.BROWN_DWARF) {
    temperatureColor(1200, s.saturation, colors, 3 * i);
  } else if (f & Flag.WHITE_DWARF) {
    temperatureColor(9000, s.saturation, colors, 3 * i);
  } else {
    colors[3 * i] = colors[3 * i + 1] = colors[3 * i + 2] = 215;
  }
}

/** Colour and symbol size of every star of a node (size 0: hidden). */
export function computeStyle(node: NodeData, s: Settings, plan: StylePlan, colors: Uint8Array, sizes: Float32Array): void {
  for (let i = 0; i < node.count; i++) {
    if (!isStarVisible(node, i, s)) {
      sizes[i] = 0;
      colors[3 * i] = colors[3 * i + 1] = colors[3 * i + 2] = 0;
      continue;
    }
    const hasColor = plan.color ? plan.color(node, i, colors, 3 * i) : true;
    let size = plan.size ? plan.size(node, i) : symbolRadius(starLogL(node, i));
    const hasSize = size !== undefined;
    if (hasColor && hasSize) {
      if (!plan.color) temperatureStyle(node, i, s, colors);
      sizes[i] = size!;
      continue;
    }
    // no value for the attribute the map is coloured or sized by
    const sun = (node.flags[i] & Flag.SUN) !== 0;
    if (plan.missing === 'hide' && !sun) {
      sizes[i] = 0;
      colors[3 * i] = colors[3 * i + 1] = colors[3 * i + 2] = 0;
      continue;
    }
    if (plan.missing === 'normal' || sun) {
      if (!hasColor || !plan.color) temperatureStyle(node, i, s, colors);
      size ??= symbolRadius(starLogL(node, i));
    } else {
      colors[3 * i] = MISSING_RGB[0];
      colors[3 * i + 1] = MISSING_RGB[1];
      colors[3 * i + 2] = MISSING_RGB[2];
      size = MISSING_SIZE;
    }
    sizes[i] = size;
  }
}

function releaseArray(this: BufferAttribute): void {
  this.array = new Float32Array(0);
}

export interface RenderedNode {
  node: OctreeNode;
  data: NodeData;
  points: Points;
  /** Render origin of the node: the Points object's position (see renderOrigin). */
  origin: Vector3;
  colors: Uint8Array;
  sizes: Float32Array;
}

/** Owns one THREE.Points per loaded octree node and keeps their style attributes up to date. */
export class Starfield {
  readonly group = new Group();
  readonly material = createStarMaterial();
  private readonly rendered = new Map<string, RenderedNode>();
  /** View centre (world), for the fade-out at the view radius. */
  private readonly target = new Vector3();

  constructor(
    private settings: () => Settings,
    private plan: () => StylePlan = () => DEFAULT_PLAN,
  ) {
    this.group.name = 'starfield';
  }

  /** Sets the view centre used by the next render. */
  setTarget(target: Vector3): void {
    this.target.copy(target);
  }

  add(node: OctreeNode, data: NodeData): RenderedNode {
    const existing = this.rendered.get(node.path);
    if (existing) return existing;
    const geometry = new BufferGeometry();
    // node-relative positions; origin + attribute == data.positions exactly (CPU picking and labels)
    const origin = renderOrigin(node.worldCenter, node.halfSize);
    const local = relativePositions(data.positions, origin);
    const position = new BufferAttribute(local, 3);
    // the CPU side keeps using data.positions: the node-relative copy is not needed after upload
    position.onUpload(releaseArray);
    geometry.setAttribute('position', position);
    const colors = new Uint8Array(data.count * 3);
    const sizes = new Float32Array(data.count);
    computeStyle(data, this.settings(), this.plan(), colors, sizes);
    geometry.setAttribute('aColor', new BufferAttribute(colors, 3, true));
    geometry.setAttribute('aSize', new BufferAttribute(sizes, 1));
    geometry.boundingSphere = new Sphere(node.worldCenter.clone().sub(origin), node.radius);
    const points = new Points(geometry, this.material);
    points.position.copy(origin);
    points.matrixAutoUpdate = false;
    points.updateMatrix();
    points.frustumCulled = true;
    points.visible = false;
    points.renderOrder = node.level;
    // the shared material's camera uniforms are relative to this node's origin
    points.onBeforeRender = (_renderer, _scene, camera) => {
      setNodeView(this.material, camera, this.target, origin);
      this.material.uniformsNeedUpdate = true;
    };
    this.group.add(points);
    const r: RenderedNode = { node, data, points, origin, colors, sizes };
    this.rendered.set(node.path, r);
    return r;
  }

  remove(path: string): void {
    const r = this.rendered.get(path);
    if (!r) return;
    this.group.remove(r.points);
    r.points.geometry.dispose();
    this.rendered.delete(path);
  }

  /** Show exactly the given set of node paths. */
  setVisible(paths: Set<string>): void {
    for (const [path, r] of this.rendered) r.points.visible = paths.has(path);
  }

  visibleNodes(): RenderedNode[] {
    const out: RenderedNode[] = [];
    for (const r of this.rendered.values()) if (r.points.visible) out.push(r);
    return out;
  }

  get(path: string): RenderedNode | undefined {
    return this.rendered.get(path);
  }

  /** Recompute colours/sizes of all nodes (after a style or filter change). */
  restyle(): void {
    const s = this.settings();
    const plan = this.plan();
    for (const r of this.rendered.values()) {
      computeStyle(r.data, s, plan, r.colors, r.sizes);
      (r.points.geometry.getAttribute('aColor') as BufferAttribute).needsUpdate = true;
      (r.points.geometry.getAttribute('aSize') as BufferAttribute).needsUpdate = true;
    }
  }

  visiblePointCount(): number {
    let n = 0;
    for (const r of this.rendered.values()) if (r.points.visible) n += r.data.count;
    return n;
  }
}
