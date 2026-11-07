/**
 * The spacecraft leaving the Solar System (docs/PROBES.md): each one's path from launch to where it
 * is at the date drawn (the planets' clock), and a small diamond there. Drawn while the Sun or the
 * probe is in the visible sphere and its path is large enough on screen.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  Line,
  LineBasicMaterial,
  PerspectiveCamera,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { probeIndex, probePosition, type ProbeCatalogue } from '../data/probes';
import { AU_PER_LY } from '../data/planets';

const PROBE_COLOR = 0x8fd8ff;

const diamondVertex = /* glsl */ `
uniform float uPx;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uPx;
}
`;
const diamondFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  vec2 c = abs(gl_PointCoord * 2.0 - 1.0);
  float d = c.x + c.y;
  if (d > 1.0) discard;
  gl_FragColor = vec4(uColor, uOpacity * (1.0 - smoothstep(0.8, 1.0, d)));
}
`;

/** A probe drawn this frame (for labels and picking). */
export interface DrawnProbe {
  index: number;
  pos: Vector3;
  alpha: number;
}

interface ProbeView {
  line: Line<BufferGeometry, LineBasicMaterial>;
  marker: Points<BufferGeometry, ShaderMaterial>;
}

/** Smooth step between e0 and e1. */
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

export class ProbeLayer {
  readonly group = new Group();
  drawn: DrawnProbe[] = [];
  private cat: ProbeCatalogue | null = null;
  private views: ProbeView[] = [];
  private readonly tmp = new Vector3();

  get catalogue(): ProbeCatalogue | null {
    return this.cat;
  }

  setCatalogue(cat: ProbeCatalogue): void {
    this.cat = cat;
    this.group.clear();
    this.views = cat.probes.map((probe) => {
      // the trajectory's points, plus one for the position at the date drawn
      const n = probe.t.length;
      const pts = new Float32Array(3 * (n + 1));
      pts.set(probe.p);
      const geo = new BufferGeometry();
      const attr = new BufferAttribute(pts, 3);
      attr.setUsage(DynamicDrawUsage);
      geo.setAttribute('position', attr);
      const line = new Line(geo, new LineBasicMaterial({ color: PROBE_COLOR, transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
      line.frustumCulled = false;
      line.renderOrder = 4;
      const marker = new Points(
        new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(3), 3)),
        new ShaderMaterial({
          vertexShader: diamondVertex,
          fragmentShader: diamondFragment,
          uniforms: { uPx: { value: 10 }, uColor: { value: new Color(PROBE_COLOR) }, uOpacity: { value: 0 } },
          transparent: true,
          depthTest: false,
          depthWrite: false,
        }),
      );
      marker.frustumCulled = false;
      marker.renderOrder = 6;
      this.group.add(line, marker);
      return { line, marker };
    });
  }

  /** The probe's position at the date drawn (as last updated). */
  position(i: number): Vector3 {
    return this.views[i]?.marker.position ?? new Vector3();
  }

  /**
   * Per frame: shown while the Sun or the probe is in the visible sphere (`target`, `radius`) and
   * the probe's distance from the Sun is at least 12 px on screen; `scale`: device pixels per unit size at unit distance.
   */
  update(target: Vector3, radius: number, camera: PerspectiveCamera, scale: number, pixelRatio: number, jd: number, show: boolean): void {
    this.drawn = [];
    const cat = this.cat;
    this.group.visible = show && !!cat;
    if (!cat || !show) return;
    const css = scale / pixelRatio;
    cat.probes.forEach((probe, i) => {
      const view = this.views[i];
      const pos = probePosition(probe, jd, this.tmp);
      // shown while the Sun or the probe is in the visible sphere
      const near = pos ? Math.min(target.length(), pos.distanceTo(target)) : Infinity;
      if (!pos || near > radius) {
        view.line.visible = view.marker.visible = false;
        return;
      }
      const fade = 1 - smoothstep(radius * 0.85, radius, near);
      // the path from the Sun to the probe, as large as it is on screen
      const camD = Math.max(camera.position.length(), 1e-12);
      const px = (pos.length() / camD) * css;
      const alpha = smoothstep(12, 40, px) * fade;
      view.line.visible = view.marker.visible = alpha > 0.01;
      if (!view.line.visible) return;
      // the path up to the date drawn
      const k = probeIndex(probe, jd);
      const attr = view.line.geometry.getAttribute('position') as BufferAttribute;
      attr.setXYZ(k + 1, pos.x, pos.y, pos.z);
      attr.needsUpdate = true;
      view.line.geometry.setDrawRange(0, k + 2);
      view.line.material.opacity = 0.55 * alpha;
      view.marker.position.copy(pos);
      view.marker.material.uniforms.uOpacity.value = alpha;
      view.marker.material.uniforms.uPx.value = 11 * pixelRatio;
      this.drawn.push({ index: i, pos: view.marker.position, alpha });
    });
  }
}

/** A probe's distance from the Sun in AU (for its card). */
export function probeDistanceAu(pos: Vector3): number {
  return pos.length() * AU_PER_LY;
}
