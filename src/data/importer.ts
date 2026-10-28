import type { Lang } from '../settings';
import { AttributeStore, LANGS, valueFromLabel, type AttrType, type AttributeDef } from './attributes';
import { csvLayout, cellValue, columnHeader, inferType, parseColumnHeader, parseCsv, toCsv, translationHeader } from './csv';
import { canonicalDesignation, isCatalogueNumber } from './designation';

/** Finds stars by name or designation (backed by the search index and systems.json). */
export interface StarResolver {
  /** The star a key (name or designation) names: its primary designation and system id (-1: none). */
  star(key: string): { designation: string; system: number } | null;
  /** The primary designation of a system's primary star. */
  systemPrimary(system: number): string | null;
}

/** For files whose keys need no lookup (an "[exact]" key column). */
export const NO_LOOKUP: StarResolver = { star: () => null, systemPrimary: () => null };

/** False when the CSV's keys are exact designations (an "[exact]" key column): no resolver needed. */
export function csvNeedsLookup(text: string): boolean {
  return !csvLayout(parseCsv(text).header).exactKeys;
}

export interface ImportedAttribute {
  name: string;
  type: AttrType;
  system: boolean;
  created: boolean;
  values: number;
  /** Cells that do not fit the attribute type. */
  rejected: number;
  /** Languages of the file's translation columns for this attribute. */
  languages: Lang[];
  /** Values that got a label in another language. */
  translated: number;
}

export interface ImportReport {
  rows: number;
  /** Rows whose key names a star. */
  matched: number;
  /** Rows whose key is a catalogue designation that is not in the name index, or an exact key (taken as it is). */
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
 * old values first. Keys of an "[exact]" key column are not looked up (see CsvLayout).
 * Translation columns ("Faction [de: Fraktion]") give the attribute's name in a language and, per
 * row, the label of the row's value in it; a text value that is a label of a stored value (in any
 * language) stands for that value.
 */
export function importCsv(text: string, store: AttributeStore, resolver: StarResolver, replace = false): ImportReport {
  const table = parseCsv(text);
  const decimalComma = table.delimiter !== ',';
  const { keyColumn, valueColumns, exactKeys } = csvLayout(table.header);
  const report: ImportReport = { rows: table.rows.length, matched: 0, unverified: 0, unresolved: [], attributes: [] };

  const columns: { col: number; def: AttributeDef; info: ImportedAttribute }[] = [];
  const byDef = new Map<string, ImportedAttribute>();
  let defsChanged = false;
  const specs = valueColumns.map((col) => ({ col, spec: parseColumnHeader(table.header[col]) }));
  for (const { col, spec } of specs) {
    if (!spec.name || spec.translation) continue;
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
      info = { name: def.name, type: def.type, system: def.system, created, values: 0, rejected: 0, languages: [], translated: 0 };
      byDef.set(def.id, info);
      report.attributes.push(info);
      if (replace && !created) store.clearValues(def.id, false);
    }
    columns.push({ col, def, info });
  }

  // translation columns: the attribute's name in the language, and labels of the values per row
  for (const { col, spec } of specs) {
    const tr = spec.translation;
    if (!tr || !spec.name) continue;
    const def = store.defByName(spec.name);
    if (!def) continue;
    if (tr.label && tr.label !== def.labels?.[tr.lang]) {
      try {
        store.setLabels(def.id, { [tr.lang]: tr.label }, false);
        defsChanged = true;
      } catch {
        // the label is another attribute's name: keep the attribute's own name in that language
      }
    }
    const base = columns.find((c) => c.def.id === def.id);
    if (base && !base.info.languages.includes(tr.lang)) base.info.languages.push(tr.lang);
    if (!base || def.type !== 'text') continue;
    const labelled = new Set<string>();
    for (const row of table.rows) {
      const v = (row[base.col] ?? '').trim();
      const label = (row[col] ?? '').trim();
      if (!v || !label || labelled.has(v)) continue;
      labelled.add(v);
      // a value in its stored spelling is not a label of itself
      if (label === v && !store.def(def.id)!.valueLabels?.[v]?.[tr.lang]) continue;
      store.setValueLabel(def.id, v, tr.lang, label === v ? null : label, false);
      defsChanged = true;
    }
    base.info.translated = Math.max(base.info.translated, labelled.size);
  }
  // the labels above may have changed the definitions
  for (const c of columns) c.def = store.def(c.def.id)!;

  for (const row of table.rows) {
    const key = (row[keyColumn] ?? '').trim();
    if (!key) continue;
    // exact keys are taken as they are, also for whole-system values (already the primary's)
    let star = exactKeys ? null : resolver.star(key);
    if (exactKeys) {
      star = { designation: canonicalDesignation(key), system: -1 };
      report.unverified++;
    } else if (star) report.matched++;
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
      let v = cellValue(raw, def.type, decimalComma);
      if (typeof v === 'string' && def.type === 'text') v = valueFromLabel(def, v);
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

/** Languages in which an attribute has a name or value labels (one translation column each). */
function translationLangs(def: AttributeDef): Lang[] {
  return LANGS.filter((l) => def.labels?.[l] || Object.values(def.valueLabels ?? {}).some((x) => x[l]));
}

/**
 * All attributes as CSV: designation, name, then one column per attribute with a type tag, each
 * followed by its translation columns ("Faction [de: Fraktion]": the value labels in German).
 * German: ';' and decimal commas (what spreadsheet programs with German settings expect).
 */
export function exportCsv(store: AttributeStore, names: ExportNames, lang: 'en' | 'de'): string {
  const delimiter = lang === 'de' ? ';' : ',';
  const defs = store.defs;
  const keys = new Set<string>();
  for (const d of defs) for (const [k] of store.values(d.id).entries()) keys.add(k);
  const fmt = (v: number | string | undefined) =>
    v === undefined ? '' : typeof v === 'number' ? (lang === 'de' ? String(v).replace('.', ',') : String(v)) : v;
  type Column = { header: string; cell: (k: string) => string };
  const cols: Column[] = [];
  for (const d of defs) {
    const values = store.values(d.id);
    cols.push({ header: columnHeader(d.name, d.type, d.system), cell: (k) => fmt(values.getText(k)) });
    for (const l of translationLangs(d)) {
      cols.push({
        header: translationHeader(d.name, l, d.labels?.[l]),
        cell: (k) => {
          const v = values.getText(k);
          return v === undefined ? '' : (d.valueLabels?.[String(v)]?.[l] ?? '');
        },
      });
    }
  }
  const rows: string[][] = [['designation', 'name', ...cols.map((c) => c.header)]];
  const sorted = [...keys].map((k) => ({ k, name: names.name(k) ?? '' }));
  sorted.sort((a, b) => (a.name || a.k).localeCompare(b.name || b.k, lang));
  for (const { k, name } of sorted) rows.push([k, name, ...cols.map((c) => c.cell(k))]);
  return toCsv(rows, delimiter);
}
