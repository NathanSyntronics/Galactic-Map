/**
 * Benchmark of the route planning core (src/network/route.ts) in Node: a synthetic 500 ly corridor
 * with 0.003 places per ly³, and the real corridor from the Sun to Betelgeuse in public/data.
 * Run: npm run bench:route (tools/bench-route.mjs).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNode } from '../src/data/format';
import { Octree, type Manifest } from '../src/data/octree';
import { nodesInCapsule, segmentDistance2, type Vec3 } from '../src/network/capsule';
import { capacityFromLogL, computeJumpLinks } from '../src/network/jumps';
import { MAX_PAIRS, MAX_PLACES, computeNetwork, placeOfStar, type PlaceSource } from '../src/network/places';
import { corridorWidths, findPath, networkWidth, planRoute, type CorridorGraph, type RouteMode } from '../src/network/route';
import { computeStyle } from '../src/render/starfield';
import { DEFAULT_SETTINGS } from '../src/settings';
import { SearchIndex, type SearchTuple } from '../src/ui/search';

const S = DEFAULT_SETTINGS;
const RANGE = S.jumpRange;
const DENSITY = 0.003;
const LENGTH = 500;
const MODES: RouteMode[] = ['jumps', 'distance'];

function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Median time of `runs` calls in ms, and the last result. */
function time<T>(runs: number, f: () => T): { ms: number; value: T } {
  const times: number[] = [];
  let value!: T;
  for (let k = 0; k < runs; k++) {
    const t0 = performance.now();
    value = f();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { ms: times[Math.floor(runs / 2)], value };
}

const f1 = (x: number) => x.toFixed(1);

/** log10 L of a random star of the solar neighbourhood (rough mix of brown, white, M, K, G, F, A dwarfs). */
function randomLogL(r: () => number): number {
  const u = r();
  const between = (a: number, b: number) => a + (b - a) * r();
  if (u < 0.1) return between(-5.5, -4.5);
  if (u < 0.16) return between(-4, -2.5);
  if (u < 0.81) return between(-3.5, -1.2);
  if (u < 0.92) return between(-1.2, -0.4);
  if (u < 0.97) return between(-0.4, 0.3);
  if (u < 0.995) return between(0.3, 0.8);
  return between(1, 2.5);
}

interface Synthetic {
  positions: Float64Array;
  capacities: Int32Array;
  keys: Float64Array;
  count: number;
}

/**
 * Places at DENSITY in the capsule of `radius` around (0, 0, 0)–(LENGTH, 0, 0); start and goal at
 * the ends. `voidRadius` empties a sphere around the middle of the segment.
 */
function synthetic(seed: number, radius: number, voidRadius = 0): Synthetic {
  const r = rng(seed);
  const a = { x: 0, y: 0, z: 0 }, b = { x: LENGTH, y: 0, z: 0 };
  const volume = Math.PI * radius * radius * LENGTH + (4 / 3) * Math.PI * radius ** 3;
  const n = Math.round(DENSITY * volume);
  const xyz: number[] = [0, 0, 0, LENGTH, 0, 0];
  const caps: number[] = [capacityFromLogL(0, S.jumpFaint, S.jumpSun, S.jumpBright), capacityFromLogL(4.9, S.jumpFaint, S.jumpSun, S.jumpBright)];
  while (caps.length < n) {
    const x = -radius + r() * (LENGTH + 2 * radius), y = (2 * r() - 1) * radius, z = (2 * r() - 1) * radius;
    if (segmentDistance2(x, y, z, a, b) > radius * radius) continue;
    if (voidRadius > 0 && Math.hypot(x - LENGTH / 2, y, z) < voidRadius) continue;
    xyz.push(x, y, z);
    caps.push(capacityFromLogL(randomLogL(r), S.jumpFaint, S.jumpSun, S.jumpBright));
  }
  return {
    count: caps.length,
    positions: new Float64Array(xyz),
    capacities: Int32Array.from(caps),
    keys: Float64Array.from(caps, (_, i) => i),
  };
}

/** The places of `all` within `radius` of the segment (as the app takes a corridor's stars). */
function within(all: Synthetic, from: Vec3, to: Vec3, radius: number): Synthetic & { start: number; goal: number } {
  const keep: number[] = [];
  const p = all.positions;
  for (let i = 0; i < all.count; i++) if (segmentDistance2(p[3 * i], p[3 * i + 1], p[3 * i + 2], from, to) <= radius * radius) keep.push(i);
  return {
    count: keep.length,
    positions: Float64Array.from(keep.flatMap((i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]])),
    capacities: Int32Array.from(keep, (i) => all.capacities[i]),
    keys: Float64Array.from(keep, (i) => all.keys[i]),
    start: keep.indexOf(0),
    goal: keep.indexOf(1),
  };
}

