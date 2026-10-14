// Star colours from effective temperature: Planck spectrum integrated against the CIE 1931
// colour-matching functions (analytic multi-lobe fit by Wyman, Sloan & Shirley 2013),
// converted to sRGB (D65) and normalised to the brightest channel.

function g(x: number, mu: number, s1: number, s2: number): number {
  const s = x < mu ? s1 : s2;
  const t = (x - mu) / s;
  return Math.exp(-0.5 * t * t);
}

function cie(lambdaNm: number): [number, number, number] {
  const x = 1.056 * g(lambdaNm, 599.8, 37.9, 31.0) + 0.362 * g(lambdaNm, 442.0, 16.0, 26.7) - 0.065 * g(lambdaNm, 501.1, 20.4, 26.2);
  const y = 0.821 * g(lambdaNm, 568.8, 46.9, 40.5) + 0.286 * g(lambdaNm, 530.9, 16.3, 31.1);
  const z = 1.217 * g(lambdaNm, 437.0, 11.8, 36.0) + 0.681 * g(lambdaNm, 459.0, 26.0, 13.8);
  return [x, y, z];
}

const C2 = 1.4387769e-2; // hc/k in m*K

function planck(lambdaNm: number, t: number): number {
  const l = lambdaNm * 1e-9;
  return 1 / (Math.pow(l, 5) * (Math.exp(C2 / (l * t)) - 1));
}

function gammaEncode(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** sRGB colour (0..1) of a black body at temperature t (K), normalised to max channel = 1. */
export function blackbodyRGB(t: number): [number, number, number] {
  let X = 0;
  let Y = 0;
  let Z = 0;
  for (let l = 380; l <= 780; l += 5) {
    const p = planck(l, t);
    const [x, y, z] = cie(l);
    X += p * x;
    Y += p * y;
    Z += p * z;
  }
  let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  let gg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  let b = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  r = Math.max(r, 0);
  gg = Math.max(gg, 0);
  b = Math.max(b, 0);
  const m = Math.max(r, gg, b) || 1;
  return [gammaEncode(r / m), gammaEncode(gg / m), gammaEncode(b / m)];
}

const LUT_MIN = 300;
const LUT_MAX = 50000;
const LUT_SIZE = 512;
const lut = new Float32Array(LUT_SIZE * 3);
const logMin = Math.log(LUT_MIN);
const logMax = Math.log(LUT_MAX);
for (let i = 0; i < LUT_SIZE; i++) {
  const t = Math.exp(logMin + ((logMax - logMin) * i) / (LUT_SIZE - 1));
  const [r, g2, b] = blackbodyRGB(t);
  lut[3 * i] = r;
  lut[3 * i + 1] = g2;
  lut[3 * i + 2] = b;
}

/**
 * Colour for temperature t with optional saturation boost (1 = physical colour).
 * Writes 0..255 values into out[offset..offset+2].
 */
export function temperatureColor(t: number, saturation: number, out: Uint8Array, offset: number): void {
  const tt = Math.min(Math.max(t, LUT_MIN), LUT_MAX);
  const f = ((Math.log(tt) - logMin) / (logMax - logMin)) * (LUT_SIZE - 1);
  const i = Math.min(Math.floor(f), LUT_SIZE - 2);
  const w = f - i;
  let r = lut[3 * i] * (1 - w) + lut[3 * i + 3] * w;
  let g2 = lut[3 * i + 1] * (1 - w) + lut[3 * i + 4] * w;
  let b = lut[3 * i + 2] * (1 - w) + lut[3 * i + 5] * w;
  if (saturation !== 1) {
    const l = 0.2126 * r + 0.7152 * g2 + 0.0722 * b;
    r = l + (r - l) * saturation;
    g2 = l + (g2 - l) * saturation;
    b = l + (b - l) * saturation;
    const m = Math.max(r, g2, b, 1e-6);
    r = Math.max(r / m, 0);
    g2 = Math.max(g2 / m, 0);
    b = Math.max(b / m, 0);
  }
  out[offset] = Math.round(r * 255);
  out[offset + 1] = Math.round(g2 * 255);
  out[offset + 2] = Math.round(b * 255);
}

/** CSS colour string for a temperature (for UI swatches). */
export function temperatureCss(t: number, saturation = 1.4): string {
  const tmp = new Uint8Array(3);
  temperatureColor(t, saturation, tmp, 0);
  return `rgb(${tmp[0]}, ${tmp[1]}, ${tmp[2]})`;
}
