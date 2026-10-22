import type { SearchTuple } from './search';

/** A star picked from the search results, as stored: its primary designation and display names. */
export interface RecentSearch {
  designation: string;
  nameEn: string;
  nameDe: string | null;
}

/** How many recent searches are kept and shown. */
export const RECENT_MAX = 3;
const STORAGE_KEY = 'galactic-map:recent-searches:v1';

/** The list with `entry` in front (newest first), without duplicates, at most `max` long. */
export function addRecent(list: readonly RecentSearch[], entry: RecentSearch, max = RECENT_MAX): RecentSearch[] {
  return [entry, ...list.filter((e) => e.designation !== entry.designation)].slice(0, max);
}

/** The stored list; invalid entries and duplicates are dropped. */
export function parseRecent(raw: string | null, max = RECENT_MAX): RecentSearch[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RecentSearch[] = [];
  for (const e of parsed as Partial<RecentSearch>[]) {
    if (!e || typeof e.designation !== 'string' || !e.designation || typeof e.nameEn !== 'string') continue;
    if (out.some((o) => o.designation === e.designation)) continue;
    out.push({ designation: e.designation, nameEn: e.nameEn, nameDe: typeof e.nameDe === 'string' ? e.nameDe : null });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The entries the search index still knows, with their current names and index entries; entries
 * whose designation is no longer in the index are dropped.
 */
export function resolveRecent(
  list: readonly RecentSearch[],
  byPrimary: (designation: string) => SearchTuple | null,
): { entry: RecentSearch; tuple: SearchTuple }[] {
  const out: { entry: RecentSearch; tuple: SearchTuple }[] = [];
  for (const e of list) {
    const tuple = byPrimary(e.designation);
    if (tuple) out.push({ entry: { designation: e.designation, nameEn: tuple[0], nameDe: tuple[1] }, tuple });
  }
  return out;
}

/** True if both lists hold the same entries in the same order. */
export function sameRecent(a: readonly RecentSearch[], b: readonly RecentSearch[]): boolean {
  return (
    a.length === b.length &&
    a.every((e, i) => e.designation === b[i].designation && e.nameEn === b[i].nameEn && e.nameDe === b[i].nameDe)
  );
}

export function readRecent(): RecentSearch[] {
  try {
    return parseRecent(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

export function writeRecent(list: readonly RecentSearch[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable: the list lasts until the page is reloaded
  }
}
