import type { AttrType, AttributeStore } from '../data/attributes';
import type { ImportReport } from '../data/importer';
import { formatNumber, t, type MessageKey } from '../i18n';

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

/** Content of the "Attributes & CSV" dialog: attribute list, new attribute, CSV, storage. */
export class AttributesDialog {
  readonly body = el('div', 'dialog-body attr-dialog');
  private message: HTMLElement | null = null;
  private importResult: HTMLElement | null = null;

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
        const del = el('button', 'btn subtle small', t('deleteAttr'));
        del.addEventListener('click', () => {
          const n = this.attrs.valueCount(def.id);
          if (n > 0 && !window.confirm(t('confirmDeleteAttr', { name: def.name, n: formatNumber(n) }))) return;
          this.attrs.removeDef(def.id);
          this.render();
        });
        const cells = [name, type, sys, el('span', 'count', formatNumber(this.attrs.valueCount(def.id))), del];
        for (const c of cells) tr.appendChild(el('td')).appendChild(c);
        tbody.appendChild(tr);
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
    exp.addEventListener('click', () => void this.actions.exportCsv());
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
      const reset = el('button', 'btn subtle', t('resetToSite'));
      reset.addEventListener('click', async () => {
        if (!window.confirm(t('confirmDeleteData'))) return;
        await this.actions.resetToSite();
        this.importResult = null;
        this.render();
      });
      store.appendChild(reset);
    }
    const del = el('button', 'btn subtle', t('deleteMyData'));
    del.disabled = defs.length === 0;
    del.addEventListener('click', () => {
      if (!window.confirm(t('confirmDeleteData'))) return;
      this.actions.deleteAll();
      this.importResult = null;
      this.render();
    });
    store.appendChild(del);
    b.appendChild(store);
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
