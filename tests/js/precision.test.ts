import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createStarMaterial, relativePositions, renderOrigin, setNodeView } from '../../src/render/starfield';

const f = Math.fround;
const PX_PER_RAD = 800 / (2 * Math.tan((55 * Math.PI) / 360)); // 800 px tall viewport, fov 55°

// root cube of the real data set (world frame), see manifest.json
const ROOT_CENTER = new Vector3(-4843.1104, -2038.1696, -3388.2112);
const ROOT_HALF = 65536;

/** Centre and half size of the octree node of the given depth that contains p. */
function nodeAt(p: Vector3, depth: number): { center: Vector3; half: number } {
  const center = ROOT_CENTER.clone();
  let half = ROOT_HALF;
  for (let d = 0; d < depth; d++) {
    half /= 2;
    center.x += p.x >= center.x ? half : -half;
    center.y += p.y >= center.y ? half : -half;
    center.z += p.z >= center.z ? half : -half;
  }
  return { center, half };
}

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('node render origin', () => {
  it('makes node-relative float32 positions exact, so CPU and GPU use the same star positions', () => {
    const rnd = rng(7);
    let checked = 0;
    for (let k = 0; k < 400; k++) {
      // stars from the Sun's vicinity out to 45,000 ly, at all octree depths
      const scale = 10 ** (rnd() * 4.7 - 0.5);
      const p = new Vector3((rnd() - 0.5) * scale, (rnd() - 0.5) * scale * 0.3, (rnd() - 0.5) * scale);
      for (const depth of [0, 1, 3, 5, 7, 9, 11]) {
        const { center, half } = nodeAt(p, depth);
        // more stars of the same node, including ones close to the node's faces and to the axes
        const pts: number[] = [];
        for (let j = 0; j < 20; j++) {
          for (const c of ['x', 'y', 'z'] as const) {
            const lo = Math.max(center[c] - half, -60_000);
            const hi = Math.min(center[c] + half, 60_000);
            pts.push(f(j === 0 ? p[c] : j === 1 ? lo : j === 2 ? hi : lo + (hi - lo) * rnd()));
          }
        }
        const positions = Float32Array.from(pts);
        const origin = renderOrigin(center, half);
        const before = origin.clone();
        const local = relativePositions(positions, origin);
        expect(origin.equals(before), `fallback needed at depth ${depth}`).toBe(true);
        const o = [origin.x, origin.y, origin.z];
        for (let i = 0; i < positions.length; i++) {
          expect(o[i % 3] + local[i]).toBe(positions[i]);
          expect(Math.abs(local[i])).toBeLessThanOrEqual(4 * half);
        }
        checked++;
      }
    }
    expect(checked).toBe(2800);
  });

  it('puts the root node at the Sun and deep nodes near their centres', () => {
    expect(renderOrigin(ROOT_CENTER, ROOT_HALF).toArray()).toEqual([0, 0, 0]);
    const { center, half } = nodeAt(new Vector3(7000, 300, -5000), 9);
    const o = renderOrigin(center, half);
    expect(o.distanceTo(center)).toBeLessThan(0.01);
  });

  it('falls back to origin 0 on an axis where a star lies outside its node', () => {
    const origin = renderOrigin(new Vector3(8000, 8000, 8000), 16);
    const positions = Float32Array.from([8000.5, 8001, 8002, 7990, 0.123456, 8010]);
    const local = relativePositions(positions, origin);
    expect(origin.y).toBe(0);
    expect(origin.x).not.toBe(0);
    for (let i = 0; i < positions.length; i++) expect([origin.x, origin.y, origin.z][i % 3] + local[i]).toBe(positions[i]);
  });
});

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

/**
 * Screen offset (px) between the star as the vertex shader computes it in float32 and its exact
 * view-space position, for a camera `camDist` from the star (orbit angle k).
 */
function errorPx(star: number[], depth: number, camDist: number, k: number): { shader: number; absolute: number } {
  const p = star.map(f); // positions are stored as float32
  const { center, half } = nodeAt(new Vector3(p[0], p[1], p[2]), depth);
  const origin = renderOrigin(center, half);
  const local = relativePositions(Float32Array.from(p), origin);

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

  // shader: rel = position - uCamLocal; mv = mat3(modelViewMatrix) * rel + uCamRest
  const material = createStarMaterial();
  setNodeView(material, cam, new Vector3(p[0], p[1], p[2]), origin);
  const cl = (material.uniforms.uCamLocal.value as Vector3).toArray().map(f);
  const rest = (material.uniforms.uCamRest.value as Vector3).toArray();
  const rel = [f(local[0] - cl[0]), f(local[1] - cl[1]), f(local[2] - cl[2])];
  // the rotation part of modelViewMatrix is the camera's (the node object is only translated)
  const mvShader = mulMat3(cam.matrixWorldInverse.elements, rel, rest);

  // the original shader: modelViewMatrix * vec4(position, 1.0) on absolute positions
  const e = cam.matrixWorldInverse.elements;
  const mvAbs = mulMat3(e, p, [e[12], e[13], e[14]]);
  return { shader: err(mvShader), absolute: err(mvAbs) };
}

function maxError(star: number[], depth: number, camDist: number) {
  let shader = 0;
  let absolute = 0;
  for (let k = 0; k < 60; k++) {
    const e = errorPx(star, depth, camDist, k);
    shader = Math.max(shader, e.shader);
    absolute = Math.max(absolute, e.absolute);
  }
  return { shader, absolute };
}

describe('star vertex precision', () => {
  it('keeps stars within half a pixel of their exact position at the closest zoom, at any node depth', () => {
    for (const D of [0, 8.6, 2000, 8000, 20_000, 41_390]) {
      const star = [D * 0.6, D * 0.3, -D * 0.74];
      for (const depth of [0, 2, 6, 11]) {
        const { shader } = maxError(star, depth, 0.02);
        expect(shader, `star at ${D} ly, depth ${depth}`).toBeLessThan(0.5);
      }
    }
  });

  it('is a real improvement over multiplying absolute positions by modelViewMatrix', () => {
    const { shader, absolute } = maxError([12_000, 6_000, -14_800], 0, 0.02);
    expect(absolute).toBeGreaterThan(10);
    expect(shader).toBeLessThan(0.5);
  });
});
