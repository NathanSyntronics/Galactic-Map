/**
 * What a shared link carries besides the view (README "Shared links"): the selected star, planet,
 * spacecraft or galaxy, the route and the planets' date. Stars and route ends by node and index (fast) and by designation (checked
 * against the node, and the fallback when the star data has been rebuilt since).
 */

export interface LinkStar {
  designation: string;
  path: string;
  index: number;
}

export interface LinkEnd extends LinkStar {
  /** Galactic coordinates (ly), where the route planner looks when node and index do not match. */
  pos: [number, number, number];
}

export interface LinkState {
  star?: LinkStar;
  planet?: string;
  /** A spacecraft by its key (voyager1, ...). */
  probe?: string;
  galaxy?: { designation: string; index: number };
  route?: { from: LinkEnd | null; to: LinkEnd | null; mode: 'jumps' | 'distance' };
  /** The date the planets and spacecraft are drawn for (Julian) and the clock's speed (days per second, 0 real time), when not now. */
  clock?: { jd: number; speed?: number };
}

/** Julian dates a link may carry: two million years either way (the clock's range). */
const JD_MIN = 2451545 - 2_000_000 * 365.25;
const JD_MAX = 2451545 + 2_000_000 * 365.25;

/** A parameter value: percent-encoded, spaces as '+'. */
function enc(v: string): string {
  return encodeURIComponent(v).replace(/%20/g, '+');
}

function key(s: LinkStar): string {
  return `${s.path}:${s.index}`;
}

/** Parses "path:index" (path: letters and digits). */
function parseKey(v: string | null): { path: string; index: number } | null {
  const m = v ? /^([a-z0-9]+):(\d+)$/i.exec(v) : null;
  return m ? { path: m[1], index: Number(m[2]) } : null;
}

function parsePos(v: string | null): [number, number, number] | null {
  const p = v?.split(',').map(Number);
  return p && p.length === 3 && p.every(Number.isFinite) ? [p[0], p[1], p[2]] : null;
}

/** The link's parameters, to append to the view's ("&s=...&sk=..."; empty without any). */
export function linkParams(s: LinkState): string {
  const out: string[] = [];
  if (s.star) out.push(`s=${enc(s.star.designation)}`, `sk=${key(s.star)}`);
  else if (s.planet) out.push(`p=${enc(s.planet)}`);
  else if (s.probe) out.push(`k=${enc(s.probe)}`);
  else if (s.galaxy) out.push(`g=${enc(s.galaxy.designation)}`, `gi=${s.galaxy.index}`);
  const r = s.route;
  if (r && (r.from || r.to)) {
    const end = (name: string, e: LinkEnd | null) => {
      if (!e) return;
      const f = (x: number) => Number(x.toPrecision(10));
      out.push(`${name}=${enc(e.designation)}`, `${name}k=${key(e)}`, `${name}p=${e.pos.map(f).join(',')}`);
    };
    end('rf', r.from);
    end('rt', r.to);
    if (r.mode === 'distance') out.push('rm=d');
  }
  if (s.clock) {
    // to a second
    out.push(`t=${s.clock.jd.toFixed(5)}`);
    if (s.clock.speed !== undefined) out.push(`ts=${Number(s.clock.speed.toPrecision(6))}`);
  }
  return out.length ? `&${out.join('&')}` : '';
}

/** The link state of a URL's parameters (anything malformed is left out). */
export function readLink(params: URLSearchParams): LinkState {
  const out: LinkState = {};
  const s = params.get('s');
  const sk = parseKey(params.get('sk'));
  if (s && sk) out.star = { designation: s, ...sk };
  const p = params.get('p');
  if (!out.star && p) out.planet = p;
  const k = params.get('k');
  if (!out.star && !out.planet && k && /^[a-z0-9]+$/.test(k)) out.probe = k;
  const g = params.get('g');
  const gi = Number(params.get('gi'));
  if (!out.star && !out.planet && !out.probe && g) out.galaxy = { designation: g, index: Number.isInteger(gi) && gi >= 0 ? gi : -1 };
  const end = (name: string): LinkEnd | null => {
    const d = params.get(name);
    const k = parseKey(params.get(`${name}k`));
    const pos = parsePos(params.get(`${name}p`));
    return d && k && pos ? { designation: d, ...k, pos } : null;
  };
  const from = end('rf');
  const to = end('rt');
  if (from || to) out.route = { from, to, mode: params.get('rm') === 'd' ? 'distance' : 'jumps' };
  const t = params.get('t');
  const jd = t ? Number(t) : NaN;
  if (Number.isFinite(jd) && jd >= JD_MIN && jd <= JD_MAX) {
    const ts = params.get('ts');
    const speed = ts ? Number(ts) : NaN;
    out.clock = Number.isFinite(speed) && speed >= 0 ? { jd, speed } : { jd };
  }
  return out;
}

/** Whether a link carries anything besides the view. */
export function hasLinkState(s: LinkState): boolean {
  return !!(s.star || s.planet || s.probe || s.galaxy || s.route);
}
