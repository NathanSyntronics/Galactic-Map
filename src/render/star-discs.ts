/**
 * Stars at their true size close up. A star's symbol has a fixed size on screen; once its real
 * disc would look at least as large as the symbol's bright core, the real disc is drawn over it
 * (limb darkened, in the star's colour): Betelgeuse a few AU across, the Sun a hundredth of an AU.
 * Only the few nearest such stars are drawn (they are found on the CPU, see App.updateStarDiscs).
 */
import { Color, Group, Mesh, PlaneGeometry, ShaderMaterial, Vector3, type Camera } from 'three';
import { Flag, UNKNOWN_I16, type NodeData } from '../data/format';

/** The Sun's radius in light years. */
export const SOLAR_RADIUS_LY = 6.957e8 / 9.4607304725808e15;
const SUN_TEFF = 5772;

/**
 * True radius (ly) of star i: from its luminosity and temperature (Stefan–Boltzmann: R ∝ √L / T²),
 * without a temperature from the luminosity along the main sequence (R ∝ L^0.25), white and brown
 * dwarfs at their typical sizes.
 */
export function starRadiusLy(node: NodeData, i: number): number {
  const f = node.flags[i];
  if (f & Flag.SUN) return SOLAR_RADIUS_LY;
  const l = node.logL[i];
  const m = node.absMag[i];
  const logL = l !== UNKNOWN_I16 ? l / 1000 : m !== UNKNOWN_I16 ? (4.74 - m / 100) / 2.5 : null;
  const teff = node.teff[i];
  if (logL !== null && teff > 0) return SOLAR_RADIUS_LY * Math.sqrt(10 ** logL) * (SUN_TEFF / teff) ** 2;
  if (f & Flag.WHITE_DWARF) return 0.012 * SOLAR_RADIUS_LY;
  if (f & Flag.BROWN_DWARF) return 0.1 * SOLAR_RADIUS_LY;
  return SOLAR_RADIUS_LY * 10 ** (0.25 * (logL ?? -1.5));
}

/** A star to draw at its true size this frame. */
export interface StarDisc {
  pos: Vector3;
  /** True radius (ly). */
  radius: number;
  /** Colour as the map draws the star (0..1). */
  color: [number, number, number];
  alpha: number;
}

/** At most this many discs at once (the largest on screen). */
export const MAX_DISCS = 8;
/** The plane reaches this far beyond the disc, for a thin glow. */
const GLOW = 1.25;

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uDisc;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float x = r / uDisc;
  float fw = max(fwidth(x), 1e-4);
  float inside = 1.0 - smoothstep(1.0 - fw, 1.0 + fw, x);
  float mu = sqrt(max(1.0 - x * x, 0.0));
  // limb darkening: the edge dimmer and redder than the centre
  vec3 disc = mix(uColor, vec3(1.0), 0.45 * mu) * (0.45 + 0.55 * mu);
  float glow = exp(-max(x - 1.0, 0.0) * 14.0) * 0.35 * (1.0 - inside);
  vec3 col = mix(uColor, disc, inside);
  gl_FragColor = vec4(col, (inside + glow) * uAlpha);
}
`;

export class StarDiscLayer {
  readonly group = new Group();
  private readonly meshes: Mesh<PlaneGeometry, ShaderMaterial>[] = [];

  constructor() {
    this.group.renderOrder = 3;
    const geo = new PlaneGeometry(2, 2);
    for (let k = 0; k < MAX_DISCS; k++) {
      const mesh = new Mesh(
        geo,
        new ShaderMaterial({
          vertexShader,
          fragmentShader,
          uniforms: { uColor: { value: new Color() }, uAlpha: { value: 0 }, uDisc: { value: 1 / GLOW } },
          transparent: true,
          depthTest: false,
          depthWrite: false,
        }),
      );
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /** Draws the given discs (facing the camera). */
  update(discs: StarDisc[], camera: Camera): void {
    this.meshes.forEach((mesh, k) => {
      const d = discs[k];
      mesh.visible = !!d && d.alpha > 0.01;
      if (!mesh.visible) return;
      mesh.position.copy(d.pos);
      mesh.quaternion.copy(camera.quaternion);
      mesh.scale.setScalar(d.radius * GLOW);
      const u = mesh.material.uniforms;
      (u.uColor.value as Color).setRGB(d.color[0], d.color[1], d.color[2]);
      u.uAlpha.value = d.alpha;
    });
  }
}
