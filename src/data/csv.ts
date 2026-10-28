import type { Lang } from '../settings';
import { COLOR_RE, isLang, normalizeColor, type AttrType, type AttrValue } from './attributes';

export interface CsvTable {
  header: string[];
  rows: string[][];
  delimiter: string;
}

/**
 * Text of a CSV file: UTF-8, or Windows-1252 for files that are not valid UTF-8 (what spreadsheet
 * programs on Windows write by default, e.g. German umlauts).
 */
export function decodeCsv(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Splits CSV text into rows (RFC 4180 quoting, any line ending); detects ',', ';' or tab. */
export function parseCsv(text: string): CsvTable {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field.trim() === '') {
      quoted = true;
      field = '';
      i++;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\r' || c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((f) => f.trim() !== ''));
  const header = joinSplitTags(nonEmpty.shift() ?? [], delimiter).map((h) => h.trim());
  return { header, rows: nonEmpty, delimiter };
}

/**
 * An unquoted header "Faction [text, system]" in a comma-separated file arrives as two cells;
 * cells from an opening "[" to the closing "]" are joined again.
 */
function joinSplitTags(cells: string[], delimiter: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    let c = cells[i];
    if (c.includes('[') && !c.includes(']')) {
      let j = i + 1;
      while (j < cells.length && !cells[j].includes(']') && !cells[j].includes('[')) j++;
      if (j < cells.length && cells[j].includes(']') && !cells[j].includes('[')) {
        c = cells.slice(i, j + 1).join(delimiter);
        i = j;
      }
    }
    out.push(c);
  }
  return out;
}

/**
 * The delimiter that splits the first line into the most fields (outside quotes and outside
 * header tags: "Faction [text, system]" in a ';' file is one field).
 */
function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  let tag = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === '\n' || c === '\r') break;
    else if (c === '[') tag = true;
    else if (c === ']') tag = false;
    else if (!tag && c in counts) counts[c]++;
  }
  if (counts['\t'] > counts[';'] && counts['\t'] > counts[',']) return '\t';
  return counts[';'] > counts[','] ? ';' : ',';
}

/**
 * A number as written in English or German spreadsheets: "1234.5", "1,5" (decimal comma, not in
 * comma-separated files), "1.234,5", "1,234.5", "-3e-4", with spaces as thousands separators.
 */
export function parseNumber(raw: string, decimalComma: boolean): number | null {
  const s = raw.trim().replace(/[\s  ']/g, '');
  if (s === '') return null;
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
  if (decimalComma && /^[+-]?\d*,\d+$/.test(s)) return Number(s.replace(',', '.'));
  if (/^[+-]?\d{1,3}(\.\d{3})+,\d+$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  if (!decimalComma && /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ''));
  return null;
}

export interface ColumnSpec {
  /** Column header without the [type, system] tag. */
  name: string;
  type: AttrType | null;
  system: boolean | null;
  /**
   * A translation column ("Faction [de: Fraktion]" or "Faction [de]"): its cells are the values of
   * the column `name` in this language, and `label` (if given) is the attribute's name in it.
   */
  translation?: { lang: Lang; label: string | null };
}

const TRANSLATION_TAG = /^\s*([a-z]{2})\s*(?::\s*(.*?))?\s*$/i;

const TYPE_TAGS: Record<string, AttrType> = {
  number: 'number',
  zahl: 'number',
  numeric: 'number',
  text: 'text',
  category: 'text',
  kategorie: 'text',
  color: 'color',
  colour: 'color',
  farbe: 'color',
};

/**
 * "Faction [text, system]" -> name 'Faction', type 'text', system true;
 * "Faction [de: Fraktion]" -> a translation column of Faction (see ColumnSpec.translation).
 */
export function parseColumnHeader(h: string): ColumnSpec {
  const m = /^(.*?)\s*\[([^\]]*)\]\s*$/.exec(h);
  if (!m) return { name: h.trim(), type: null, system: null };
  const tr = TRANSLATION_TAG.exec(m[2]);
  const lang = tr?.[1].toLowerCase() ?? '';
  if (tr && isLang(lang)) return { name: m[1].trim(), type: null, system: null, translation: { lang, label: tr[2] || null } };
  let type: AttrType | null = null;
  let system: boolean | null = null;
  for (const tag of m[2].split(/[,;\s]+/).map((x) => x.toLowerCase()).filter(Boolean)) {
    if (tag in TYPE_TAGS) type = TYPE_TAGS[tag];
    else if (tag === 'system') system = true;
    else if (tag === 'star' || tag === 'stern') system = false;
  }
  return { name: m[1].trim(), type, system };
}

export function columnHeader(name: string, type: AttrType, system: boolean): string {
  return `${name} [${type}${system ? ', system' : ''}]`;
}

/** Header of a translation column: "Faction [de: Fraktion]", or "Faction [de]" without a name in that language. */
export function translationHeader(name: string, lang: Lang, label: string | undefined): string {
  return `${name} [${lang}${label ? `: ${label}` : ''}]`;
}

/** Most likely type of a column from its non-empty values. */
export function inferType(values: string[], decimalComma: boolean): AttrType {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (filled.length === 0) return 'text';
  if (filled.every((v) => parseNumber(v, decimalComma) !== null)) return 'number';
  if (filled.every((v) => COLOR_RE.test(v) || /^#[0-9a-f]{3}$/i.test(v))) return 'color';
  return 'text';
}

/** A cell converted to the attribute type, or null if it does not fit. */
export function cellValue(raw: string, type: AttrType, decimalComma: boolean): AttrValue | null {
  const s = raw.trim();
  if (!s) return null;
  if (type === 'number') return parseNumber(s, decimalComma);
  if (type === 'color') return normalizeColor(s);
  return s;
}

/** Names of the header that hold the star key, best first. */
const KEY_HEADERS = ['designation', 'bezeichnung', 'key', 'schlüssel', 'id', 'star', 'stern', 'name'];
/** Informational column written by the export next to the designation. */
const INFO_HEADERS = ['name'];

export interface CsvLayout {
  keyColumn: number;
  /** Columns that hold attribute values. */
  valueColumns: number[];
  /**
   * The key column is tagged "[exact]" ("designation [exact]"): its keys are designations exactly
   * as the values are stored (whole-system values under the system's primary), so the import
   * needs no name lookup.
   */
  exactKeys: boolean;
}

const EXACT_TAG = /\s*\[\s*exact\s*\]$/;

/** Which column holds the star key and which hold attribute values. */
export function csvLayout(header: string[]): CsvLayout {
  const norm = header.map((h) => h.trim().toLowerCase());
  const base = norm.map((h) => h.replace(EXACT_TAG, ''));
  let keyColumn = 0;
  for (const k of KEY_HEADERS) {
    const i = base.indexOf(k);
    if (i >= 0) {
      keyColumn = i;
      break;
    }
  }
  const keyIsName = base[keyColumn] === 'name';
  const valueColumns = header
    .map((_, i) => i)
    .filter((i) => i !== keyColumn && norm[i] !== '' && (keyIsName || !INFO_HEADERS.includes(norm[i])));
  return { keyColumn, valueColumns, exactKeys: EXACT_TAG.test(norm[keyColumn] ?? '') };
}

/** A field quoted for CSV if it needs to be. */
export function csvField(v: string, delimiter = ','): string {
  return /["\r\n]/.test(v) || v.includes(delimiter) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(rows: string[][], delimiter = ','): string {
  // byte order mark: spreadsheet programs then read the file as UTF-8
  return '﻿' + rows.map((r) => r.map((f) => csvField(f, delimiter)).join(delimiter)).join('\r\n') + '\r\n';
}
