import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createStarMaterial, setStarView } from '../../src/render/starfield';

// Emulates the star vertex shader's view transform in float32 (as the GPU computes it) and
// compares the result with the exact (double precision) view-space position.
const f = Math.fround;
const PX_PER_RAD = 800 / (2 * Math.tan((55 * Math.PI) / 360)); // 800 px tall viewport, fov 55°

/** mat3(m) * v + add, all in float32; m: column-major 4x4 elements. */
function mulMat3(m: number[], v: number[], add: number[]): number[] {
  const me = m.map(f);
  const out: number[] = [];
  for (let row = 0; row < 3; row++) {
    let acc = f(me[row] * v[0]);
    acc = f(acc + f(me[4 + row] * v[1]));
    acc = f(acc + f(me[8 + row] * v[2]));
    out.push(f(acc + f(add[row])));
  }
  return out;
}

function errorPx(star: number[], camDist: number, k: number): { shader: number; absolute: number } {
  const p = star.map(f); // positions are stored as float32
  const cam = new PerspectiveCamera(55, 1.6, 0.001, 1e6);
  const th = k * 0.37;
  const ph = 1 + 0.3 * Math.sin(k);
  cam.position.set(
    p[0] + camDist * Math.sin(ph) * Math.cos(th),
    p[1] + camDist * Math.cos(ph),
    p[2] + camDist * Math.sin(ph) * Math.sin(th),
  );
  cam.lookAt(p[0], p[1], p[2]);
  cam.updateMatrixWorld();
  const exact = new Vector3(p[0], p[1], p[2]).applyMatrix4(cam.matrixWorldInverse);
  const err = (mv: number[]) => (Math.hypot(mv[0] - exact.x, mv[1] - exact.y) / camDist) * PX_PER_RAD;

  // new shader: rel = position - uOrigin; mv = mat3(modelViewMatrix) * rel + uOriginView
  const material = createStarMaterial();
  setStarView(material, cam, new Vector3(p[0], p[1], p[2]));
  const o = (material.uniforms.uOrigin.value as Vector3).toArray().map(f);
  const ov = (material.uniforms.uOriginView.value as Vector3).toArray();
  const rel = [f(p[0] - o[0]), f(p[1] - o[1]), f(p[2] - o[2])];
  const mvShader = mulMat3(cam.matrixWorldInverse.elements, rel, ov);

  // previous shader: modelViewMatrix * vec4(position, 1.0)
  const e = cam.matrixWorldInverse.elements;
  const mvAbs = mulMat3(e, p, [e[12], e[13], e[14]]);
  return { shader: err(mvShader), absolute: err(mvAbs) };
}

function maxError(star: number[], camDist: number) {
  let shader = 0;
  let absolute = 0;
  for (let k = 0; k < 60; k++) {
    const e = errorPx(star, camDist, k);
    shader = Math.max(shader, e.shader);
    absolute = Math.max(absolute, e.absolute);
  }
  return { shader, absolute };
}

describe('star vertex precision', () => {
  it('keeps distant stars within half a pixel of their exact position at the closest zoom', () => {
    for (const D of [0, 8.6, 2000, 8000, 20_000, 41_390]) {
      const star = [D * 0.6, D * 0.3, -D * 0.74];
      const { shader } = maxError(star, 0.02);
      expect(shader, `star at ${D} ly`).toBeLessThan(0.5);
    }
  });

  it('is a real improvement over multiplying absolute positions by modelViewMatrix', () => {
    const { shader, absolute } = maxError([12_000, 6_000, -14_800], 0.02);
    expect(absolute).toBeGreaterThan(10);
    expect(shader).toBeLessThan(0.5);
  });
});
