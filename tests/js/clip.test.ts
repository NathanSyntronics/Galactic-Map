import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LINE_PERSPECTIVE_TEST, depthOfClipW, scaleClipSpace } from '../../src/render/clip';

describe('clip coordinates scaled to the camera distance', () => {
  const camera = (d: number) => {
    const c = new PerspectiveCamera(55, 0.5, d * 1e-4, d + 1000);
    c.position.set(0.3 * d, 0.8 * d, 0.5 * d);
    c.lookAt(0, 0, 0);
    c.updateMatrixWorld();
    c.updateProjectionMatrix();
    return c;
  };

  it('draws the same picture with w of about 1 at the view centre', () => {
    const d = 1.4e-5;
    const a = camera(d);
    const b = camera(d);
    scaleClipSpace(b, d);
    // Mercury's distance (0.39 AU) to one side of the Sun
    const p = new Vector3(6.1e-6, 0, 0);
    expect(p.clone().project(b).distanceTo(p.clone().project(a))).toBeLessThan(1e-9);
    const clip = p.clone().applyMatrix4(b.matrixWorldInverse);
    const w = -clip.z * -b.projectionMatrix.elements[11];
    expect(w).toBeGreaterThan(0.5);
    expect(w).toBeLessThan(2);
    // unprojecting stays consistent
    const back = p.clone().project(b).unproject(b);
    expect(back.distanceTo(p)).toBeLessThan(1e-12);
  });

  it('gives back the view depth from the scaled clip w (picking: sizes on screen)', () => {
    const cam = new PerspectiveCamera(60, 1, 1e-3, 1e12);
    cam.position.set(0, 0, 5e8);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    scaleClipSpace(cam, 5e8);
    // clip w of a point 5e8 ahead (row 4 of the projection times its view position): 1 after the scaling
    const view = new Vector3(1e7, 0, 0).applyMatrix4(cam.matrixWorldInverse);
    const e = cam.projectionMatrix.elements;
    const w = e[3] * view.x + e[7] * view.y + e[11] * view.z + e[15];
    expect(w).toBeCloseTo(1, 9);
    // its depth is 5e8
    expect(depthOfClipW(cam, w)).toBeCloseTo(5e8, 0);
  });

  it('finds the perspective test in three.js line shader', () => {
    expect(new LineMaterial().vertexShader).toContain(LINE_PERSPECTIVE_TEST);
  });
});
