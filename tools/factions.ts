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
import { Octree, nodeKeyOf, type Manifest, type SubManifest } from '../src/data/octree';
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
  /**
   * Radius (ly) of the faction's own network region around its capital; without one, the faction
   * grows in the shared region around the Sun (REGION), together with the other small ones.
   */
  region?: number;
}

/**
 * The example factions. Text values get the category colours in the alphabetical order of the
 * values (blue, orange, green, red, purple, yellow, teal, pink, light green), so the names set the
 * colours: the Sun and Vega, which share the longest border, get blue and orange (distinct also for
 * red-green colour blindness), Arcturus red, and Pollux, which borders nobody, green. The large
 * factions far from the Sun come after them in the alphabet, so the small ones keep their colours.
 *
 * The large ones grow in a region of their own around their capitals (they are 250 to 550 ly away
 * and 400 ly or more apart, so they cannot meet); the region is large enough that the territory
 * stays a jump margin inside it (checked).
 */
export const FACTIONS: Faction[] = [
  { name: 'Commonwealth of Sol', de: 'Commonwealth von Sol', capital: 'Sun', size: 90 },
  { name: 'League of Vega', de: 'Liga von Wega', capital: 'Vega', size: 60 },
  { name: 'Realm of Arcturus', de: 'Reich von Arktur', capital: 'Arcturus', size: 40 },
  { name: 'Pact of Pollux', de: 'Pakt von Pollux', capital: 'Pollux', size: 20 },
  { name: 'Union of Betelgeuse', de: 'Union von Beteigeuze', capital: 'Betelgeuse', size: 100_000, region: 360 },
  { name: 'Theocracy of Antares', de: 'Theokratie von Antares', capital: 'Antares', size: 50_000, region: 280 },
  { name: 'Star Kingdom of Polaris', de: 'Königreich des Polarsterns', capital: 'Polaris', size: 20_000, region: 200 },
  { name: 'Syndicate of Canopus', de: 'Syndikat von Canopus', capital: 'Canopus', size: 5_000, region: 140 },
  { name: 'Republic of Spica', de: 'Republik Spica', capital: 'Spica', size: 1_000, region: 100 },
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
  /** Tie-break key of each node, as the app's (nodeKeyOf). */
  nodeKeys: Map<string, number>;
}

/** Decodes every node whose cube reaches into the region and styles it with the default settings. */
function loadRegion(dataDir: string, centre: Vector3, radius: number): Data {
  const manifest = JSON.parse(readFileSync(join(dataDir, 'manifest.json'), 'utf8')) as Manifest;
  const octree = new Octree(manifest);
  // large datasets: the nodes of the region's sub-manifests too
  for (let more = true; more; ) {
    more = false;
    for (const node of [...octree.nodes.values()]) {
      if (!Octree.hasUnloaded(node) || node.box.distanceToPoint(centre) > radius) continue;
      octree.addSub(node, (JSON.parse(readFileSync(join(dataDir, node.sub!), 'utf8')) as SubManifest).nodes);
      more = true;
    }
  }
  const nodeKeys = new Map<string, number>();
  for (const node of octree.nodes.values()) nodeKeys.set(node.path, nodeKeyOf(node));
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
  return { sources, nodeKeys };
}

