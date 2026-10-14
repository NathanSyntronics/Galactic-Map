import './styles.css';
import { App } from './app';

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

const container = document.getElementById('app')!;
if (!webglAvailable()) {
  container.textContent = 'WebGL is not available in this browser. / WebGL ist in diesem Browser nicht verfügbar.';
  container.className = 'fatal';
} else {
  const app = new App(container);
  void app.start();
}
