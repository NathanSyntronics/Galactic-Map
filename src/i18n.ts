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
  radiusHint: 'Stars within this distance of the view centre are shown. While it follows the zoom, zooming out shows a larger region.',
  autoRadius: 'Radius follows zoom',
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
  search: 'Search stars and galaxies…',
  noResults: 'No matches',
  recentSearches: 'Recent',
  searchUnavailable: 'The star catalogue could not be loaded. Try again later.',
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
  galaxies: 'Galaxies',
  planets: 'Planets',
  planetSpeed: 'Planet motion',
  speedReal: 'real time (as now)',
  speedDay: '1 day per second',
  speedMonth: '1 month per second',
  speedYear: '1 year per second',
  planet: 'Planet',
  planetRocky: 'Rocky planet',
  planetSubNeptune: 'Mini-Neptune',
  planetIceGiant: 'Ice giant',
  planetGasGiant: 'Gas giant',
  planetHot: 'hot',
  solarSystem: 'Solar System',
  hostStar: 'Star',
  semiMajorAxis: 'Semi-major axis',
  eccentricity: 'Eccentricity',
  orbitalPeriod: 'Orbital period',
  planetRadius: 'Radius',
  planetMass: 'Mass',
  eqTemperature: 'Equilibrium temperature',
  inclinationSky: 'Inclination (to the sky)',
  inclinationEcliptic: 'Inclination (to the ecliptic)',
  discovered: 'Discovered',
  estimatedFromMass: 'estimated from the mass',
  assumedCircular: 'not measured, drawn circular',
  orbitNote: 'How the orbit is turned about the line of sight is not known: the map chooses it.',
  orbitNoteAssumed: 'Not measured, chosen by the map: {what}.',
  assumedInclination: 'the inclination',
  assumedPhase: 'the position on the orbit',
  daysN: '{n} days',
  yearsN: '{n} years',
  au: 'AU',
  km: 'km',
  kmMillion: '{n} million km',
  openExoplanetArchive: 'NASA Exoplanet Archive',
  showPlanets: 'Show planets',
  planetDate: 'Positions on {date}',
  milkyWay: 'Milky Way as a model',
  galaxy: 'Galaxy',
  galaxySpiral: 'Spiral galaxy',
  galaxyLenticular: 'Lenticular galaxy',
  galaxyElliptical: 'Elliptical galaxy',
  galaxyIrregular: 'Irregular galaxy',
  galaxySpheroidal: 'Dwarf spheroidal galaxy',
  galaxyBarredSpiral: 'Barred spiral galaxy',
  localGroup: 'Local Group',
  distanceToCentre: 'Distance to its centre',
  distanceMethod: 'Distance measured via',
  methodTRGB: 'its brightest red giant stars',
  methodCep: 'pulsating stars (Cepheids)',
  methodMaser: 'gas clouds near its centre, geometrically',
  methodSBF: 'how grainy its light looks',
  methodSNIa: 'a supernova of known brightness',
  methodSNII: 'a supernova',
  methodFP: 'its size, brightness and the speed of its stars',
  methodTF: 'its rotation and brightness',
  methodRR: 'pulsating stars (RR Lyrae)',
  methodHB: 'the brightness of its old stars',
  methodCMD: 'the brightness and colours of its stars',
  methodBS: 'its brightest stars (rough)',
  methodPNLF: 'glowing gas shells of dying stars',
  methodMem: 'the group it belongs to (estimate)',
  methodTxt: 'its appearance (rough estimate)',
  methodGeom: 'direct geometric measurement',
  diameter: 'Diameter',
  openNed: 'Look up in NED',
  milkyWayModelSource: 'model (stylised: bar, four arms and the Local Arm)',
  lyMillion: '{n} million ly',
  lyBillion: '{n} billion ly',
  galaxySources: 'Galaxies:',
  unknown: 'unknown',
  stats: '{loaded} stars loaded · {visible} in view',
  statsGalaxies: '{n} galaxies in view',
  statsGalaxiesOne: '1 galaxy in view',
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
<li><b>H</b>: back to the Sun · <b>L</b>: names · <b>G</b>: grid · <b>J</b>: jump network · <b>/</b>: search · <b>Esc</b>: deselect</li>
</ul>
<p>The view centre is the point the camera orbits around. Only stars inside the visible radius around it are shown; move the centre to explore further. The radius follows the zoom: zooming out shows a larger region (this can be switched off in the settings).</p>
<p>The grid lies parallel to the galactic plane. 0° points towards the Galactic Centre, 90° in the direction of Galactic rotation.</p>
<p>The jump network links stars up to the jump range apart (9 ly by default); brighter stars get more links. A star's info card lists its links; click one to go there.</p>
<p>Routes: “Route from here” and “Route to here” on a star’s info card plan a route through the jump network, also between distant stars (the Sun and Betelgeuse, say). The route box lists the waypoints; zoomed out, only the route is drawn.</p>
<p>The search knows the stars and the galaxies. The empty search field lists the last three you picked from the search. A press anywhere beside the open settings only closes them (it selects no star); a click beside a dialog closes the dialog.</p>
<p>A click on a star's name selects that star; where many stars crowd together, labelled stars are preferred.</p>`,
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
  closeLegend: 'Hide legend',
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
  translate: 'Translate',
  translationsTitle: 'Name and values in the app’s languages',
  translationsHelp: 'Empty fields show the name or the value as it is stored. Values are typed and shown in the current language; a value typed in another language is recognised too.',
  translationValue: 'Stored as',
  translationName: 'Name',
  translationMore: '{n} more values: translate them in a CSV file.',
  importTranslated: 'translated: {langs}, {n} values',
  reallyDeleteValues: 'Delete {n} values?',
  reallyDelete: 'Really delete?',
  reallyReset: 'Really reset?',
  exportFailed: 'The file could not be saved.',
  newAttribute: 'New attribute',
  add: 'Add',
  nameTaken: 'This name is already in use.',
  typeChangeDropped: '{n} values did not fit the new type and were removed.',
  attributesHelp: '<p>Attributes are your own data per star, e.g. a faction, an economy value or a colour. Use them in the settings under “Data layers” to colour or size the stars. Values are entered on a star’s info card or imported from a CSV file.</p><p><b>Whole system</b>: a value given to one star applies to every star of its multiple system (it is stored on the system’s primary star).</p><p><b>Translate</b>: the name and the text values can be given in each language of the app.</p>',
  csvSection: 'CSV import and export',
  csvHelp: '<p>One row per star. The first column (or a column named <i>designation</i> or <i>name</i>) names the star: a name (“Sirius”) or a catalogue designation (“HIP 32349”, “Gaia DR3 …”). Every further column is an attribute; a tag in the header sets its type and whether it applies to the whole system: <code>Faction [text, system]</code>, <code>Economy [number]</code>, <code>Colour [color]</code>. Without a tag the type follows the values. Separators “,” “;” or tab and decimal commas are recognised; empty cells are skipped.</p><p><b>Translations</b>: a column <code>Faction [de: Fraktion]</code> gives the attribute’s German name and, in each row, the German form of the row’s value (<code>[en: …]</code> for English). The export writes them the same way.</p>',
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
  resetToSite: 'Back to the site’s dataset',
  saveFailed: 'Your attributes could not be saved in this browser (storage full or blocked). Export them as CSV to keep them.',
  jumpSection: 'Jump network',
  jumps: 'Show jump links',
  jumpIntro: 'Links connect stars and multiple systems up to the jump range apart. Brighter stars get more links.',
  jumpRange: 'Jump range',
  jumpBy: 'Number of links by',
  jumpFaint: 'Faint stars (brown dwarfs)',
  jumpSun: 'Sun-like stars',
  jumpBright: 'Bright stars (from about 30 L☉)',
  jumpLow: 'Lowest value',
  jumpHigh: 'Highest value',
  jumpCapacityHint: 'Links a star wants; in between they follow the luminosity. Stars that are full can still be linked so that nobody is left alone.',
  jumpAttrHint: 'Higher values get more links, along the attribute’s scale (range and log as for the data layers, without “Reverse”). Stars without a value get the lowest number.',
  jumpHub: 'Prefer big stars',
  jumpHubHint: '0: nearest neighbours first. Higher: bright stars collect their links before small neighbours link up with each other.',
  jumpConnect: 'Connect everything in range',
  jumpConnectHint: 'Adds the shortest links that join otherwise separate groups.',
  jumpColor: 'Line colour',
  jumpColorStars: 'Star colours',
  jumpColorUniform: 'Uniform teal',
  jumpColorLength: 'By length',
  jumpOpacity: 'Line opacity',
  jumpStats: '{places} in view, {links}',
  jumpStatsLinks: '{n} links',
  jumpStatsLinksOne: '1 link',
  jumpStatsPlaces: '{n} stars and systems',
  jumpStatsPlacesOne: '1 star or system',
  jumpTooMany: 'Too many stars in the region for the jump network (more than {n}). Reduce the visible radius.',
  jumpTooManyPairs: 'Too many star pairs within the jump range. Reduce the jump range or the visible radius.',
  jumpIncomplete: 'At this detail level not all stars of the region are loaded, so the jump network is not shown. Reduce the visible radius or raise the detail level.',
  jumpLinks: 'Jump links ({n})',
  jumpVia: 'via {system}',
  jumpNone: 'No other shown star within {range}.',
  jumpKindCapacity: 'Link by capacity',
  jumpKindAlone: 'Nearest neighbour (would be alone otherwise)',
  jumpKindConnect: 'Joins separate groups',
  legendJump: 'Jump link ≤ {range}',
  legendJumpTooMany: 'Jump network: too many stars, reduce the radius',
  legendJumpHidden: 'Jump network hidden while zoomed out',
  legendRoute: 'Route',
  jumpRouteOnly: 'While a route is shown and the visible radius is larger than {r} (three jump ranges), only the route is drawn. Zoom in to see the jump network.',
  routeTitle: 'Route',
  routeFromHere: 'Route from here',
  routeToHere: 'Route to here',
  routeNoStart: 'start?',
  routeNoGoal: 'destination?',
  routeChooseFrom: 'Choose a start: “Route from here” on a star’s info card.',
  routeChooseTo: 'Choose a destination: “Route to here” on a star’s info card.',
  routeSwap: 'Swap start and destination',
  routeMode: 'Best route',
  routeModeJumps: 'Fewest jumps',
  routeModeDistance: 'Shortest distance',
  routeShowAll: 'Show whole route',
  routeFlyby: '▶ Fly the route',
  routeFlybyStop: '■ Stop',
  routeFlybyStep: 'Speed of the flyby',
  routeFlybyStepN: '{n} s per star',
  routeFlybyAt: 'Star {k} of {n}: {name}',
  routeWaypoints: 'Waypoints ({n})',
  routeRemove: 'Remove route',
  routeRetry: 'Try again',
  routeWaiting: 'Waiting for the star catalogue…',
  routeLoadingEnds: 'Loading start and destination…',
  routeLoading: 'Loading stars along the way: {loaded} of {total} tiles ({mb} of {totalMb} MB)…',
  routeComputing: 'Computing the jump network up to {w} from the straight line…',
  routeJumps: '{n} jumps',
  routeJumpsOne: '1 jump',
  routeStraight: 'straight line {d}',
  routeUnreachable: '{to} cannot be reached with a jump range of {range}; a larger range may help.',
  routeClosest: 'Closest: {place}, {d} from the destination.',
  routeTooManyPlaces: 'Up to {w} from the straight line there are too many stars for the jump network.',
  routeTooManyPairs: 'Up to {w} from the straight line there are too many star pairs within the jump range.',
  routeTooMuchData: 'The stars up to {w} from the straight line are too much data to load.',
  routeMissing: '{name} is hidden by the current settings (filters or data layers), so it is not part of the jump network.',
  routeNotFound: '{name} could not be located in the star data.',
  routeLookupFailed: '{name} could not be located: the star index could not be loaded.',
  routeFailed: '{n} tiles of star data could not be loaded.',
  routeFailedOne: '1 tile of star data could not be loaded.',
  routeError: 'The route could not be computed.',
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
  radiusHint: 'Gezeigt werden Sterne bis zu dieser Entfernung vom Blickpunkt. Solange er dem Zoom folgt, zeigt Herauszoomen einen größeren Bereich.',
  autoRadius: 'Radius folgt dem Zoom',
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
  search: 'Sterne und Galaxien suchen…',
  noResults: 'Keine Treffer',
  recentSearches: 'Zuletzt gesucht',
  searchUnavailable: 'Der Sternkatalog konnte nicht geladen werden. Bitte später erneut versuchen.',
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
  galaxies: 'Galaxien',
  planets: 'Planeten',
  planetSpeed: 'Planetenbewegung',
  speedReal: 'Echtzeit (wie jetzt)',
  speedDay: '1 Tag pro Sekunde',
  speedMonth: '1 Monat pro Sekunde',
  speedYear: '1 Jahr pro Sekunde',
  planet: 'Planet',
  planetRocky: 'Gesteinsplanet',
  planetSubNeptune: 'Mini-Neptun',
  planetIceGiant: 'Eisriese',
  planetGasGiant: 'Gasriese',
  planetHot: 'heiß',
  solarSystem: 'Sonnensystem',
  hostStar: 'Stern',
  semiMajorAxis: 'Große Halbachse',
  eccentricity: 'Exzentrizität',
  orbitalPeriod: 'Umlaufzeit',
  planetRadius: 'Radius',
  planetMass: 'Masse',
  eqTemperature: 'Gleichgewichtstemperatur',
  inclinationSky: 'Bahnneigung (zum Himmel)',
  inclinationEcliptic: 'Bahnneigung (zur Ekliptik)',
  discovered: 'Entdeckt',
  estimatedFromMass: 'aus der Masse geschätzt',
  assumedCircular: 'nicht gemessen, kreisförmig gezeichnet',
  orbitNote: 'Wie die Bahn um die Sichtlinie gedreht ist, ist unbekannt: die Karte wählt es.',
  orbitNoteAssumed: 'Nicht gemessen, von der Karte gewählt: {what}.',
  assumedInclination: 'die Bahnneigung',
  assumedPhase: 'die Position auf der Bahn',
  daysN: '{n} Tage',
  yearsN: '{n} Jahre',
  au: 'AE',
  km: 'km',
  kmMillion: '{n} Mio. km',
  openExoplanetArchive: 'NASA Exoplanet Archive',
  showPlanets: 'Planeten zeigen',
  planetDate: 'Positionen am {date}',
  milkyWay: 'Milchstraße als Modell',
  galaxy: 'Galaxie',
  galaxySpiral: 'Spiralgalaxie',
  galaxyLenticular: 'Linsenförmige Galaxie',
  galaxyElliptical: 'Elliptische Galaxie',
  galaxyIrregular: 'Irreguläre Galaxie',
  galaxySpheroidal: 'Sphäroidale Zwerggalaxie',
  galaxyBarredSpiral: 'Balkenspiralgalaxie',
  localGroup: 'Lokale Gruppe',
  distanceToCentre: 'Entfernung zum Zentrum',
  distanceMethod: 'Entfernung gemessen über',
  methodTRGB: 'ihre hellsten Roten Riesen',
  methodCep: 'pulsierende Sterne (Cepheiden)',
  methodMaser: 'Gaswolken nahe ihrem Zentrum, geometrisch',
  methodSBF: 'wie körnig ihr Licht aussieht',
  methodSNIa: 'eine Supernova bekannter Helligkeit',
  methodSNII: 'eine Supernova',
  methodFP: 'Größe, Helligkeit und Tempo ihrer Sterne',
  methodTF: 'ihre Rotation und Helligkeit',
  methodRR: 'pulsierende Sterne (RR Lyrae)',
  methodHB: 'die Helligkeit ihrer alten Sterne',
  methodCMD: 'Helligkeit und Farbe ihrer Sterne',
  methodBS: 'ihre hellsten Sterne (grob)',
  methodPNLF: 'leuchtende Gashüllen sterbender Sterne',
  methodMem: 'ihre Galaxiengruppe (Schätzung)',
  methodTxt: 'ihr Aussehen (grobe Schätzung)',
  methodGeom: 'direkte geometrische Messung',
  diameter: 'Durchmesser',
  openNed: 'In NED nachschlagen',
  milkyWayModelSource: 'Modell (stilisiert: Balken, vier Arme und der Orion-Arm)',
  lyMillion: '{n} Mio. Lj',
  lyBillion: '{n} Mrd. Lj',
  galaxySources: 'Galaxien:',
  unknown: 'unbekannt',
  stats: '{loaded} Sterne geladen · {visible} sichtbar',
  statsGalaxies: '{n} Galaxien sichtbar',
  statsGalaxiesOne: '1 Galaxie sichtbar',
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
<li><b>H</b>: zurück zur Sonne · <b>L</b>: Namen · <b>G</b>: Gitter · <b>J</b>: Sprungnetz · <b>/</b>: Suche · <b>Esc</b>: Auswahl aufheben</li>
</ul>
<p>Der Blickpunkt ist der Punkt, um den sich die Kamera dreht. Angezeigt werden nur Sterne innerhalb des sichtbaren Radius um ihn; verschiebe den Blickpunkt, um weiter zu erkunden. Der Radius folgt dem Zoom: Herauszoomen zeigt einen größeren Bereich (abschaltbar in den Einstellungen).</p>
<p>Das Gitter liegt parallel zur galaktischen Ebene. 0° zeigt zum Galaktischen Zentrum, 90° in Richtung der galaktischen Rotation.</p>
<p>Das Sprungnetz verbindet Sterne bis zur Sprungweite (standardmäßig 9 Lj); hellere Sterne bekommen mehr Verbindungen. Die Infokarte eines Sterns listet seine Verbindungen auf; ein Klick darauf führt dorthin.</p>
<p>Routen: „Route von hier“ und „Route hierher“ in der Infokarte eines Sterns planen eine Route durch das Sprungnetz, auch zwischen weit entfernten Sternen (etwa der Sonne und Beteigeuze). Das Routenfeld listet die Wegpunkte; herausgezoomt wird nur die Route gezeichnet.</p>
<p>Die Suche kennt Sterne und Galaxien. Das leere Suchfeld zeigt die drei zuletzt über die Suche gewählten. Ein Druck irgendwo neben die offenen Einstellungen schließt nur diese (es wird kein Stern gewählt); ein Klick neben einen Dialog schließt den Dialog.</p>
<p>Ein Klick auf den Namen eines Sterns wählt diesen Stern; wo sich viele Sterne drängen, haben beschriftete Sterne Vorrang.</p>`,
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
  closeLegend: 'Legende ausblenden',
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
  translate: 'Übersetzen',
  translationsTitle: 'Name und Werte in den Sprachen der App',
  translationsHelp: 'Leere Felder zeigen den Namen oder Wert so, wie er gespeichert ist. Werte werden in der aktuellen Sprache angezeigt und eingegeben; ein Wert in einer anderen Sprache wird ebenfalls erkannt.',
  translationValue: 'Gespeichert als',
  translationName: 'Name',
  translationMore: '{n} weitere Werte: übersetze sie in einer CSV-Datei.',
  importTranslated: 'übersetzt: {langs}, {n} Werte',
  reallyDeleteValues: '{n} Werte löschen?',
  reallyDelete: 'Wirklich löschen?',
  reallyReset: 'Wirklich zurücksetzen?',
  exportFailed: 'Die Datei konnte nicht gespeichert werden.',
  newAttribute: 'Neues Attribut',
  add: 'Hinzufügen',
  nameTaken: 'Dieser Name ist schon vergeben.',
  typeChangeDropped: '{n} Werte passten nicht zum neuen Typ und wurden entfernt.',
  attributesHelp: '<p>Attribute sind eigene Daten pro Stern, z. B. eine Fraktion, ein Wirtschaftswert oder eine Farbe. In den Einstellungen unter „Datenebenen“ bestimmen sie Farbe oder Größe der Sterne. Werte gibst du in der Infokarte eines Sterns ein oder importierst sie aus einer CSV-Datei.</p><p><b>Ganzes System</b>: Ein Wert an einem Stern gilt für alle Sterne seines Mehrfachsystems (gespeichert wird er am Hauptstern des Systems).</p><p><b>Übersetzen</b>: Name und Textwerte lassen sich für jede Sprache der App angeben.</p>',
  csvSection: 'CSV-Import und -Export',
  csvHelp: '<p>Eine Zeile pro Stern. Die erste Spalte (oder eine Spalte <i>designation</i>, <i>Bezeichnung</i> oder <i>Name</i>) nennt den Stern: einen Namen („Sirius“) oder eine Katalogbezeichnung („HIP 32349“, „Gaia DR3 …“). Jede weitere Spalte ist ein Attribut; eine Angabe in eckigen Klammern im Spaltenkopf legt Typ und Systembezug fest: <code>Fraktion [text, system]</code>, <code>Wirtschaft [zahl]</code>, <code>Farbe [farbe]</code>. Ohne Angabe richtet sich der Typ nach den Werten. Trennzeichen „,“ „;“ oder Tab und Dezimalkommas werden erkannt; leere Zellen werden übersprungen.</p><p><b>Übersetzungen</b>: Eine Spalte <code>Faction [de: Fraktion]</code> gibt den deutschen Namen des Attributs an und in jeder Zeile die deutsche Form des Werts dieser Zeile (<code>[en: …]</code> für Englisch). Der Export schreibt sie genauso.</p>',
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
  resetToSite: 'Zurück zum Datensatz der Seite',
  saveFailed: 'Deine Attribute konnten in diesem Browser nicht gespeichert werden (Speicher voll oder gesperrt). Exportiere sie als CSV, um sie zu behalten.',
  jumpSection: 'Sprungnetz',
  jumps: 'Sprungverbindungen anzeigen',
  jumpIntro: 'Verbindungen führen zu Sternen und Mehrfachsystemen bis zur Sprungweite. Hellere Sterne bekommen mehr Verbindungen.',
  jumpRange: 'Sprungweite',
  jumpBy: 'Anzahl der Verbindungen nach',
  jumpFaint: 'Leuchtschwache Sterne (Braune Zwerge)',
  jumpSun: 'Sonnenähnliche Sterne',
  jumpBright: 'Helle Sterne (ab etwa 30 L☉)',
  jumpLow: 'Niedrigster Wert',
  jumpHigh: 'Höchster Wert',
  jumpCapacityHint: 'Gewünschte Verbindungen eines Sterns; dazwischen richten sie sich nach der Leuchtkraft. Auch volle Sterne werden noch verbunden, damit niemand allein bleibt.',
  jumpAttrHint: 'Höhere Werte bekommen mehr Verbindungen, entlang der Skala des Attributs (Bereich und logarithmisch wie bei den Datenebenen, ohne „Umkehren“). Sterne ohne Wert bekommen die niedrigste Anzahl.',
  jumpHub: 'Große Sterne bevorzugen',
  jumpHubHint: '0: nächste Nachbarn zuerst. Höher: Helle Sterne erhalten ihre Verbindungen, bevor sich kleine Nachbarn untereinander verbinden.',
  jumpConnect: 'Alles in Reichweite verbinden',
  jumpConnectHint: 'Ergänzt die kürzesten Verbindungen, die sonst getrennte Gruppen zusammenführen.',
  jumpColor: 'Linienfarbe',
  jumpColorStars: 'Sternfarben',
  jumpColorUniform: 'Einheitlich türkis',
  jumpColorLength: 'Nach Länge',
  jumpOpacity: 'Deckkraft der Linien',
  jumpStats: '{places} sichtbar, {links}',
  jumpStatsLinks: '{n} Verbindungen',
  jumpStatsLinksOne: '1 Verbindung',
  jumpStatsPlaces: '{n} Sterne und Systeme',
  jumpStatsPlacesOne: '1 Stern oder System',
  jumpTooMany: 'Zu viele Sterne in der Umgebung für das Sprungnetz (mehr als {n}). Verkleinere den sichtbaren Radius.',
  jumpTooManyPairs: 'Zu viele Sternpaare innerhalb der Sprungweite. Verkleinere die Sprungweite oder den sichtbaren Radius.',
  jumpIncomplete: 'Bei diesem Detailgrad sind nicht alle Sterne der Umgebung geladen, deshalb wird das Sprungnetz nicht gezeigt. Verkleinere den sichtbaren Radius oder erhöhe den Detailgrad.',
  jumpLinks: 'Sprungverbindungen ({n})',
  jumpVia: 'über {system}',
  jumpNone: 'Kein anderer angezeigter Stern innerhalb von {range}.',
  jumpKindCapacity: 'Verbindung nach Kapazität',
  jumpKindAlone: 'Nächster Nachbar (sonst ohne Verbindung)',
  jumpKindConnect: 'Verbindet getrennte Gruppen',
  legendJump: 'Sprungverbindung ≤ {range}',
  legendJumpTooMany: 'Sprungnetz: zu viele Sterne, Radius verkleinern',
  legendJumpHidden: 'Sprungnetz beim Herauszoomen ausgeblendet',
  legendRoute: 'Route',
  jumpRouteOnly: 'Solange eine Route gezeigt wird und der sichtbare Radius größer als {r} (drei Sprungweiten) ist, wird nur die Route gezeichnet. Hineinzoomen zeigt das Sprungnetz.',
  routeTitle: 'Route',
  routeFromHere: 'Route von hier',
  routeToHere: 'Route hierher',
  routeNoStart: 'Start?',
  routeNoGoal: 'Ziel?',
  routeChooseFrom: 'Start wählen: „Route von hier“ in der Infokarte eines Sterns.',
  routeChooseTo: 'Ziel wählen: „Route hierher“ in der Infokarte eines Sterns.',
  routeSwap: 'Start und Ziel tauschen',
  routeMode: 'Beste Route',
  routeModeJumps: 'Wenigste Sprünge',
  routeModeDistance: 'Kürzeste Strecke',
  routeShowAll: 'Ganze Route zeigen',
  routeFlyby: '▶ Route abfliegen',
  routeFlybyStop: '■ Stopp',
  routeFlybyStep: 'Tempo des Flugs',
  routeFlybyStepN: '{n} s pro Stern',
  routeFlybyAt: 'Stern {k} von {n}: {name}',
  routeWaypoints: 'Wegpunkte ({n})',
  routeRemove: 'Route entfernen',
  routeRetry: 'Erneut versuchen',
  routeWaiting: 'Warte auf den Sternkatalog…',
  routeLoadingEnds: 'Start und Ziel werden geladen…',
  routeLoading: 'Sterne entlang des Wegs werden geladen: {loaded} von {total} Kacheln ({mb} von {totalMb} MB)…',
  routeComputing: 'Sprungnetz bis {w} um die gerade Linie wird berechnet…',
  routeJumps: '{n} Sprünge',
  routeJumpsOne: '1 Sprung',
  routeStraight: 'Luftlinie {d}',
  routeUnreachable: '{to} ist mit einer Sprungweite von {range} nicht erreichbar; eine größere Sprungweite kann helfen.',
  routeClosest: 'Am nächsten: {place}, {d} vom Ziel.',
  routeTooManyPlaces: 'Bis {w} um die gerade Linie liegen zu viele Sterne für das Sprungnetz.',
  routeTooManyPairs: 'Bis {w} um die gerade Linie gibt es zu viele Sternpaare innerhalb der Sprungweite.',
  routeTooMuchData: 'Die Sterne bis {w} um die gerade Linie sind zu viele Daten zum Laden.',
  routeMissing: '{name} ist mit den aktuellen Einstellungen (Filter oder Datenebenen) ausgeblendet und deshalb nicht Teil des Sprungnetzes.',
  routeNotFound: '{name} wurde in den Sterndaten nicht gefunden.',
  routeLookupFailed: '{name} wurde nicht gefunden: Der Sternindex konnte nicht geladen werden.',
  routeFailed: '{n} Kacheln mit Sterndaten konnten nicht geladen werden.',
  routeFailedOne: '1 Kachel mit Sterndaten konnte nicht geladen werden.',
  routeError: 'Die Route konnte nicht berechnet werden.',
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

/** Status line of the jump network, with singular forms. */
export function jumpStatsText(links: number, places: number): string {
  return t('jumpStats', {
    places: places === 1 ? t('jumpStatsPlacesOne') : t('jumpStatsPlaces', { n: formatNumber(places) }),
    links: links === 1 ? t('jumpStatsLinksOne') : t('jumpStatsLinks', { n: formatNumber(links) }),
  });
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

const AU_PER_LY = 63241.077;
const KM_PER_LY = 9.4607304725808e12;

/** Distance in kilometres: in millions with three significant digits, below a million rounded to three. */
export function formatKm(km: number): string {
  const r = Number(km.toPrecision(3));
  // three significant digits without trailing zeros (the grid's 2 million km, not 2.00)
  if (Math.abs(r) >= 1e6) return t('kmMillion', { n: (km / 1e6).toLocaleString(locale(), { maximumSignificantDigits: 3 }) });
  return `${formatNumber(r, 0)} ${t('km')}`;
}

/**
 * The unit a distance is written in: kilometres below 1 AU (close to a star), astronomical units
 * below 0.05 ly (3,162 AU, within planetary systems), else light years.
 */
export function distanceUnit(ly: number): 'km' | 'au' | 'ly' {
  const a = Math.abs(ly);
  if (a !== 0 && a * AU_PER_LY < 1) return 'km';
  if (a !== 0 && a < 0.05) return 'au';
  return 'ly';
}

/** Units of distanceUnit(ly) per light year. */
export function distanceUnitScale(ly: number): number {
  const u = distanceUnit(ly);
  return u === 'km' ? KM_PER_LY : u === 'au' ? AU_PER_LY : 1;
}

/**
 * Distance in light years with sensible precision, in the unit of `unitOf` (by default of the
 * distance itself; the grid writes all its rings in the unit of its radius).
 */
export function formatLy(ly: number, unitOf = ly): string {
  const unit = distanceUnit(unitOf);
  if (unit === 'km') return formatKm(ly * KM_PER_LY);
  const au = Math.abs(ly) * AU_PER_LY;
  if (unit === 'au') return `${formatNumber(Math.sign(ly) * au, au >= 100 || au === 0 ? 0 : Math.max(0, Math.min(2 - Math.floor(Math.log10(au)), 6)))} ${t('au')}`;
  // a million light years and more: in millions or billions, three significant digits
  if (Math.abs(ly) >= 1e9) return t('lyBillion', { n: formatNumber(ly / 1e9, sigDigits(ly / 1e9)) });
  if (Math.abs(ly) >= 1e6) return t('lyMillion', { n: formatNumber(ly / 1e6, sigDigits(ly / 1e6)) });
  const digits = ly < 10 ? 2 : ly < 100 ? 1 : 0;
  return `${formatNumber(ly, digits)} ${t('ly')}`;
}

function sigDigits(x: number): number {
  const a = Math.abs(x);
  return a < 10 ? 2 : a < 100 ? 1 : 0;
}

/** Display name of a star in the current language. */
export function localName(en: string, de: string | null): string {
  return current === 'de' && de ? de : en;
}
