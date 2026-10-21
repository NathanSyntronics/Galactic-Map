import './styles.css';
import { App } from './app';

const FATAL_MESSAGE =
  'WebGL 2 is not available in this browser. / WebGL 2 ist in diesem Browser nicht verfügbar.';

/** The renderer (three.js WebGLRenderer) needs WebGL 2; WebGL 1 alone is not enough. */
function webgl2Available(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

function showFatal(container: HTMLElement, err?: unknown): void {
  if (err) console.error(err);
  container.replaceChildren();
  container.textContent = FATAL_MESSAGE;
  container.className = 'fatal';
}

const container = document.getElementById('app')!;
if (!webgl2Available()) {
  showFatal(container);
} else {
  let app: App | null = null;
  try {
    app = new App(container);
  } catch (err) {
    // e.g. the WebGL context could not be created after all
    showFatal(container, err);
  }
  if (app) void app.start();
  // dev only: lets browser tests read the app's state
  if (import.meta.env.DEV && app) (window as unknown as { __app?: App }).__app = app;
}
