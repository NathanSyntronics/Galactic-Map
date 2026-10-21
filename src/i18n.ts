import type { Lang } from './settings';

const en = {
  appTitle: 'Galactic Map',
  loading: 'Loading star catalogue…',
  noData: 'No star data found. Run the data pipeline first (see README).',
  loadError: 'Could not load the star catalogue.',
  settings: 'Settings',
  view: 'View',
  stars: 'Stars',
  labelsSection: 'Labels',
  display: 'Display',
  language: 'Language',
  radius: 'Visible radius',
  radiusHint: 'Stars within this distance of the view centre are shown.',
  qualityHint: 'How many stars may be loaded at once. This only matters for large view radii (from about 200 ly); the faintest stars are left out first.',
  labels: 'Show names',
  labelCount: 'Number of labels',
  labelDesignations: 'Label unnamed stars with catalogue designations',
  brownDwarfs: 'Show brown dwarfs',
  whiteDwarfs: 'Show white dwarfs',
  maxDistErr: 'Max. distance uncertainty',
  noLimit: 'no limit',
  starSize: 'Star size',
  brightness: 'Brightness',
  saturation: 'Colour saturation',
  grid: 'Galactic grid',
  dropLines: 'Height lines to grid',
  quality: 'Detail (point budget)',
  qualityLow: 'Low',
  qualityMedium: 'Medium',
  qualityHigh: 'High',
  qualityUltra: 'Very high',
  resetSettings: 'Reset settings',
  goToSun: 'Back to the Sun',
  search: 'Search star…',
  noResults: 'No matches',
  help: 'Controls',
  about: 'About & sources',
  close: 'Close',
  distanceFromSun: 'Distance from Sun',
  distanceFromCentre: 'Distance from view centre',
  galacticCoords: 'Galactic coordinates',
  galacticXYZ: 'Galactic X / Y / Z',
  spectralType: 'Spectral type',
  temperature: 'Temperature',
  absMag: 'Absolute magnitude (V)',
  luminosity: 'Luminosity',
  distUncertainty: 'Distance uncertainty',
  distEstimated: 'estimate, no parallax',
  designation: 'Designation',
  otherNames: 'Other designations',
  system: 'Multiple system',
  systemMembers: 'members',
  source: 'Data source',
  srcCensus20: '20 pc census',
  brownDwarf: 'Brown dwarf',
  whiteDwarf: 'White dwarf',
  giant: 'Giant / supergiant',
  variable: 'Variable star',
  theSun: 'Sun',
  flyTo: 'Centre view here',
  openSimbad: 'Look up in SIMBAD',
  unknown: 'unknown',
  stats: '{loaded} stars loaded · {visible} in view',
  statsLoading: 'loading {pending} tiles…',
  statsLoadingOne: 'loading 1 tile…',
  centreLabel: 'View centre',
  galacticCentre: 'Galactic Centre',
  helpText: `
<h3>Mouse</h3>
<ul>
<li><b>Left drag</b>: rotate</li>
<li><b>Right drag</b> or <b>Shift + left drag</b>: move</li>
<li><b>Wheel</b>: zoom</li>
<li><b>Click</b> a star: details · <b>double-click</b>: centre view on it</li>
</ul>
<h3>Touch</h3>
<ul>
<li><b>One finger</b>: rotate</li>
<li><b>Two fingers</b>: pinch to zoom, drag to move</li>
<li><b>Tap</b> a star: details · <b>double-tap</b>: centre view on it</li>
</ul>
<h3>Keyboard</h3>
<ul>
<li><b>W A S D</b>: move horizontally · <b>R / F</b>: up / down</li>
<li><b>Arrow keys</b>: rotate · <b>+ / −</b>: zoom</li>
<li><b>Shift</b>: faster</li>
<li><b>H</b>: back to the Sun · <b>L</b>: names · <b>G</b>: grid · <b>/</b>: search · <b>Esc</b>: deselect</li>
</ul>
<p>The view centre is the point the camera orbits around. Only stars inside the visible radius around it are shown; move the centre to explore further.</p>
<p>The grid lies parallel to the galactic plane. 0° points towards the Galactic Centre, 90° in the direction of Galactic rotation.</p>`,
  aboutText: `
<p>Positions are computed from measured trigonometric parallaxes and sky coordinates and converted into a heliocentric galactic coordinate system (X towards the Galactic Centre, Z towards the North Galactic Pole). Stars are drawn with symbolic sizes; true stellar diameters would be invisibly small.</p>
<p>Data sources:</p>`,
  dataLayers: 'Data layers',
  colorBy: 'Colour by',
  colorTemperature: 'Temperature (natural colour)',
  sizeBy: 'Size by',
  sizeLuminosity: 'Luminosity',
  sizeUniform: 'Same size for all',
  missingStyle: 'Stars without a value',
  missingDim: 'grey and small',
  missingHide: 'hide',
  missingNormal: 'as usual',
  palette: 'Colour scale',
  paletteTurbo: 'Rainbow',
  palettePlasma: 'Plasma',
  paletteViridis: 'Viridis',
  paletteBlueRed: 'Blue – red',
  scaleFrom: 'from',
  scaleTo: 'to',
  scaleAuto: 'auto',
  logScale: 'Logarithmic',
  reverseScale: 'Reverse',
  showLegend: 'Show legend',
  manageAttributes: 'Attributes & CSV…',
  builtinGroup: 'Catalogue data',
  userGroup: 'Your attributes',
  knownPlanets: 'Known planets',
  spectralClass: 'Spectral class',
  noValue: 'no value',
  legendSize: 'Size: {name}',
  legendColorValues: 'colours of the values',
  moreCategories: '+ {n} more',
  attributes: 'Attributes',
  editAttributes: 'Edit',
  save: 'Save',
  cancel: 'Cancel',
  wholeSystem: 'whole system',
  fromSystem: 'from the system',
  noAttributes: 'No attributes defined yet.',
  removeValue: 'Remove value',
  attrName: 'Name',
  attrType: 'Type',
  typeNumber: 'Number',
  typeText: 'Text',
  typeColor: 'Colour',
  attrSystem: 'Whole system',
  attrValues: 'Values',
  deleteAttr: 'Delete',
  confirmDeleteAttr: 'Delete the attribute “{name}” and its {n} values?',
  newAttribute: 'New attribute',
  add: 'Add',
  nameTaken: 'This name is already in use.',
  typeChangeDropped: '{n} values did not fit the new type and were removed.',
  attributesHelp: '<p>Attributes are your own data per star, e.g. a faction, an economy value or a colour. Use them in the settings under “Data layers” to colour or size the stars. Values are entered on a star’s info card or imported from a CSV file.</p><p><b>Whole system</b>: a value given to one star applies to every star of its multiple system (it is stored on the system’s primary star).</p>',
  csvSection: 'CSV import and export',
  csvHelp: '<p>One row per star. The first column (or a column named <i>designation</i> or <i>name</i>) names the star: a name (“Sirius”) or a catalogue designation (“HIP 32349”, “Gaia DR3 …”). Every further column is an attribute; a tag in the header sets its type and whether it applies to the whole system: <code>Faction [text, system]</code>, <code>Economy [number]</code>, <code>Colour [color]</code>. Without a tag the type follows the values. Separators “,” “;” or tab and decimal commas are recognised; empty cells are skipped.</p>',
  importCsv: 'Import CSV…',
  replaceValues: 'Replace the old values of the imported attributes',
  exportCsv: 'Export CSV',
  importDone: '{rows} rows read: {matched} stars found by name or designation, {unverified} taken as catalogue designation.',
  importAttrLine: '{name}: {values} values',
  importCreated: 'new',
  importRejected: '{n} cells did not fit the type',
  importUnresolved: 'Not found ({n}): {list}',
  importFailed: 'The file could not be read.',
  storageSection: 'Storage',
  storageHelp: 'Your attributes are stored in this browser only. Export them as CSV to keep a copy or to move them to another device.',
  siteDataHelp: 'This site provides a dataset of its own; it is used until you change something.',
  deleteMyData: 'Delete my attributes',
  confirmDeleteData: 'Delete all your attributes and values in this browser?',
  resetToSite: 'Back to the site’s dataset',
  saveFailed: 'Your attributes could not be saved in this browser (storage full or blocked). Export them as CSV to keep them.',
  ly: 'ly',
  pc: 'pc',
};

