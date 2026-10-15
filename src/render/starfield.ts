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

// Positions are absolute heliocentric coordinates (float32, exactly as decoded, so CPU-side picking
// and labels use the same values). Multiplying them by modelViewMatrix in float32 would cancel a
// translation of up to tens of thousands of light years against the position and leave errors of
// ~1e-3 ly: stars jitter and drift from their labels when the camera is close to a distant star.
// Instead the shader first subtracts uOrigin, a float32-exact point at the camera: that difference
// is exact for stars near the camera (Sterbenz lemma), and the small rest of the camera offset
// (uOriginView) is computed in double precision on the CPU. The Points objects must keep an
// identity model matrix.
const vertexShader = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
uniform vec3 uOrigin;
uniform vec3 uOriginView;
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
  vec3 rel = position - uOrigin;
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
  vec4 mv = vec4(mat3(modelViewMatrix) * rel + uOriginView, 1.0);
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

export function createStarMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uOrigin: { value: new Vector3() },
      uOriginView: { value: new Vector3() },
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

const viewRotation = new Matrix3();

/**
 * Sets the camera-relative uniforms of the star material (see the vertex shader). The camera's
 * world matrix must be up to date.
 */
export function setStarView(material: ShaderMaterial, camera: Camera, target: Vector3): void {
  const u = material.uniforms;
  const cam = camera.position;
  const origin = (u.uOrigin.value as Vector3).set(Math.fround(cam.x), Math.fround(cam.y), Math.fround(cam.z));
  viewRotation.setFromMatrix4(camera.matrixWorldInverse);
  (u.uOriginView.value as Vector3).copy(origin).sub(cam).applyMatrix3(viewRotation);
  (u.uTargetRel.value as Vector3).copy(target).sub(origin);
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

function computeStyle(node: NodeData, s: Settings, colors: Uint8Array, sizes: Float32Array): void {
  for (let i = 0; i < node.count; i++) {
    const f = node.flags[i];
    if (!isStarVisible(node, i, s)) {
      sizes[i] = 0;
      colors[3 * i] = colors[3 * i + 1] = colors[3 * i + 2] = 0;
      continue;
    }
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
    sizes[i] = symbolRadius(starLogL(node, i));
  }
}

export interface RenderedNode {
  node: OctreeNode;
  data: NodeData;
  points: Points;
  colors: Uint8Array;
  sizes: Float32Array;
}

/** Owns one THREE.Points per loaded octree node and keeps their style attributes up to date. */
export class Starfield {
  readonly group = new Group();
  readonly material = createStarMaterial();
  private readonly rendered = new Map<string, RenderedNode>();

  constructor(private settings: () => Settings) {
    this.group.name = 'starfield';
  }

  add(node: OctreeNode, data: NodeData): RenderedNode {
    const existing = this.rendered.get(node.path);
    if (existing) return existing;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
    const colors = new Uint8Array(data.count * 3);
    const sizes = new Float32Array(data.count);
    computeStyle(data, this.settings(), colors, sizes);
    geometry.setAttribute('aColor', new BufferAttribute(colors, 3, true));
    geometry.setAttribute('aSize', new BufferAttribute(sizes, 1));
    geometry.boundingSphere = new Sphere(node.worldCenter.clone(), node.radius);
    const points = new Points(geometry, this.material);
    points.frustumCulled = true;
    points.matrixAutoUpdate = false;
    points.visible = false;
    points.renderOrder = node.level;
    this.group.add(points);
    const r: RenderedNode = { node, data, points, colors, sizes };
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
    for (const r of this.rendered.values()) {
      computeStyle(r.data, s, r.colors, r.sizes);
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
