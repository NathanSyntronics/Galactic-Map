import { BufferAttribute, BufferGeometry, Color, Group, Points, ShaderMaterial, Vector3 } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

/** Colour of the route: a bright magenta, apart from the network palettes (turbo, teal, star colours), the blue grid and the amber selection. */
export const ROUTE_RGB: [number, number, number] = [255, 77, 214];
export const ROUTE_CSS = `rgb(${ROUTE_RGB.join(', ')})`;
/** Width of the route line in CSS pixels, and of the dark casing beneath it. */
export const ROUTE_WIDTH = 3;
const CASING_WIDTH = 6;
/** Marker sizes (CSS px): waypoints shrink with the distance between these, start and destination stay. */
const WAYPOINT_MIN_PX = 4;
const WAYPOINT_MAX_PX = 11;
const END_PX = 17;
/** Waypoint marker size in light years (before the clamp). */
const WAYPOINT_LY = 0.6;

/**
 * Camera distance at which a sphere of `radius` fills the view with a margin: the narrower of the
 * vertical and horizontal field of view decides.
 */
export function fitDistance(radius: number, fovDeg: number, aspect: number, margin = 1.15): number {
  const half = (fovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(half) * aspect);
  return (Math.max(radius, 0.5) * margin) / Math.sin(Math.min(half, halfH));
}

/** Centre (of the bounding box) and radius of a set of points. */
export function routeBounds(points: readonly { x: number; y: number; z: number }[]): { centre: Vector3; radius: number } | null {
  if (!points.length) return null;
  const lo = new Vector3(Infinity, Infinity, Infinity);
  const hi = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const p of points) {
    lo.min(p as Vector3);
    hi.max(p as Vector3);
  }
  const centre = lo.add(hi).multiplyScalar(0.5);
  let r = 0;
  for (const p of points) r = Math.max(r, Math.hypot(p.x - centre.x, p.y - centre.y, p.z - centre.z));
  return { centre, radius: r };
}

const markerVertex = /* glsl */ `
attribute float aEnd;
uniform float uScale;
uniform float uWorld;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uEndPx;
varying float vEnd;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aEnd > 0.5 ? uEndPx : clamp(uWorld * uScale / max(-mv.z, 1e-12), uMinPx, uMaxPx);
  vEnd = aEnd;
}
`;

const markerFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vEnd;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  // a ring, so that the star in the middle stays visible
  float inner = vEnd > 0.5 ? 0.58 : 0.45;
  float ring = smoothstep(inner - 0.14, inner, r) * (1.0 - smoothstep(0.82, 1.0, r));
  if (ring <= 0.01) discard;
  gl_FragColor = vec4(uColor, ring * uOpacity);
}
`;

/**
 * The route: a thick line from waypoint to waypoint with a dark casing, and ring markers at the
 * waypoints (larger at start and destination). Always visible: no fade at the visible sphere.
 * Drawn after the jump network and before the stars (which are added on top, so the waypoint stars
 * stay visible); the markers are drawn last. Vertices are relative to the route's centre.
 */
export class RouteLine {
  readonly group = new Group();
  private readonly lineMaterial: LineMaterial;
  private readonly casingMaterial: LineMaterial;
  private readonly markerMaterial: ShaderMaterial;
  private line: Line2 | null = null;
  private casing: Line2 | null = null;
  private readonly markers: Points;
  private bounds: { centre: Vector3; radius: number } | null = null;

  constructor() {
    this.group.name = 'route';
    this.group.matrixAutoUpdate = false;
    const common = { transparent: true, depthTest: false, depthWrite: false, worldUnits: false };
    this.lineMaterial = new LineMaterial({ ...common, color: new Color(...ROUTE_RGB.map((v) => v / 255)), linewidth: ROUTE_WIDTH });
    this.casingMaterial = new LineMaterial({ ...common, color: 0x0a0312, linewidth: CASING_WIDTH, opacity: 0.6 });
    this.markerMaterial = new ShaderMaterial({
      vertexShader: markerVertex,
      fragmentShader: markerFragment,
      uniforms: {
        uScale: { value: 1000 },
        uWorld: { value: WAYPOINT_LY },
        uMinPx: { value: WAYPOINT_MIN_PX },
        uMaxPx: { value: WAYPOINT_MAX_PX },
        uEndPx: { value: END_PX },
        uColor: { value: new Color(...ROUTE_RGB.map((v) => v / 255)) },
        uOpacity: { value: 1 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.markers = new Points(new BufferGeometry(), this.markerMaterial);
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 950;
    this.markers.visible = false;
    this.group.add(this.markers);
  }

  /** True while a route is drawn. */
  get shown(): boolean {
    return this.bounds !== null;
  }

  /** Centre and radius of the drawn route. */
  get extent(): { centre: Vector3; radius: number } | null {
    return this.bounds;
  }

  /**
   * Draws a route through `points` (null removes it); `complete` false draws it fainter (a partial
   * route), and `goal` then gets its own end marker (not joined by the line), which also counts
   * for the extent.
   */
  set(points: readonly { x: number; y: number; z: number }[] | null, complete = true, goal: { x: number; y: number; z: number } | null = null): void {
    for (const l of [this.line, this.casing]) {
      if (!l) continue;
      this.group.remove(l);
      l.geometry.dispose();
    }
    this.line = this.casing = null;
    // the line's points, then the marker of an unreached destination
    const marked = points && !complete && goal ? [...points, goal] : points;
    this.bounds = marked ? routeBounds(marked) : null;
    if (!points || !marked || !this.bounds) {
      this.markers.visible = false;
      return;
    }
    // float32 vertices relative to an origin near the middle of the route
    const c = this.bounds.centre;
    this.group.position.set(Math.fround(c.x), Math.fround(c.y), Math.fround(c.z));
    this.group.updateMatrix();
    const o = this.group.position;
    const rel = new Float32Array(marked.length * 3);
    marked.forEach((p, i) => {
      rel[3 * i] = p.x - o.x;
      rel[3 * i + 1] = p.y - o.y;
      rel[3 * i + 2] = p.z - o.z;
    });
    if (points.length >= 2) {
      const make = (material: LineMaterial, order: number): Line2 => {
        const g = new LineGeometry();
        g.setPositions(rel.subarray(0, 3 * points.length));
        const l = new Line2(g, material);
        l.frustumCulled = false;
        // after the network lines (-2, -1), before the stars (their level, >= 0)
        l.renderOrder = order;
        this.group.add(l);
        return l;
      };
      this.casing = make(this.casingMaterial, -0.6);
      this.line = make(this.lineMaterial, -0.5);
    }
    this.lineMaterial.opacity = complete ? 1 : 0.55;
    this.markerMaterial.uniforms.uOpacity.value = complete ? 1 : 0.7;
    const ends = new Float32Array(marked.length);
    ends[0] = 1;
    if (complete || marked.length > points.length) ends[marked.length - 1] = 1;
    this.markers.geometry.dispose();
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(rel, 3));
    g.setAttribute('aEnd', new BufferAttribute(ends, 1));
    this.markers.geometry = g;
    this.markers.visible = true;
  }

  /** Viewport size in CSS pixels (line widths are in CSS pixels). */
  setResolution(width: number, height: number): void {
    this.lineMaterial.resolution.set(width, height);
    this.casingMaterial.resolution.set(width, height);
  }

  /** Per frame: device pixels per world unit at distance 1, and the device pixel ratio. */
  update(scale: number, pixelRatio: number): void {
    const u = this.markerMaterial.uniforms;
    u.uScale.value = scale;
    u.uMinPx.value = WAYPOINT_MIN_PX * pixelRatio;
    u.uMaxPx.value = WAYPOINT_MAX_PX * pixelRatio;
    u.uEndPx.value = END_PX * pixelRatio;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }
}