/** The jump network with the default settings, as the app computes it (without the app's size limits). */
function defaultNetwork(data: Data, centre: Vector3, radius: number): JumpNetwork {
  const s = DEFAULT_SETTINGS;
  return computeNetwork(data.sources, {
    centre: { x: centre.x, y: centre.y, z: centre.z },
    radius,
    capacity: { by: 'luminosity', faint: s.jumpFaint, sun: s.jumpSun, bright: s.jumpBright },
    nodeKey: (path) => data.nodeKeys.get(path) ?? 0,
    // the large regions hold far more places than the app computes at once
    maxPlaces: Math.max(MAX_PLACES, 5_000_000),
    range: s.jumpRange,
    hub: s.jumpHub,
    kSun: s.jumpSun,
    connect: s.jumpConnect,
    maxCandidates: Math.max(MAX_PAIRS, 50_000_000),
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

/** A network region and the factions that grow in it. */
interface Group {
  centre: Vector3;
  radius: number;
  factions: number[];
}

/** World position (as in the node data) of a search index entry, whose x, y, z are galactic. */
function worldOf(e: SearchTuple): Vector3 {
  return new Vector3(e[4], e[6], -e[5]);
}

/** The shared region around the Sun and one region per faction that has its own. */
function groupsOf(index: SearchIndex): Group[] {
  const groups: Group[] = [{ centre: new Vector3(0, 0, 0), radius: REGION, factions: [] }];
  FACTIONS.forEach((f, k) => {
    if (f.region === undefined) return void groups[0].factions.push(k);
    const e = index.find(f.capital);
    if (!e) throw new Error(`capital ${f.capital} not found`);
    groups.push({ centre: worldOf(e), radius: f.region, factions: [k] });
  });
  return groups.filter((g) => g.factions.length);
}

/** A grown group: its network and territories, and the stars of each faction. */
interface Grown {
  net: JumpNetwork;
  terr: Territories;
  /** Faction index of each seed of the group. */
  factions: number[];
}

export interface FactionResult {
  csv: string;
  report: ImportReport;
  /** Summary for the console. */
  lines: string[];
}

/** Computes the territories and the CSV, and checks the CSV the way the app imports it. */
export function makeFactions(root: string): FactionResult {
  const dataDir = join(root, 'public', 'data');
  const s = DEFAULT_SETTINGS;
  const index = new SearchIndex();
  index.load(JSON.parse(readFileSync(join(dataDir, 'search.json'), 'utf8')) as SearchTuple[]);

  const lines: string[] = [];
  // exact keys: the app applies the file without loading the search index (see CsvLayout)
  const rows: string[][] = [[KEY_COLUMN, 'name', FACTION_COLUMN, FACTION_DE_COLUMN, CAPITAL_COLUMN, CAPITAL_DE_COLUMN]];
  /** Expected faction per storage key, for the check below. */
  const expected = new Map<string, string>();
  const grown: Grown[] = [];
  for (const group of groupsOf(index)) {
    const t0 = Date.now();
    const data = loadRegion(dataDir, group.centre, group.radius);
    const net = defaultNetwork(data, group.centre, group.radius);
    if (net.overflow) throw new Error(`network not computed: ${net.overflow}`);
    const pos = net.places.positions;
    /** Storage keys of the capital stars. */
    const capitalKeys = new Set<string>();
    const capitals = group.factions.map((k) => {
      const f = FACTIONS[k];
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
      group.factions.map((k, j) => ({ capital: capitals[j], size: FACTIONS[k].size })),
      dist,
    );
    grown.push({ net, terr, factions: group.factions });
    const safe = group.radius - jumpMargin(s.jumpRange);
    group.factions.forEach((k, j) => {
      const f = FACTIONS[k];
      const places = terr.members[j];
      if (places.length !== f.size) throw new Error(`${f.name}: ${places.length} places instead of ${f.size}`);
      const jumps = territoryJumps(net.places.count, net.links, terr.owner, capitals[j]);
      let maxDist = 0;
      let maxJumps = 0;
      let first = true;
      for (const p of places) {
        if (jumps[p] < 0) throw new Error(`${f.name}: a place is not connected to the capital`);
        maxDist = Math.max(maxDist, dist(p, j));
        maxJumps = Math.max(maxJumps, jumps[p]);
        const far = Math.hypot(pos[3 * p] - group.centre.x, pos[3 * p + 1] - group.centre.y, pos[3 * p + 2] - group.centre.z);
        if (far > safe) throw new Error(`${f.name}: a place ${far.toFixed(1)} ly from the region's centre is too close to its edge`);
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
          if (expected.has(key)) throw new Error(`${key} is in two territories`);
          const capital = capitalKeys.has(key);
          // the German forms once per value (on the capital's row, the first): enough for the import
          rows.push([key, nameOf(star), f.name, first ? f.de : '', capital ? CAPITAL_YES.en : '', capital ? CAPITAL_YES.de : '']);
          first = false;
          expected.set(key, f.name);
        }
      }
      lines.push(`${f.name}: ${places.length} places, up to ${maxJumps} jumps and ${maxDist.toFixed(1)} ly from ${f.capital}`);
    });
    const border = borderLinks(net.links, terr.owner, group.factions.length);
    for (let a = 0; a < group.factions.length; a++)
      for (let b = a + 1; b < group.factions.length; b++)
        if (border[a][b]) {
          const n = border[a][b];
          lines.push(`${FACTIONS[group.factions[a]].name} – ${FACTIONS[group.factions[b]].name}: ${n} link${n > 1 ? 's' : ''} across the border`);
        }
    lines.push(`  (region ${group.radius} ly: ${net.places.count} places, ${net.links.count} links, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
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
  for (const g of grown)
    g.factions.forEach((k, j) => {
      const f = FACTIONS[k];
      for (const p of g.terr.members[j])
        for (const star of members(g.net, p)) {
          const v = get(star.data, star.i);
          if (v !== f.name) throw new Error(`${designationOf(star.data, star.i)}: ${String(v)} instead of ${f.name}`);
        }
    });
  if (store.valueCount(def.id) !== expected.size) throw new Error(`${store.valueCount(def.id)} values, expected ${expected.size}`);
  // the same rows looked up by name (a plain "designation" column) give the same values
  const looked = new AttributeStore(false);
  const viaIndex = importCsv(csv.replace(KEY_COLUMN, 'designation'), looked, resolverOf(index, dataDir));
  if (viaIndex.unresolved.length) throw new Error(`unresolved keys: ${viaIndex.unresolved.join(', ')}`);
  {
    const a = looked.toJSON().values;
    const b = store.toJSON().values;
    const diff: string[] = [];
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)]))
      for (const k of new Set([...Object.keys(a[id] ?? {}), ...Object.keys(b[id] ?? {})]))
        if (a[id]?.[k] !== b[id]?.[k]) diff.push(`${id} ${k}: looked up ${String(a[id]?.[k])}, exact ${String(b[id]?.[k])}`);
    if (diff.length) throw new Error(`looked-up keys differ from the exact keys (${diff.length}): ${diff.slice(0, 10).join('; ')}`);
  }
  lines.push(`import check: ${report.unverified} exact keys; by lookup ${viaIndex.matched} matched, ${viaIndex.unverified} unverified, the same values`);
  return { csv, report, lines };
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
