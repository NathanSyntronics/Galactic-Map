/**
 * Clip coordinates in units of the camera distance.
 *
 * Close to a planet the camera is a few millionths of a light year from what it looks at, and the
 * clip coordinates (x, y, z, w) the GPU receives are just as small. Some phone GPUs clamp a tiny
 * w, so what they draw stopped moving outwards below about a hundred million kilometres while the
 * labels (projected on the CPU) went on. Clip coordinates are homogeneous: multiplying the whole
 * projection by a factor draws the same picture, so it is scaled by 1 / camera distance and the
 * GPU always gets values around 1.
 */
import type { Material, PerspectiveCamera, WebGLProgramParametersWithUniforms } from 'three';

/** Scales the camera's projection (after updateProjectionMatrix) so that w is 1 at `distance`. */
export function scaleClipSpace(camera: PerspectiveCamera, distance: number): void {
  const k = 1 / Math.max(distance, 1e-12);
  camera.projectionMatrix.multiplyScalar(k);
  camera.projectionMatrixInverse.multiplyScalar(1 / k);
}

/** The perspective test of three.js's LineMaterial, which expects an entry of exactly -1. */
export const LINE_PERSPECTIVE_TEST = 'projectionMatrix[ 2 ][ 3 ] == - 1.0';

/** Lets a LineMaterial recognise the scaled perspective projection (the entry is -k, not -1). */
export function acceptScaledProjection(material: Material): void {
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.vertexShader = shader.vertexShader.replace(LINE_PERSPECTIVE_TEST, 'projectionMatrix[ 2 ][ 3 ] < 0.0');
  };
}
