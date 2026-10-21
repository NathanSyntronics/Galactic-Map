import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { DesigCat, Flag, decodeNode, designationOf, spectralClassOf } from '../../src/data/format';
import { Octree, selectNodes, type Manifest } from '../../src/data/octree';

// Fixture written by pipeline/tests/make_js_fixture.py
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'data');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;

function loadRoot() {
  const octree = new Octree(manifest);
  const node = octree.root;
  const pack = readFileSync(join(dir, manifest.packs[node.pack]));
  const ab = pack.buffer.slice(pack.byteOffset + node.offset, pack.byteOffset + node.offset + node.bytes);
  const data = decodeNode(ab, node.path);
  return { octree, node, data };
}

describe('node decoding', () => {
  const { data } = loadRoot();
  const tol = 1e-6;

  it('decodes all stars of the fixture', () => {
    expect(data.count).toBe(4);
  });

  it('puts the Sun first and at the origin', () => {
    expect(data.flags[0] & Flag.SUN).toBeTruthy();
    for (let k = 0; k < 3; k++) expect(Math.abs(data.positions[k])).toBeLessThanOrEqual(tol);
    expect(data.names.get(0)).toEqual({ rank: 0, en: 'Sun', de: 'Sonne', alt: [] });
  });

  it('maps galactic (X, Y, Z) to world (X, Z, -Y)', () => {
    const i = [...Array(data.count).keys()].find((k) => data.names.get(k)?.en === 'Sirius')!;
    const p = new Vector3(data.positions[3 * i], data.positions[3 * i + 1], data.positions[3 * i + 2]);
    expect(p.x).toBeCloseTo(-5.0322, 5);
    expect(p.y).toBeCloseTo(-1.3418, 5);
    expect(p.z).toBeCloseTo(1.8735, 5);
    expect(designationOf(data, i)).toBe('HIP 32349');
    expect(data.names.get(i)?.alt).toEqual(['Alpha Canis Majoris A', 'HD 48915']);
    expect(data.systems.get(i)).toBe(7);
    expect(data.systemInfo.get(7)).toEqual({ nameEn: 'Sirius', nameDe: null, members: 2, primary: 'HIP 32349' });
    expect(data.spectralTypes.get(i)).toBe('A1V');
    expect(spectralClassOf(data.spec[i])).toBe('A1');
    expect(data.absMag[i]).toBe(142);
    expect(data.logL[i]).toBe(1400);
    expect(data.distErr[i]).toBe(1); // 0.4 % * 2, rounded
  });

  it('renders 64-bit Gaia ids and Tycho ids', () => {
    const designations = [...Array(data.count).keys()].map((k) => designationOf(data, k));
    expect(designations).toContain('Gaia DR3 5853498713190525696');
    const host = designations.indexOf('Gaia DR3 5853498713190525696');
    expect(data.planets.get(host)).toBe(2);
    expect(data.planets.size).toBe(1);
    expect(designations).toContain('TYC 9007-5848-1');
    const bd = [...Array(data.count).keys()].find((k) => data.desigCat[k] === DesigCat.TYC)!;
    expect(data.flags[bd] & Flag.BROWN_DWARF).toBeTruthy();
    expect(data.absMag[bd]).toBe(-32768);
    expect(data.distErr[bd]).toBe(255);
    expect(spectralClassOf(data.spec[bd])).toBe('T7');
  });
});

describe('node selection', () => {
  it('selects the root when the visibility sphere intersects it', () => {
    const octree = new Octree(manifest);
    const sel = selectNodes(octree, {
      cameraPos: new Vector3(0, 10, 50),
      target: new Vector3(0, 0, 0),
      radius: 50,
      budget: 1000,
      pixelsPerUnitAtUnitDistance: 1000,
    });
    expect(sel.map((n) => n.path)).toEqual(['r']);
  });

  it('selects nothing when the sphere is outside the data cube', () => {
    const octree = new Octree(manifest);
    const far = new Vector3(1e7, 0, 0);
    const sel = selectNodes(octree, {
      cameraPos: far,
      target: far,
      radius: 10,
      budget: 1000,
      pixelsPerUnitAtUnitDistance: 1000,
    });
    expect(sel).toEqual([]);
  });
});
