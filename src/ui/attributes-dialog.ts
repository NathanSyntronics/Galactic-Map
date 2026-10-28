import { LANGS, type AttrType, type AttributeDef, type AttributeStore } from '../data/attributes';
import type { ImportReport } from '../data/importer';
import { formatNumber, getLang, t, type MessageKey } from '../i18n';
import type { Lang } from '../settings';

/** Language names in their own language. */
const LANG_NAMES: Record<Lang, string> = { en: 'English', de: 'Deutsch' };

/** Text values listed in the translation editor (more are translated in a CSV file). */
const MAX_TRANSLATED_VALUES = 100;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const TYPES: [AttrType, MessageKey][] = [
  ['text', 'typeText'],
  ['number', 'typeNumber'],
  ['color', 'typeColor'],
];

function typeSelect(value: AttrType): HTMLSelectElement {
  const sel = el('select');
  for (const [v, k] of TYPES) {
    const o = el('option', '', t(k));
    o.value = v;
    sel.appendChild(o);
  }
  sel.value = value;
  return sel;
}

export interface AttributesDialogActions {
  importCsv(file: File, replace: boolean): Promise<ImportReport>;
  exportCsv(): Promise<void>;
  /** True if the site provides a dataset of its own (public/user/attributes.csv). */
  hasSiteData(): boolean;
  resetToSite(): Promise<void>;
  deleteAll(): void;
}

/**
 * A button that asks for a second click before it acts (native confirm() dialogs are blocked in
 * some embedding frames).
 */
function confirmingButton(label: string, confirmLabel: () => string | null, action: () => void, cls = 'btn subtle small'): HTMLButtonElement {
  const btn = el('button', cls, label);
  let armed = 0;
  btn.addEventListener('click', () => {
    const ask = confirmLabel();
    if (ask && !armed) {
      btn.textContent = ask;
      btn.classList.add('danger');
      armed = window.setTimeout(() => {
        armed = 0;
        btn.textContent = label;
        btn.classList.remove('danger');
      }, 4000);
      return;
    }
    window.clearTimeout(armed);
    armed = 0;
    action();
  });
  return btn;
}

/** Content of the "Attributes & CSV" dialog: attribute list, new attribute, CSV, storage. */
export class AttributesDialog {
  readonly body = el('div', 'dialog-body attr-dialog');
  private message: HTMLElement | null = null;
  private importResult: HTMLElement | null = null;
  /** Attributes whose translation editor is open. */
  private translating = new Set<string>();

  constructor(
    private readonly attrs: AttributeStore,
    private readonly actions: AttributesDialogActions,
  ) {
    this.render();
  }

