/**
 * The stars' light in a half-float buffer (where the device can render to one): additive blending
 * into the 8-bit screen clips a crowded view to white and loses the faint stars' small shares
 * (below 1/255), so with millions of stars in view everything merged into one bright blob. The
 * stars are drawn into the buffer instead and composited onto the screen with a soft shoulder:
 * light up to SHOULDER passes unchanged, more is compressed towards white, so that dense regions
 * keep their structure.
 */
import {
  AdditiveBlending,
  Color,
  HalfFloatType,
  NoBlending,
  UnsignedByteType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type Object3D,
  type WebGLRenderer,
} from 'three';

/** Light up to this level is drawn as it is; above it, compressed. */
export const SHOULDER = 0.6;

/** The tone curve (per pixel, on its brightest channel): linear up to SHOULDER, then towards 1. */
export function toneCurve(m: number): number {
  return m <= SHOULDER ? m : SHOULDER + (1 - SHOULDER) * (1 - Math.exp(-(m - SHOULDER) / (1 - SHOULDER)));
}

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D tStars;
uniform float uExposure;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tStars, vUv).rgb * uExposure;
  float m = max(max(c.r, c.g), c.b);
  if (m <= 0.0) discard;
  float k = ${SHOULDER.toFixed(2)};
  float t = m <= k ? m : k + (1.0 - k) * (1.0 - exp(-(m - k) / (1.0 - k)));
  gl_FragColor = vec4(c * (t / m), 1.0);
}
`;

/**
 * The faintest stars' brightness floor for `inView` stars in view: 0.55 at 2,500 stars, falling with
 * the square root of the count. Drawn directly onto the screen it stops at 0.035 (smaller shares
 * vanish in the 8-bit screen); in the half-float buffer it keeps falling.
 */
export function minStarAlpha(inView: number, buffered: boolean): number {
  const n = Math.max(inView, 1);
  const a = Math.min(0.55 * Math.sqrt(2500 / n), 0.55);
  return buffered ? a : Math.max(a, 0.035);
}

/**
 * Brightness factor of the point-like stars (drawn at the smallest size) with `inView` stars in
 * view: 1 up to 100,000, then (100,000 / n)^0.6 (2 million: 0.17), so that their light together
 * grows only slowly with their number. Only in the half-float buffer (else 1).
 */
export function crowdFactor(inView: number, buffered: boolean): number {
  if (!buffered || inView <= 100_000) return 1;
  return (100_000 / inView) ** 0.6;
}

/** Whether the renderer can draw into a half-float buffer. */
export function halfFloatSupported(renderer: WebGLRenderer): boolean {
  return renderer.capabilities.isWebGL2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
}

/** Blocks across and down of the light measured for the exposure. */
const METER = 32;
/** Highest block average the meter's 8-bit cells hold (log2(1 + light) / METER_LOG). */
const METER_LOG = 6;

// the block average of the light (brightest channel), 4 x 4 samples per block, log-encoded
const meterShader = /* glsl */ `
uniform sampler2D tStars;
varying vec2 vUv;
void main() {
  float sum = 0.0;
  for (int i = 0; i < 4; i++) {
    for (int j = 0; j < 4; j++) {
      vec2 o = (vec2(float(i), float(j)) - 1.5) / (4.0 * ${METER}.0);
      vec3 c = texture2D(tStars, vUv + o).rgb;
      sum += max(max(c.r, c.g), c.b);
    }
  }
  gl_FragColor = vec4(clamp(log2(1.0 + sum / 16.0) / ${METER_LOG}.0, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

/** Exposure is lowered once the screen's bright blocks average more light than this. */
export const EXPOSURE_TARGET = 0.4;

/**
 * Exposure for a measured light (the 6th brightest of the METER x METER blocks): 1 while it stays
 * below EXPOSURE_TARGET (every ordinary view measures up to about 0.35), else lowered so that it
 * reaches the target (the dense region around the Sun seen from thousands of light years: about
 * 1), down to 0.04.
 */
export function exposureFor(blockLight: number): number {
  return Math.min(Math.max(EXPOSURE_TARGET / Math.max(blockLight, 1e-6), 0.04), 1);
}

export class StarBuffer {
  readonly scene = new Scene();
  /** The composite: a screen-filling quad in the main scene (where the stars were drawn). */
  readonly quad: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter });
  private readonly size = new Vector2();
  private readonly clearColor = new Color();
  /** Exposure of the composite (follows the measured light, see exposureFor). */
  exposure = 1;
  /** The light of the brightest block at the last measurement. */
  light = 0;
  private readonly meter = new WebGLRenderTarget(METER, METER, { type: UnsignedByteType, depthBuffer: false });
  private readonly meterScene = new Scene();
  private readonly meterQuad: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly meterPixels = new Uint8Array(METER * METER * 4);
  private metering = false;
  private lastMeter = 0;
  private meterBroken = false;

  constructor(stars: Object3D) {
    this.scene.add(stars);
    this.quad = new Mesh(
      new PlaneGeometry(2, 2),
      new ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: { tStars: { value: this.target.texture }, uExposure: { value: 1 } },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    this.quad.frustumCulled = false;
    this.quad.renderOrder = 0;
    this.meterQuad = new Mesh(
      new PlaneGeometry(2, 2),
      new ShaderMaterial({ vertexShader, fragmentShader: meterShader, uniforms: { tStars: { value: this.target.texture } }, blending: NoBlending, depthTest: false, depthWrite: false }),
    );
    this.meterQuad.frustumCulled = false;
    this.meterScene.add(this.meterQuad);
  }

  /**
   * A few times a second: the light of the last frame in METER x METER blocks, read back without
   * waiting for the GPU; the exposure follows it smoothly.
   */
  private measure(renderer: WebGLRenderer, now: number): void {
    if (this.meterBroken || this.metering || now - this.lastMeter < 300) return;
    this.lastMeter = now;
    renderer.setRenderTarget(this.meter);
    renderer.render(this.meterScene, this.cameraStub);
    renderer.setRenderTarget(null);
    this.metering = true;
    renderer
      .readRenderTargetPixelsAsync(this.meter, 0, 0, METER, METER, this.meterPixels)
      .then(() => {
        // the 6th brightest block: a dense region covers many, a single bright star's glow a few
        const top = [0, 0, 0, 0, 0, 0];
        for (let k = 0; k < this.meterPixels.length; k += 4) {
          const v = this.meterPixels[k];
          if (v <= top[5]) continue;
          let j = 5;
          while (j > 0 && top[j - 1] < v) {
            top[j] = top[j - 1];
            j--;
          }
          top[j] = v;
        }
        const light = 2 ** ((top[5] / 255) * METER_LOG) - 1;
        this.light = light;
        const target = exposureFor(light);
        // down quickly, up slowly (as eyes adapt)
        this.exposure += (target - this.exposure) * (target < this.exposure ? 0.6 : 0.3);
        this.quad.material.uniforms.uExposure.value = this.exposure;
      })
      .catch(() => {
        this.meterBroken = true;
      })
      .finally(() => {
        this.metering = false;
      });
  }

  /** (the meter's quad ignores the camera) */
  private readonly cameraStub = new OrthographicCamera();

  /** Draws the stars into the buffer (before the main scene is rendered). */
  render(renderer: WebGLRenderer, camera: Camera): void {
    renderer.getDrawingBufferSize(this.size);
    if (this.target.width !== this.size.x || this.target.height !== this.size.y) this.target.setSize(this.size.x, this.size.y);
    const clear = renderer.getClearColor(this.clearColor);
    const alpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.scene, camera);
    renderer.setRenderTarget(null);
    renderer.setClearColor(clear, alpha);
    this.measure(renderer, performance.now());
  }
}
