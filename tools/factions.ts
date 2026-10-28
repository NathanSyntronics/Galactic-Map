/**
 * Example factions for the site dataset (public/user/attributes.csv): four territories grown along
 * the default jump network from their capitals. Reads the star tiles in public/data with the app's
 * own modules, so the territories follow the network the app draws with the default settings.
 * Run: npm run factions (tools/make-factions.mjs).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Vector3 } from 'three';
import { AttributeStore } from '../src/data/attributes';
import { toCsv } from '../src/data/csv';
import { decodeNode, designationOf, type NodeData } from '../src/data/format';
import { NO_LOOKUP, importCsv, type ImportReport, type StarResolver } from '../src/data/importer';
import { Octree, type Manifest } from '../src/data/octree';
import { MAX_PAIRS, MAX_PLACES, computeNetwork, jumpMargin, placeOfStar, type JumpNetwork, type PlaceSource } from '../src/network/places';
import { computeStyle } from '../src/render/starfield';
import { valueGetter } from '../src/render/style';
import { DEFAULT_SETTINGS } from '../src/settings';
import { SearchIndex, type SearchTuple } from '../src/ui/search';
import { borderLinks, growTerritories, territoryJumps, type Territories } from './territories';

export interface Faction {
  name: string;
  /** The name in German (the app shows it in the German interface). */
  de: string;
  /** Name of the capital star (as the search finds it). */
  capital: string;
  /** Number of places (systems or single stars) of the territory. */
  size: number;
}

/**
 * The example factions. Text values get the category colours in the alphabetical order of the
 * values (blue, orange, green, red), so the names set the colours: the Sun and Vega, which share
 * the longest border, get blue and orange (distinct also for red-green colour blindness),
 * Arcturus red, and Pollux, which borders nobody, green.
 */
export const FACTIONS: Faction[] = [
  { name: 'Commonwealth of Sol', de: 'Commonwealth von Sol', capital: 'Sun', size: 90 },
  { name: 'League of Vega', de: 'Liga von Wega', capital: 'Vega', size: 60 },
  { name: 'Realm of Arcturus', de: 'Reich von Arktur', capital: 'Arcturus', size: 40 },
  { name: 'Pact of Pollux', de: 'Pakt von Pollux', capital: 'Pollux', size: 20 },
];

export const FACTION_COLUMN = 'Faction [text, system]';
export const CAPITAL_COLUMN = 'Capital [text]';
/** Translation columns: the German names of the attributes and, per row, the German values. */
export const FACTION_DE_COLUMN = 'Faction [de: Fraktion]';
export const CAPITAL_DE_COLUMN = 'Capital [de: Hauptstadt]';
export const CAPITAL_YES = { en: 'yes', de: 'ja' };
export const KEY_COLUMN = 'designation [exact]';

/** Radius around the Sun whose stars form the network; territories must stay a jump margin inside. */
const REGION = 100;

interface Data {
  sources: PlaceSource[];
  nodeOrdinal: Map<string, number>;
}

/** Decodes every node whose cube reaches into the region and styles it with the default settings. */
function loadRegion(dataDir: string, centre: Vector3, radius: number): Data {
  const manifest = JSON.parse(readFileSync(join(dataDir, 'manifest.json'), 'utf8')) as Manifest;
  const octree = new Octree(manifest);
  const nodeOrdinal = new Map<string, number>();
  let k = 0;
  for (const path of octree.nodes.keys()) nodeOrdinal.set(path, k++);
  const packs = new Map<number, Buffer>();
  const sources: PlaceSource[] = [];
  const plan = { color: null, size: null, missing: DEFAULT_SETTINGS.missingStyle };
  for (const node of octree.nodes.values()) {
    if (node.box.distanceToPoint(centre) > radius) continue;
    let pack = packs.get(node.pack);
    if (!pack) packs.set(node.pack, (pack = readFileSync(join(dataDir, manifest.packs[node.pack]))));
    const bytes = pack.buffer.slice(pack.byteOffset + node.offset, pack.byteOffset + node.offset + node.bytes) as ArrayBuffer;
    const data = decodeNode(bytes, node.path);
    const colors = new Uint8Array(3 * data.count);
    const sizes = new Float32Array(data.count);
    computeStyle(data, DEFAULT_SETTINGS, plan, colors, sizes);
    sources.push({ data, sizes, colors });
  }
  return { sources, nodeOrdinal };
}

/** The jump network with the default settings, as the app computes it. */
function defaultNetwork(data: Data, centre: Vector3, radius: number): JumpNetwork {
  const s = DEFAULT_SETTINGS;
  return computeNetwork(data.sources, {
    centre: { x: centre.x, y: centre.y, z: centre.z },
    radius,
    capacity: { by: 'luminosity', faint: s.jumpFaint, sun: s.jumpSun, bright: s.jumpBright },
    nodeKey: (path) => data.nodeOrdinal.get(path) ?? 0,
    maxPlaces: MAX_PLACES,
    range: s.jumpRange,
    hub: s.jumpHub,
    kSun: s.jumpSun,
    connect: s.jumpConnect,
    maxCandidates: MAX_PAIRS,
  });
}