function syntheticTable(): string[] {
  const out: string[] = [];
  const from = { x: 0, y: 0, z: 0 }, to = { x: LENGTH, y: 0, z: 0 };
  out.push(`## Synthetic corridor: ${LENGTH} ly, ${DENSITY} places/ly³, range ${RANGE} ly, links ${S.jumpFaint}/${S.jumpSun}/${S.jumpBright}`);
  out.push('');
  out.push('| w | network width | places | pairs | network ms | search places | jumps: jumps, ly, ms | distance: jumps, ly, ms |');
  out.push('|---|---|---|---|---|---|---|---|');
  const widest = networkWidth(Math.max(...corridorWidths(RANGE)), RANGE);
  const all = synthetic(1, widest);
  for (const w of corridorWidths(RANGE)) {
    const c = within(all, from, to, networkWidth(w, RANGE));
    const row = [`${w}`, `${networkWidth(w, RANGE)}`, `${c.count}`];
    const net = time(3, () => computeJumpLinks(c, { range: RANGE, hub: S.jumpHub, kSun: S.jumpSun, connect: S.jumpConnect, maxCandidates: MAX_PAIRS }));
    row.push(net.value.overflow ? `> ${MAX_PAIRS}` : `${net.value.candidates}`, f1(net.ms));
    if (c.count > MAX_PLACES || net.value.overflow) row[row.length - 1] += ' (over the limit)';
    const g = { count: c.count, positions: c.positions, keys: c.keys, links: net.value };
    let searched = 0;
    const cells: string[] = [];
    for (const mode of MODES) {
      const s = time(5, () => findPath(g, c.start, c.goal, { mode, corridor: { from, to, width: w } }));
      searched = s.value.searched;
      cells.push(s.value.found ? `${s.value.jumps}, ${f1(s.value.total)}, ${s.ms.toFixed(2)}` : `none, ${s.ms.toFixed(2)}`);
    }
    out.push(`| ${[...row, `${searched}`, ...cells].join(' | ')} |`);
  }
  return out;
}

async function planningBench(out: string[]): Promise<void> {
  const from = { x: 0, y: 0, z: 0 }, to = { x: LENGTH, y: 0, z: 0 };
  const widest = networkWidth(Math.max(...corridorWidths(RANGE)), RANGE);
  const cases: { name: string; all: Synthetic; range: number }[] = [
    { name: `uniform, range ${RANGE} ly`, all: synthetic(1, widest), range: RANGE },
    { name: `empty sphere of 25 ly radius in the middle, range ${RANGE} ly`, all: synthetic(2, widest, 25), range: RANGE },
    { name: 'uniform, range 2 ly (unreachable)', all: synthetic(3, networkWidth(128, 2)), range: 2 },
  ];
  out.push('');
  out.push('Whole planning runs (`planRoute`, mode fewest jumps; the corridor places are cut from a pre-made cloud):');
  out.push('');
  out.push('| case | status | widths tried | places of the last network | network ms | search ms | jumps | ly |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const k of cases) {
    let networkMs = 0;
    let places = 0;
    const t0 = performance.now();
    let cutMs = 0;
    const plan = await planRoute<CorridorGraph>({ from, to, range: k.range, mode: 'jumps' }, (c) => {
      const tc = performance.now();
      const sub = within(k.all, from, to, c.networkWidth);
      cutMs += performance.now() - tc;
      places = sub.count;
      if (sub.count > MAX_PLACES) return { refused: 'places' };
      const t = performance.now();
      const links = computeJumpLinks(sub, { range: k.range, hub: S.jumpHub, kSun: S.jumpSun, connect: S.jumpConnect, maxCandidates: MAX_PAIRS });
      networkMs += performance.now() - t;
      if (links.overflow) return { refused: 'pairs' };
      return { count: sub.count, positions: sub.positions, keys: sub.keys, links, start: sub.start, goal: sub.goal };
    });
    const searchMs = performance.now() - t0 - networkMs - cutMs;
    const path = 'route' in plan && plan.route ? plan.route.path : null;
    const status = plan.status === 'refused' ? `refused (${plan.reason}) at w = ${plan.width}` : plan.status;
    out.push(
      `| ${k.name} | ${status} | ${plan.tried.join(', ')} | ${places} | ${f1(networkMs)} | ${searchMs.toFixed(2)} | ${path?.found ? path.jumps : '–'} | ${path?.found ? f1(path.total) : `closest ${f1(path?.closestDistance ?? NaN)} ly short`} |`,
    );
  }
}