  render(): void {
    const keepResult = this.importResult;
    const b = this.body;
    b.replaceChildren();
    const help = el('div', 'hint-block');
    help.innerHTML = t('attributesHelp');
    b.appendChild(help);

    // --- attribute list
    const defs = this.attrs.defs;
    if (defs.length) {
      const table = el('table', 'attr-table');
      const head = el('tr');
      for (const k of ['attrName', 'attrType', 'attrSystem', 'attrValues'] as MessageKey[]) head.appendChild(el('th', '', t(k)));
      head.appendChild(el('th'));
      table.appendChild(el('thead')).appendChild(head);
      const tbody = el('tbody');
      for (const def of defs) {
        const tr = el('tr');
        const name = el('input');
        name.type = 'text';
        name.value = def.name;
        name.setAttribute('aria-label', t('attrName'));
        name.addEventListener('change', () => {
          try {
            this.attrs.updateDef(def.id, { name: name.value });
            this.say('');
          } catch {
            name.value = def.name;
            this.say(t('nameTaken'), true);
          }
        });
        const type = typeSelect(def.type);
        type.setAttribute('aria-label', t('attrType'));
        type.addEventListener('change', () => {
          const dropped = this.attrs.updateDef(def.id, { type: type.value as AttrType });
          this.render();
          if (dropped) this.say(t('typeChangeDropped', { n: formatNumber(dropped) }), true);
        });
        const sys = el('input');
        sys.type = 'checkbox';
        sys.checked = def.system;
        sys.setAttribute('aria-label', t('attrSystem'));
        sys.addEventListener('change', () => this.attrs.updateDef(def.id, { system: sys.checked }));
        const del = confirmingButton(
          t('deleteAttr'),
          () => {
            const n = this.attrs.valueCount(def.id);
            return n > 0 ? t('reallyDeleteValues', { n: formatNumber(n) }) : null;
          },
          () => {
            this.attrs.removeDef(def.id);
            this.render();
          },
        );
        const open = this.translating.has(def.id);
        const translate = el('button', `btn subtle small${open ? ' active' : ''}`, t('translate'));
        translate.setAttribute('aria-expanded', String(open));
        translate.addEventListener('click', () => {
          if (open) this.translating.delete(def.id);
          else this.translating.add(def.id);
          this.render();
          this.body.querySelector<HTMLElement>(`[data-translate="${def.id}"] input`)?.focus();
        });
        const actions = el('span', 'attr-row-actions');
        actions.append(translate, del);
        const cells = [name, type, sys, el('span', 'count', formatNumber(this.attrs.valueCount(def.id))), actions];
        for (const c of cells) tr.appendChild(el('td')).appendChild(c);
        tbody.appendChild(tr);
        if (open) {
          const row = el('tr', 'attr-translations');
          const td = el('td');
          td.colSpan = cells.length;
          td.appendChild(this.translationEditor(def));
          row.appendChild(td);
          tbody.appendChild(row);
        }
      }
      table.appendChild(tbody);
      const scroll = el('div', 'table-scroll');
      scroll.appendChild(table);
      b.appendChild(scroll);
    }

    // --- new attribute
    b.appendChild(el('h3', '', t('newAttribute')));
    const form = el('form', 'attr-new');
    const name = el('input');
    name.type = 'text';
    name.placeholder = t('attrName');
    name.setAttribute('aria-label', t('attrName'));
    name.required = true;
    const type = typeSelect('text');
    type.setAttribute('aria-label', t('attrType'));
    const sysLabel = el('label', 'check');
    const sys = el('input');
    sys.type = 'checkbox';
    sysLabel.append(sys, el('span', '', t('attrSystem')));
    const add = el('button', 'btn', t('add'));
    add.type = 'submit';
    form.append(name, type, sysLabel, add);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!name.value.trim()) return name.focus();
      try {
        this.attrs.addDef(name.value, type.value as AttrType, sys.checked);
        this.render();
        this.body.querySelector<HTMLInputElement>('.attr-new input')?.focus();
      } catch {
        this.say(t('nameTaken'), true);
      }
    });
    b.appendChild(form);
    this.message = el('p', 'attr-message');
    this.message.setAttribute('role', 'status');
    b.appendChild(this.message);

    // --- CSV
    b.appendChild(el('h3', '', t('csvSection')));
    const csvHelp = el('div', 'hint-block');
    csvHelp.innerHTML = t('csvHelp');
    b.appendChild(csvHelp);
    const file = el('input');
    file.type = 'file';
    file.accept = '.csv,.tsv,.txt,text/csv,text/plain';
    file.hidden = true;
    const replaceLabel = el('label', 'check');
    const replace = el('input');
    replace.type = 'checkbox';
    replaceLabel.append(replace, el('span', '', t('replaceValues')));
    const row = el('div', 'attr-buttons');
    const imp = el('button', 'btn', t('importCsv'));
    imp.addEventListener('click', () => file.click());
    const exp = el('button', 'btn', t('exportCsv'));
    exp.disabled = defs.length === 0;
    exp.addEventListener('click', async () => {
      try {
        await this.actions.exportCsv();
      } catch (err) {
        console.warn('export failed', err);
        this.say(t('exportFailed'), true);
      }
    });
    row.append(imp, exp);
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      imp.disabled = true;
      try {
        const report = await this.actions.importCsv(f, replace.checked);
        this.importResult = this.reportView(report);
      } catch (err) {
        console.error(err);
        this.importResult = el('p', 'attr-message error', t('importFailed'));
      }
      this.render();
    });
    b.append(file, replaceLabel, row);
    if (keepResult) b.appendChild(keepResult);

    // --- storage
    b.appendChild(el('h3', '', t('storageSection')));
    b.appendChild(el('p', 'hint', t('storageHelp')));
    const store = el('div', 'attr-buttons');
    if (this.actions.hasSiteData()) {
      b.appendChild(el('p', 'hint', t('siteDataHelp')));
      const reset = confirmingButton(
        t('resetToSite'),
        () => t('reallyReset'),
        async () => {
          await this.actions.resetToSite();
          this.importResult = null;
          this.render();
        },
        'btn subtle',
      );
      store.appendChild(reset);
    }
    const del = confirmingButton(
      t('deleteMyData'),
      () => t('reallyDelete'),
      () => {
        this.actions.deleteAll();
        this.importResult = null;
        this.render();
      },
      'btn subtle',
    );
    del.disabled = defs.length === 0;
    store.appendChild(del);
    b.appendChild(store);
  }

  /** Name and text values of an attribute in each language of the app. */
  private translationEditor(def: AttributeDef): HTMLElement {
    const box = el('div', 'attr-translate');
    box.dataset.translate = def.id;
    box.appendChild(el('h4', '', t('translationsTitle')));
    box.appendChild(el('p', 'hint', t('translationsHelp')));
    const table = el('table', 'attr-table translate-table');
    const head = el('tr');
    head.appendChild(el('th', '', ''));
    // the current language first
    const langs = [getLang(), ...LANGS.filter((l) => l !== getLang())];
    for (const l of langs) head.appendChild(el('th', '', LANG_NAMES[l]));
    table.appendChild(el('thead')).appendChild(head);
    const tbody = el('tbody');
    const field = (value: string, placeholder: string, label: string, apply: (v: string) => boolean): HTMLInputElement => {
      const input = el('input');
      input.type = 'text';
      input.value = value;
      input.placeholder = placeholder;
      input.setAttribute('aria-label', label);
      input.addEventListener('change', () => {
        if (!apply(input.value.trim())) input.value = value;
        else value = input.value.trim();
      });
      return input;
    };
    // the name
    const nameRow = el('tr');
    nameRow.appendChild(el('th', 'translate-key', t('translationName')));
    for (const l of langs) {
      const current = () => this.attrs.def(def.id);
      const input = field(def.labels?.[l] ?? '', def.name, `${t('translationName')} (${LANG_NAMES[l]})`, (v) => {
        if (!current()) return false;
        try {
          this.attrs.setLabels(def.id, { [l]: v });
          this.say('');
          return true;
        } catch {
          this.say(t('nameTaken'), true);
          return false;
        }
      });
      nameRow.appendChild(el('td')).appendChild(input);
    }
    tbody.appendChild(nameRow);
    // the text values
    let more = 0;
    if (def.type === 'text') {
      const values = this.attrs.distinct(def.id).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const v of values.slice(0, MAX_TRANSLATED_VALUES)) {
        const row = el('tr');
        const key = el('th', 'translate-key', v);
        key.title = t('translationValue');
        row.appendChild(key);
        for (const l of langs) {
          const input = field(def.valueLabels?.[v]?.[l] ?? '', v, `${v} (${LANG_NAMES[l]})`, (label) => {
            this.attrs.setValueLabel(def.id, v, l, label === v ? null : label);
            return true;
          });
          row.appendChild(el('td')).appendChild(input);
        }
        tbody.appendChild(row);
      }
      more = values.length - MAX_TRANSLATED_VALUES;
    }
    table.appendChild(tbody);
    const scroll = el('div', 'table-scroll');
    scroll.appendChild(table);
    box.appendChild(scroll);
    if (more > 0) box.appendChild(el('p', 'hint', t('translationMore', { n: formatNumber(more) })));
    return box;
  }

  private say(text: string, warn = false): void {
    if (!this.message) return;
    this.message.textContent = text;
    this.message.classList.toggle('error', warn);
  }

  private reportView(r: ImportReport): HTMLElement {
    const box = el('div', 'attr-report');
    box.setAttribute('role', 'status');
    box.appendChild(
      el('p', '', t('importDone', { rows: formatNumber(r.rows), matched: formatNumber(r.matched), unverified: formatNumber(r.unverified) })),
    );
    const ul = el('ul');
    for (const a of r.attributes) {
      const extra: string[] = [];
      if (a.created) extra.push(t('importCreated'));
      if (a.rejected) extra.push(t('importRejected', { n: formatNumber(a.rejected) }));
      if (a.languages.length) {
        extra.push(t('importTranslated', { langs: a.languages.map((l) => LANG_NAMES[l]).join(', '), n: formatNumber(a.translated) }));
      }
      const typeKey = TYPES.find(([v]) => v === a.type)?.[1] ?? 'typeText';
      ul.appendChild(
        el(
          'li',
          '',
          `${t('importAttrLine', { name: a.name, values: formatNumber(a.values) })} · ${t(typeKey)}${a.system ? ` · ${t('attrSystem')}` : ''}${extra.length ? ` (${extra.join(', ')})` : ''}`,
        ),
      );
    }
    box.appendChild(ul);
    if (r.unresolved.length) {
      const shown = r.unresolved.slice(0, 20).join(', ') + (r.unresolved.length > 20 ? ', …' : '');
      box.appendChild(el('p', 'attr-message error', t('importUnresolved', { n: formatNumber(r.unresolved.length), list: shown })));
    }
    return box;
  }
}