/** Name and designation lookup as the app's CSV import does it (search index plus systems.json). */
function resolverOf(index: SearchIndex, dataDir: string): StarResolver {
  const systems = JSON.parse(readFileSync(join(dataDir, 'systems.json'), 'utf8')) as Record<string, unknown[]>;
  const primaries = new Map<number, string>();
  for (const [k, v] of Object.entries(systems)) if (typeof v[6] === 'string') primaries.set(Number(k), v[6]);
  return {
    star: (key) => {
      const e = index.find(key);
      return e && e[9] ? { designation: e[9], system: e[10] ?? -1 } : null;
    },
    systemPrimary: (sid) => primaries.get(sid) ?? null,
  };
}

interface Star {
  data: NodeData;
  i: number;
}

const memberCache = new WeakMap<JumpNetwork, Star[][]>();

/** The stars of a place. */
function members(net: JumpNetwork, place: number): Star[] {
  let all = memberCache.get(net);
  if (!all) {
    const lists: Star[][] = Array.from({ length: net.places.count }, () => []);
    const byPath = new Map(net.places.sources.map((s) => [s.data.path, s.data]));
    for (const [path, own] of net.places.starPlace) {
      const data = byPath.get(path)!;
      for (let i = 0; i < own.length; i++) if (own[i] >= 0) lists[own[i]].push({ data, i });
    }
    memberCache.set(net, (all = lists));
  }
  return all[place];
}

/** Key under which a whole-system value of the star is stored: its system's primary, else itself. */
function storageKey(s: Star): string {
  const sid = s.data.systems.get(s.i);
  const primary = sid === undefined ? null : s.data.systemInfo.get(sid)?.primary;
  return primary ?? designationOf(s.data, s.i);
}

function nameOf(s: Star): string {
  const sid = s.data.systems.get(s.i);
  const sys = sid === undefined ? undefined : s.data.systemInfo.get(sid);
  return sys?.nameEn ?? s.data.names.get(s.i)?.en ?? '';
}

export interface FactionResult {
  csv: string;
  report: ImportReport;
  /** Summary for the console. */
  lines: string[];
  network: JumpNetwork;
  territories: Territories;
  /** Place of each faction's capital. */
  capitals: number[];
}

