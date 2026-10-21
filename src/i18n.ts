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

/** Distance in light years with sensible precision. */
export function formatLy(ly: number): string {
  const digits = ly < 10 ? 2 : ly < 100 ? 1 : 0;
  return `${formatNumber(ly, digits)} ${t('ly')}`;
}

/** Display name of a star in the current language. */
export function localName(en: string, de: string | null): string {
  return current === 'de' && de ? de : en;
}