/** The real corridor from the Sun to Betelgeuse, loaded and styled like the app with the default settings. */
async function realBench(root: string, out: string[]): Promise<void> {
  const dataDir = join(root, 'public', 'data');
  if (!existsSync(join(dataDir, 'manifest.json'))) {
    out.push('', '(public/data missing: real corridor skipped)');
    return;
  }
  const manifest = JSON.parse(readFileSync(join(dataDir, 'manifest.json'), 'utf8')) as Manifest;
  const octree = new Octree(manifest);
  const ordinal = new Map<string, number>();
  let k = 0;
  for (const path of octree.nodes.keys()) ordinal.set(path, k++);
  const packs = new Map<number, Buffer>();
  const plan = { color: null, size: null, missing: S.missingStyle };
  const cache = new Map<string, PlaceSource>();
  const load = (path: string): PlaceSource => {
    let s = cache.get(path);
    if (s) return s;
    const node = octree.nodes.get(path)!;
    let pack = packs.get(node.pack);
    if (!pack) packs.set(node.pack, (pack = readFileSync(join(dataDir, manifest.packs[node.pack]))));
    const data = decodeNode(pack.buffer.slice(pack.byteOffset + node.offset, pack.byteOffset + node.offset + node.bytes) as ArrayBuffer, path);
    const colors = new Uint8Array(3 * data.count);
    const sizes = new Float32Array(data.count);
    computeStyle(data, S, plan, colors, sizes);
    cache.set(path, (s = { data, sizes, colors }));
    return s;
  };

  const index = new SearchIndex();
  index.load(JSON.parse(readFileSync(join(dataDir, 'search.json'), 'utf8')) as SearchTuple[]);
  const star = (name: string) => {
    const e = index.find(name);
    if (!e) throw new Error(`${name} not found`);
    const d = load(e[2]).data;
    const i = e[3];
    return { path: e[2], i, pos: { x: d.positions[3 * i], y: d.positions[3 * i + 1], z: d.positions[3 * i + 2] } };
  };
  const sun = star('Sun'), bet = star('Betelgeuse');
  const length = Math.hypot(bet.pos.x - sun.pos.x, bet.pos.y - sun.pos.y, bet.pos.z - sun.pos.z);
  out.push('', `## Real data: Sun → Betelgeuse (${f1(length)} ly), default settings`, '');
  out.push('| w | network width | nodes | MB | stars | load + style ms | places | pairs | network ms | jumps: jumps, ly, ms | distance: jumps, ly, ms |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const w of corridorWidths(RANGE)) {
    const nw = networkWidth(w, RANGE);
    const nodes = nodesInCapsule(octree.root, sun.pos, bet.pos, nw);
    const bytes = nodes.reduce((s, n) => s + n.bytes, 0);
    const stars = nodes.reduce((s, n) => s + n.count, 0);
    const tl = performance.now();
    const sources = nodes.map((n) => load(n.path));
    const loadMs = performance.now() - tl;
    const net = time(3, () =>
      computeNetwork(sources, {
        centre: sun.pos,
        to: bet.pos,
        radius: nw,
        capacity: { by: 'luminosity', faint: S.jumpFaint, sun: S.jumpSun, bright: S.jumpBright },
        nodeKey: (p) => ordinal.get(p) ?? 0,
        maxPlaces: MAX_PLACES,
        range: RANGE,
        hub: S.jumpHub,
        kSun: S.jumpSun,
        connect: S.jumpConnect,
        maxCandidates: MAX_PAIRS,
      }),
    );
    const row = [`${w}`, `${nw}`, `${nodes.length}`, (bytes / 1e6).toFixed(1), `${stars}`, f1(loadMs)];
    const { places, links } = net.value;
    if (net.value.overflow) {
      out.push(`| ${row.join(' | ')} | ${places.count} | ${links.candidates || '–'} | refused (${net.value.overflow}) | | |`);
      continue;
    }
    row.push(`${places.count}`, `${links.candidates}`, f1(net.ms));
    const g = { count: places.count, positions: places.positions, keys: places.keys, links };
    const s0 = placeOfStar(places, sun.path, sun.i), s1 = placeOfStar(places, bet.path, bet.i);
    for (const mode of MODES) {
      const s = time(5, () => findPath(g, s0, s1, { mode, corridor: { from: sun.pos, to: bet.pos, width: w } }));
      row.push(s.value.found ? `${s.value.jumps}, ${f1(s.value.total)}, ${s.ms.toFixed(2)}` : `none (closest ${f1(s.value.closestDistance)} ly away), ${s.ms.toFixed(2)}`);
    }
    out.push(`| ${row.join(' | ')} |`);
  }

  // whole planning runs as the app would do them (nodes already decoded above stay cached)
  out.push('', 'Whole planning runs from the Sun (`planRoute`, corridor nodes via `nodesInCapsule`, network via `computeNetwork` with `to`):', '');
  out.push('| destination | straight ly | mode | status | widths tried | load ms | network ms | search ms | jumps | ly |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const name of ['Vega', 'Pollux', 'Arcturus', 'Betelgeuse']) {
    const dest = star(name);
    const straight = Math.hypot(dest.pos.x - sun.pos.x, dest.pos.y - sun.pos.y, dest.pos.z - sun.pos.z);
    for (const mode of MODES) {
      let loadMs = 0, networkMs = 0;
      const t0 = performance.now();
      const plan = await planRoute<CorridorGraph>({ from: sun.pos, to: dest.pos, range: RANGE, mode }, (c) => {
        const tl = performance.now();
        const sources = nodesInCapsule(octree.root, sun.pos, dest.pos, c.networkWidth).map((n) => load(n.path));
        loadMs += performance.now() - tl;
        const tn = performance.now();
        const net = computeNetwork(sources, {
          centre: sun.pos,
          to: dest.pos,
          radius: c.networkWidth,
          capacity: { by: 'luminosity', faint: S.jumpFaint, sun: S.jumpSun, bright: S.jumpBright },
          nodeKey: (p) => ordinal.get(p) ?? 0,
          maxPlaces: MAX_PLACES,
          range: RANGE,
          hub: S.jumpHub,
          kSun: S.jumpSun,
          connect: S.jumpConnect,
          maxCandidates: MAX_PAIRS,
        });
        networkMs += performance.now() - tn;
        if (net.overflow) return { refused: net.overflow };
        const { places, links } = net;
        return {
          count: places.count,
          positions: places.positions,
          keys: places.keys,
          links,
          start: placeOfStar(places, sun.path, sun.i),
          goal: placeOfStar(places, dest.path, dest.i),
        };
      });
      const searchMs = performance.now() - t0 - loadMs - networkMs;
      const path = 'route' in plan && plan.route ? plan.route.path : null;
      out.push(
        `| ${name} | ${f1(straight)} | ${mode} | ${plan.status} | ${plan.tried.join(', ')} | ${f1(loadMs)} | ${f1(networkMs)} | ${searchMs.toFixed(2)} | ${path?.found ? path.jumps : '–'} | ${path?.found ? f1(path.total) : '–'} |`,
      );
    }
  }
}

export async function main(root: string): Promise<void> {
  const out = syntheticTable();
  await planningBench(out);
  await realBench(root, out);
  console.log(out.join('\n'));
}