export type MessageKey = keyof typeof en;

const de: Record<MessageKey, string> = {
  appTitle: 'Galaktische Karte',
  loading: 'Sternkatalog wird geladen…',
  noData: 'Keine Sterndaten gefunden. Bitte zuerst die Daten-Pipeline ausführen (siehe README).',
  loadError: 'Der Sternkatalog konnte nicht geladen werden.',
  settings: 'Einstellungen',
  view: 'Ansicht',
  stars: 'Sterne',
  labelsSection: 'Beschriftung',
  display: 'Darstellung',
  language: 'Sprache',
  radius: 'Sichtbarer Radius',
  radiusHint: 'Gezeigt werden Sterne bis zu dieser Entfernung vom Blickpunkt.',
  qualityHint: 'Wie viele Sterne gleichzeitig geladen werden dürfen. Das wirkt erst bei großem Sichtradius (ab etwa 200 Lj); die leuchtschwächsten Sterne fallen zuerst weg.',
  labels: 'Namen anzeigen',
  labelCount: 'Anzahl der Beschriftungen',
  labelDesignations: 'Sterne ohne Namen mit Katalognummer beschriften',
  brownDwarfs: 'Braune Zwerge anzeigen',
  whiteDwarfs: 'Weiße Zwerge anzeigen',
  maxDistErr: 'Max. Entfernungsunsicherheit',
  noLimit: 'keine Grenze',
  starSize: 'Sterngröße',
  brightness: 'Helligkeit',
  saturation: 'Farbsättigung',
  grid: 'Galaktisches Gitter',
  dropLines: 'Höhenlinien zum Gitter',
  quality: 'Detailgrad (Punktbudget)',
  qualityLow: 'Niedrig',
  qualityMedium: 'Mittel',
  qualityHigh: 'Hoch',
  qualityUltra: 'Sehr hoch',
  resetSettings: 'Einstellungen zurücksetzen',
  goToSun: 'Zurück zur Sonne',
  search: 'Stern suchen…',
  noResults: 'Keine Treffer',
  help: 'Steuerung',
  about: 'Info & Quellen',
  close: 'Schließen',
  distanceFromSun: 'Entfernung zur Sonne',
  distanceFromCentre: 'Entfernung zum Blickpunkt',
  galacticCoords: 'Galaktische Koordinaten',
  galacticXYZ: 'Galaktisch X / Y / Z',
  spectralType: 'Spektraltyp',
  temperature: 'Temperatur',
  absMag: 'Absolute Helligkeit (V)',
  luminosity: 'Leuchtkraft',
  distUncertainty: 'Entfernungsunsicherheit',
  distEstimated: 'Schätzung, keine Parallaxe',
  designation: 'Bezeichnung',
  otherNames: 'Weitere Bezeichnungen',
  system: 'Mehrfachsystem',
  systemMembers: 'Mitglieder',
  source: 'Datenquelle',
  srcCensus20: '20-pc-Zensus',
  brownDwarf: 'Brauner Zwerg',
  whiteDwarf: 'Weißer Zwerg',
  giant: 'Riese / Überriese',
  variable: 'Veränderlicher Stern',
  theSun: 'Sonne',
  flyTo: 'Blickpunkt hierher',
  openSimbad: 'In SIMBAD nachschlagen',
  unknown: 'unbekannt',
  stats: '{loaded} Sterne geladen · {visible} sichtbar',
  statsLoading: 'lade {pending} Kacheln…',
  statsLoadingOne: 'lade 1 Kachel…',
  centreLabel: 'Blickpunkt',
  galacticCentre: 'Galaktisches Zentrum',
  helpText: `
<h3>Maus</h3>
<ul>
<li><b>Linke Maustaste ziehen</b>: drehen</li>
<li><b>Rechte Maustaste ziehen</b> oder <b>Umschalt + links ziehen</b>: verschieben</li>
<li><b>Mausrad</b>: zoomen</li>
<li><b>Klick</b> auf einen Stern: Details · <b>Doppelklick</b>: Blickpunkt dorthin</li>
</ul>
<h3>Touch</h3>
<ul>
<li><b>Ein Finger</b>: drehen</li>
<li><b>Zwei Finger</b>: spreizen zum Zoomen, ziehen zum Verschieben</li>
<li><b>Tippen</b> auf einen Stern: Details · <b>Doppeltippen</b>: Blickpunkt dorthin</li>
</ul>
<h3>Tastatur</h3>
<ul>
<li><b>W A S D</b>: horizontal bewegen · <b>R / F</b>: hoch / runter</li>
<li><b>Pfeiltasten</b>: drehen · <b>+ / −</b>: zoomen</li>
<li><b>Umschalt</b>: schneller</li>
<li><b>H</b>: zurück zur Sonne · <b>L</b>: Namen · <b>G</b>: Gitter · <b>/</b>: Suche · <b>Esc</b>: Auswahl aufheben</li>
</ul>
<p>Der Blickpunkt ist der Punkt, um den sich die Kamera dreht. Angezeigt werden nur Sterne innerhalb des sichtbaren Radius um ihn; verschiebe den Blickpunkt, um weiter zu erkunden.</p>
<p>Das Gitter liegt parallel zur galaktischen Ebene. 0° zeigt zum Galaktischen Zentrum, 90° in Richtung der galaktischen Rotation.</p>`,
  aboutText: `
<p>Die Positionen werden aus gemessenen trigonometrischen Parallaxen und Himmelskoordinaten berechnet und in ein heliozentrisches galaktisches Koordinatensystem umgerechnet (X zum Galaktischen Zentrum, Z zum galaktischen Nordpol). Die Sterngrößen sind symbolisch; echte Sterndurchmesser wären unsichtbar klein.</p>
<p>Datenquellen:</p>`,
  dataLayers: 'Datenebenen',
  colorBy: 'Farbe nach',
  colorTemperature: 'Temperatur (natürliche Farbe)',
  sizeBy: 'Größe nach',
  sizeLuminosity: 'Leuchtkraft',
  sizeUniform: 'Alle gleich groß',
  missingStyle: 'Sterne ohne Wert',
  missingDim: 'grau und klein',
  missingHide: 'ausblenden',
  missingNormal: 'wie gewohnt',
  palette: 'Farbskala',
  paletteTurbo: 'Regenbogen',
  palettePlasma: 'Plasma',
  paletteViridis: 'Viridis',
  paletteBlueRed: 'Blau – Rot',
  scaleFrom: 'von',
  scaleTo: 'bis',
  scaleAuto: 'auto',
  logScale: 'Logarithmisch',
  reverseScale: 'Umkehren',
  showLegend: 'Legende anzeigen',
  manageAttributes: 'Attribute & CSV…',
  builtinGroup: 'Katalogdaten',
  userGroup: 'Eigene Attribute',
  knownPlanets: 'Bekannte Planeten',
  spectralClass: 'Spektralklasse',
  noValue: 'kein Wert',
  legendSize: 'Größe: {name}',
  legendColorValues: 'Farben der Werte',
  moreCategories: '+ {n} weitere',
  attributes: 'Attribute',
  editAttributes: 'Bearbeiten',
  save: 'Speichern',
  cancel: 'Abbrechen',
  wholeSystem: 'ganzes System',
  fromSystem: 'vom System',
  noAttributes: 'Noch keine Attribute angelegt.',
  removeValue: 'Wert entfernen',
  attrName: 'Name',
  attrType: 'Typ',
  typeNumber: 'Zahl',
  typeText: 'Text',
  typeColor: 'Farbe',
  attrSystem: 'Ganzes System',
  attrValues: 'Werte',
  deleteAttr: 'Löschen',
  confirmDeleteAttr: 'Das Attribut „{name}“ mit seinen {n} Werten löschen?',
  newAttribute: 'Neues Attribut',
  add: 'Hinzufügen',
  nameTaken: 'Dieser Name ist schon vergeben.',
  typeChangeDropped: '{n} Werte passten nicht zum neuen Typ und wurden entfernt.',
  attributesHelp: '<p>Attribute sind eigene Daten pro Stern, z. B. eine Fraktion, ein Wirtschaftswert oder eine Farbe. In den Einstellungen unter „Datenebenen“ bestimmen sie Farbe oder Größe der Sterne. Werte gibst du in der Infokarte eines Sterns ein oder importierst sie aus einer CSV-Datei.</p><p><b>Ganzes System</b>: Ein Wert an einem Stern gilt für alle Sterne seines Mehrfachsystems (gespeichert wird er am Hauptstern des Systems).</p>',
  csvSection: 'CSV-Import und -Export',
  csvHelp: '<p>Eine Zeile pro Stern. Die erste Spalte (oder eine Spalte <i>designation</i>, <i>Bezeichnung</i> oder <i>Name</i>) nennt den Stern: einen Namen („Sirius“) oder eine Katalogbezeichnung („HIP 32349“, „Gaia DR3 …“). Jede weitere Spalte ist ein Attribut; eine Angabe in eckigen Klammern im Spaltenkopf legt Typ und Systembezug fest: <code>Fraktion [text, system]</code>, <code>Wirtschaft [zahl]</code>, <code>Farbe [farbe]</code>. Ohne Angabe richtet sich der Typ nach den Werten. Trennzeichen „,“ „;“ oder Tab und Dezimalkommas werden erkannt; leere Zellen werden übersprungen.</p>',
  importCsv: 'CSV importieren…',
  replaceValues: 'Alte Werte der importierten Attribute ersetzen',
  exportCsv: 'CSV exportieren',
  importDone: '{rows} Zeilen gelesen: {matched} Sterne über Name oder Bezeichnung gefunden, {unverified} als Katalogbezeichnung übernommen.',
  importAttrLine: '{name}: {values} Werte',
  importCreated: 'neu',
  importRejected: '{n} Zellen passten nicht zum Typ',
  importUnresolved: 'Nicht gefunden ({n}): {list}',
  importFailed: 'Die Datei konnte nicht gelesen werden.',
  storageSection: 'Speicherung',
  storageHelp: 'Deine Attribute werden nur in diesem Browser gespeichert. Exportiere sie als CSV, um eine Kopie zu behalten oder sie auf ein anderes Gerät zu übertragen.',
  siteDataHelp: 'Diese Seite bringt einen eigenen Datensatz mit; er gilt, bis du etwas änderst.',
  deleteMyData: 'Meine Attribute löschen',
  confirmDeleteData: 'Alle deine Attribute und Werte in diesem Browser löschen?',
  resetToSite: 'Zurück zum Datensatz der Seite',
  saveFailed: 'Deine Attribute konnten in diesem Browser nicht gespeichert werden (Speicher voll oder gesperrt). Exportiere sie als CSV, um sie zu behalten.',
  ly: 'Lj',
  pc: 'pc',
};

const dictionaries: Record<Lang, Record<MessageKey, string>> = { en, de };

let current: Lang = 'en';

export function setLang(lang: Lang): void {
  current = lang;
  document.documentElement.lang = lang;
}

export function getLang(): Lang {
  return current;
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  let s = dictionaries[current][key] ?? en[key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

/** BCP 47 locale of the current language (number formatting). */
export function locale(): string {
  return current === 'de' ? 'de-DE' : 'en-US';
}

export function formatNumber(x: number, digits = 0): string {
  return x.toLocaleString(locale(), {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

/** A number as typed in the current language: decimal comma in German, no thousands separators. */
export function numberText(v: number): string {
  const s = String(v);
  return current === 'de' ? s.replace('.', ',') : s;
}

/** Distance in light years with sensible precision. */
export function formatLy(ly: number): string {
  const digits = ly < 10 ? 2 : ly < 100 ? 1 : 0;
  return `${formatNumber(ly, digits)} ${t('ly')}`;
}

/** Display name of a star in the current language. */
export function localName(en: string, de: string | null): string {
  return current === 'de' && de ? de : en;
}
