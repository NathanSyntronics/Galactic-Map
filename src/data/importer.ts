import { AttributeStore, type AttrType, type AttributeDef } from './attributes';
import { csvLayout, cellValue, columnHeader, inferType, parseColumnHeader, parseCsv, toCsv } from './csv';
import { canonicalDesignation, isCatalogueNumber } from './designation';

/** Finds stars by name or designation (backed by the search index and systems.json). */
export interface StarResolver {
  /** The star a key (name or designation) names: its primary designation and system id (-1: none). */
  star(key: string): { designation: string; system: number } | null;
  /** The primary designation of a system's primary star. */
  systemPrimary(system: number): string | null;
}

export interface ImportedAttribute {
  name: string;
  type: AttrType;
  system: boolean;
  created: boolean;
  values: number;
  /** Cells that do not fit the attribute type. */
  rejected: number;
}

export interface ImportReport {
  rows: number;
  /** Rows whose key names a star. */
  matched: number;
  /** Rows whose key is a catalogue designation that is not in the name index (taken as it is). */
  unverified: number;
  /** Keys that name no known star. */
  unresolved: string[];
  attributes: ImportedAttribute[];
}

/** A key that is not a known name is still taken as a designation if it looks like one. */
function looksLikeDesignation(key: string): boolean {
  return isCatalogueNumber(key) || /\d/.test(key);
}

/**
 * Imports attribute values from CSV text: one row per star, the star in the designation (or name)
 * column, one column per attribute. Unknown attributes are created (type from a "[number]" /
 * "[text]" / "[color]" header tag, else from the values; "[system]" for whole-system values).
 * Empty cells leave existing values alone; with `replace`, the imported attributes lose their
 * old values first.
 */
export function importCsv(text: string, store: AttributeStore, resolver: StarResolver, replace = false): ImportReport {
  const table = parseCsv(text);
  const decimalComma = table.delimiter !== ',';
  const { keyColumn, valueColumns } = csvLayout(table.header);
  const report: ImportReport = { rows: table.rows.length, matched: 0, unverified: 0, unresolved: [], attributes: [] };

  const columns: { col: number; def: AttributeDef; info: ImportedAttribute }[] = [];
  const byDef = new Map<string, ImportedAttribute>();
  let defsChanged = false;
  for (const col of valueColumns) {
    const spec = parseColumnHeader(table.header[col]);
    if (!spec.name) continue;
    let def = store.defByName(spec.name);
    let created = false;
    if (!def) {
      const type = spec.type ?? inferType(table.rows.map((r) => r[col] ?? ''), decimalComma);
      def = store.addDef(spec.name, type, spec.system ?? false, false);
      created = defsChanged = true;
    } else if (spec.system !== null && spec.system !== def.system) {
      store.updateDef(def.id, { system: spec.system }, false);
      def = store.def(def.id)!;
      defsChanged = true;
    }
    let info = byDef.get(def.id);
    if (!info) {
      info = { name: def.name, type: def.type, system: def.system, created, values: 0, rejected: 0 };
      byDef.set(def.id, info);
      report.attributes.push(info);
      if (replace && !created) store.clearValues(def.id, false);
    }
    columns.push({ col, def, info });
  }

  for (const row of table.rows) {
    const key = (row[keyColumn] ?? '').trim();
    if (!key) continue;
    let star = resolver.star(key);
    if (star) report.matched++;
    else if (looksLikeDesignation(key)) {
      star = { designation: canonicalDesignation(key), system: -1 };
      report.unverified++;
    } else {
      report.unresolved.push(key);
      continue;
    }
    for (const { col, def, info } of columns) {
      const raw = row[col] ?? '';
      if (!raw.trim()) continue;
      const v = cellValue(raw, def.type, decimalComma);
      if (v === null) {
        info.rejected++;
        continue;
      }
      const target = def.system && star.system >= 0 ? (resolver.systemPrimary(star.system) ?? star.designation) : star.designation;
      store.setValue(def.id, target, v, false);
      info.values++;
    }
  }
  // listeners hear of the new attributes and values together, once
  store.commit(defsChanged ? 'defs' : 'values');
  return report;
}

export interface ExportNames {
  /** Display name of a star (for the informational name column), or null. */
  name(designation: string): string | null;
}

/**
 * All attributes as CSV: designation, name, then one column per attribute with a type tag.
 * German: ';' and decimal commas (what spreadsheet programs with German settings expect).
 */
export function exportCsv(store: AttributeStore, names: ExportNames, lang: 'en' | 'de'): string {
  const delimiter = lang === 'de' ? ';' : ',';
  const defs = store.defs;
  const keys = new Set<string>();
  for (const d of defs) for (const [k] of store.values(d.id).entries()) keys.add(k);
  const rows: string[][] = [['designation', 'name', ...defs.map((d) => columnHeader(d.name, d.type, d.system))]];
  const sorted = [...keys].map((k) => ({ k, name: names.name(k) ?? '' }));
  sorted.sort((a, b) => (a.name || a.k).localeCompare(b.name || b.k, lang));
  const fmt = (v: number | string | undefined) =>
    v === undefined ? '' : typeof v === 'number' ? (lang === 'de' ? String(v).replace('.', ',') : String(v)) : v;
  for (const { k, name } of sorted) {
    rows.push([k, name, ...defs.map((d) => fmt(store.values(d.id).getText(k)))]);
  }
  return toCsv(rows, delimiter);
}