/** Computes the territories and the CSV, and checks the CSV the way the app imports it. */
export function makeFactions(root: string): FactionResult {
  const dataDir = join(root, 'public', 'data');
  const centre = new Vector3(0, 0, 0);
  const s = DEFAULT_SETTINGS;
  const data = loadRegion(dataDir, centre, REGION);
  const net = defaultNetwork(data, centre, REGION);
  if (net.overflow) throw new Error(`network not computed: ${net.overflow}`);
  const index = new SearchIndex();
  index.load(JSON.parse(readFileSync(join(dataDir, 'search.json'), 'utf8')) as SearchTuple[]);

  const pos = net.places.positions;
  /** Storage keys of the capital stars. */
  const capitalKeys = new Set<string>();
  const capitals = FACTIONS.map((f) => {
    const e = index.find(f.capital);
    if (!e) throw new Error(`capital ${f.capital} not found`);
    const place = placeOfStar(net.places, e[2], e[3]);
    if (place < 0) throw new Error(`capital ${f.capital} is not part of the network`);
    const star = members(net, place).find((m) => m.data.path === e[2] && m.i === e[3]);
    if (star) capitalKeys.add(storageKey(star));
    return place;
  });
  const dist = (p: number, f: number): number => {
    const c = capitals[f];
    return Math.hypot(pos[3 * p] - pos[3 * c], pos[3 * p + 1] - pos[3 * c + 1], pos[3 * p + 2] - pos[3 * c + 2]);
  };
  const terr = growTerritories(
    net.places.count,
    net.links,
    FACTIONS.map((f, k) => ({ capital: capitals[k], size: f.size })),
    dist,
  );

  const lines: string[] = [];
  // exact keys: the app applies the file without loading the search index (see CsvLayout)
  const rows: string[][] = [[KEY_COLUMN, 'name', FACTION_COLUMN, FACTION_DE_COLUMN, CAPITAL_COLUMN, CAPITAL_DE_COLUMN]];
  /** Expected faction per storage key, for the check below. */
  const expected = new Map<string, string>();
  const safe = REGION - jumpMargin(s.jumpRange);
  FACTIONS.forEach((f, k) => {
    const places = terr.members[k];
    if (places.length < 10 || places.length > 100) throw new Error(`${f.name}: ${places.length} places (want 10..100)`);
    const jumps = territoryJumps(net.places.count, net.links, terr.owner, capitals[k]);
    let maxDist = 0;
    let maxJumps = 0;
    for (const p of places) {
      if (jumps[p] < 0) throw new Error(`${f.name}: a place is not connected to the capital`);
      maxDist = Math.max(maxDist, dist(p, k));
      maxJumps = Math.max(maxJumps, jumps[p]);
      const far = Math.hypot(pos[3 * p], pos[3 * p + 1], pos[3 * p + 2]);
      if (far > safe) throw new Error(`${f.name}: a place ${far.toFixed(1)} ly from the Sun is too close to the region's edge`);
      // one row per system or single star of the place (closely merged places have several)
      const repData = net.places.sources[net.places.repSource[p]].data;
      const isRep = (m: Star): number => Number(m.data === repData && m.i === net.places.repIndex[p]);
      const stars = members(net, p).slice().sort((x, y) => isRep(y) - isRep(x));
      const seen = new Set<string>();
      for (const star of stars) {
        // exact keys: the designation the values are stored under (the system's primary)
        const key = storageKey(star);
        if (seen.has(key)) continue;
        seen.add(key);
        const capital = capitalKeys.has(key);
        rows.push([key, nameOf(star), f.name, f.de, capital ? CAPITAL_YES.en : '', capital ? CAPITAL_YES.de : '']);
        expected.set(key, f.name);
      }
    }
    lines.push(`${f.name}: ${places.length} places, up to ${maxJumps} jumps and ${maxDist.toFixed(1)} ly from ${f.capital}`);
  });
  const border = borderLinks(net.links, terr.owner, FACTIONS.length);
  for (let k = 0; k < FACTIONS.length; k++)
    for (let l = k + 1; l < FACTIONS.length; l++)
      if (border[k][l]) lines.push(`${FACTIONS[k].name} – ${FACTIONS[l].name}: ${border[k][l]} link${border[k][l] > 1 ? 's' : ''} across the border`);
  const unindexed = rows.slice(1).filter((r) => !index.byPrimary(r[0])).length;
  lines.push(`${rows.length - 1} rows, ${unindexed} keys not in the name index`);
  const csv = toCsv(rows);

  // the CSV as the app imports it (exact keys, no lookups): every star of a territory gets its faction
  const store = new AttributeStore(false);
  const report = importCsv(csv, store, NO_LOOKUP);
  if (report.unresolved.length || report.unverified !== rows.length - 1) throw new Error('the keys were not taken as exact');
  const def = store.defByName('Faction');
  const get = def && valueGetter(def.id, store);
  if (!get) throw new Error('no Faction attribute after the import');
  // the German names
  const capital = store.defByName('Hauptstadt');
  if (def.labels?.de !== 'Fraktion' || capital?.labels?.de !== 'Hauptstadt') throw new Error('the German attribute names are missing');
  if (capital.valueLabels?.[CAPITAL_YES.en]?.de !== CAPITAL_YES.de) throw new Error('the German capital value is missing');
  for (const f of FACTIONS) if (def.valueLabels?.[f.name]?.de !== f.de) throw new Error(`${f.name}: no German name after the import`);
  FACTIONS.forEach((f, k) => {
    for (const p of terr.members[k])
      for (const star of members(net, p)) {
        const v = get(star.data, star.i);
        if (v !== f.name) throw new Error(`${designationOf(star.data, star.i)}: ${String(v)} instead of ${f.name}`);
      }
  });
  if (store.valueCount(def.id) !== expected.size) throw new Error(`${store.valueCount(def.id)} values, expected ${expected.size}`);
  // the same rows looked up by name (a plain "designation" column) give the same values
  const looked = new AttributeStore(false);
  const viaIndex = importCsv(csv.replace(KEY_COLUMN, 'designation'), looked, resolverOf(index, dataDir));
  if (viaIndex.unresolved.length) throw new Error(`unresolved keys: ${viaIndex.unresolved.join(', ')}`);
  if (JSON.stringify(looked.toJSON().values) !== JSON.stringify(store.toJSON().values)) throw new Error('looked-up keys differ from the exact keys');
  lines.push(`import check: ${report.unverified} exact keys; by lookup ${viaIndex.matched} matched, ${viaIndex.unverified} unverified, the same values`);
  return { csv, report, lines, network: net, territories: terr, capitals };
}

/** Writes public/user/attributes.csv. */
export function main(root: string): void {
  const { csv, lines } = makeFactions(root);
  const out = join(root, 'public', 'user', 'attributes.csv');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, csv);
  for (const l of lines) console.log(l);
  console.log(`written ${out}`);
}
