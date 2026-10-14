import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  LineBasicMaterial,
  LineSegments,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';

/** "Nice" step (1, 2, 5 × 10^k) close to x. */
export function niceStep(x: number): number {
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / e;
  const n = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return n * e;
}

export interface GridLabel {
  /** World position (updated whenever the grid moves). */
  position: Vector3;
  /** Position relative to the grid centre. */
  local: Vector3;
  text: string;
  kind: 'ring' | 'spoke';
  /** Highlighted label (direction of the Galactic Centre). */
  highlight?: boolean;
}

/**
 * Polar grid parallel to the galactic plane, centred on the view centre. Spokes point along
 * galactic longitude directions (0° = towards the Galactic Centre).
 */
export class PolarGrid {
  readonly group = new Group();
  private readonly minor: LineSegments;
  private readonly major: LineSegments;
  private radius = -1;
  private labelKey = '';
  labels: GridLabel[] = [];

  constructor() {
    this.minor = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: new Color(0x5a7fb0), transparent: true, opacity: 0.16, depthWrite: false }),
    );
    this.major = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: new Color(0x7fa6e0), transparent: true, opacity: 0.38, depthWrite: false }),
    );
    this.minor.frustumCulled = false;
    this.major.frustumCulled = false;
    this.group.add(this.minor, this.major);
    this.group.name = 'grid';
  }

  /** labelKey: changes when the label texts change (e.g. language), forcing a rebuild. */
  update(
    center: Vector3,
    radius: number,
    formatDistance: (ly: number) => string,
    labelKey: string,
    gcLabel = 'GC',
  ): void {
    this.group.position.copy(center);
    this.group.updateMatrixWorld();
    if (radius !== this.radius || labelKey !== this.labelKey) {
      this.radius = radius;
      this.labelKey = labelKey;
      this.rebuild(radius, formatDistance, gcLabel);
    }
    for (const l of this.labels) l.position.copy(l.local).add(center);
  }

  private rebuild(radius: number, formatDistance: (ly: number) => string, gcLabel: string): void {
    const step = niceStep(radius / 4);
    const minor: number[] = [];
    const major: number[] = [];
    const seg = 128;
    const ring = (r: number, out: number[]) => {
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2;
        const a1 = ((i + 1) / seg) * Math.PI * 2;
        out.push(Math.cos(a0) * r, 0, -Math.sin(a0) * r, Math.cos(a1) * r, 0, -Math.sin(a1) * r);
      }
    };
    const labels: GridLabel[] = [];
    const ringLabel = (r: number) => {
      const local = new Vector3(r * Math.SQRT1_2, 0, -r * Math.SQRT1_2);
      labels.push({ position: local.clone(), local, text: formatDistance(r), kind: 'ring' });
    };
    let k = 1;
    for (let r = step; r < radius * 0.999; r += step, k++) {
      ring(r, k % 2 === 0 ? major : minor);
      ringLabel(r);
    }
    ring(radius, major);
    ringLabel(radius);
    for (let deg = 0; deg < 360; deg += 30) {
      const a = (deg * Math.PI) / 180;
      const dx = Math.cos(a);
      const dz = -Math.sin(a);
      (deg % 90 === 0 ? major : minor).push(dx * step * 0.25, 0, dz * step * 0.25, dx * radius, 0, dz * radius);
      const local = new Vector3(dx * radius * 1.06, 0, dz * radius * 1.06);
      const text = deg === 0 ? `0° · ${gcLabel}` : `${deg}°`;
      labels.push({ position: local.clone(), local, text, kind: 'spoke', highlight: deg === 0 });
    }
    this.minor.geometry.dispose();
    this.major.geometry.dispose();
    this.minor.geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(minor), 3));
    this.major.geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(major), 3));
    this.labels = labels;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }

  get visible(): boolean {
    return this.group.visible;
  }
}

/** Vertical lines from stars down (or up) to the grid plane. */
export class DropLines {
  readonly lines: LineSegments;
  private capacity = 0;

  constructor() {
    this.lines = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: new Color(0x8fb4e8), transparent: true, opacity: 0.3, depthWrite: false }),
    );
    this.lines.frustumCulled = false;
    this.ensure(256);
  }

  private ensure(n: number): void {
    if (n <= this.capacity) return;
    this.capacity = Math.max(n, this.capacity * 2);
    const attr = new BufferAttribute(new Float32Array(this.capacity * 6), 3);
    attr.setUsage(DynamicDrawUsage);
    this.lines.geometry.dispose();
    this.lines.geometry = new BufferGeometry().setAttribute('position', attr);
  }

  /** points: world positions; planeY: world y of the grid plane. */
  set(points: Vector3[], planeY: number): void {
    this.ensure(points.length);
    const attr = this.lines.geometry.getAttribute('position') as BufferAttribute;
    const a = attr.array as Float32Array;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      a[6 * i] = p.x;
      a[6 * i + 1] = p.y;
      a[6 * i + 2] = p.z;
      a[6 * i + 3] = p.x;
      a[6 * i + 4] = planeY;
      a[6 * i + 5] = p.z;
    }
    attr.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, points.length * 2);
  }
}

const markerVertex = /* glsl */ `
uniform float uPx;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uPx;
}
`;
const markerFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  float ring = smoothstep(0.72, 0.8, r) * (1.0 - smoothstep(0.9, 0.98, r));
  if (ring <= 0.01) discard;
  gl_FragColor = vec4(uColor, ring * uOpacity);
}
`;

/** Screen-space ring marking a star (selection / hover). */
export class Marker {
  readonly points: Points;
  private readonly material: ShaderMaterial;

  constructor(color: number, px: number, opacity = 1) {
    this.material = new ShaderMaterial({
      vertexShader: markerVertex,
      fragmentShader: markerFragment,
      uniforms: {
        uPx: { value: px },
        uColor: { value: new Color(color) },
        uOpacity: { value: opacity },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const g = new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
    this.points = new Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.renderOrder = 1000;
  }

  show(p: Vector3 | null, pixelRatio: number): void {
    if (!p) {
      this.points.visible = false;
      return;
    }
    const attr = this.points.geometry.getAttribute('position') as BufferAttribute;
    attr.setXYZ(0, p.x, p.y, p.z);
    attr.needsUpdate = true;
    this.material.uniforms.uPx.value = 30 * pixelRatio;
    this.points.visible = true;
  }
}
