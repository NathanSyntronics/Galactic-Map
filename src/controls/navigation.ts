import { MathUtils, PerspectiveCamera, Quaternion, Spherical, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const UP = new Vector3(0, 1, 0);

type KeyAction =
  | 'forward' | 'back' | 'left' | 'right' | 'up' | 'down'
  | 'rotLeft' | 'rotRight' | 'rotUp' | 'rotDown' | 'zoomIn' | 'zoomOut';

const CODE_ACTIONS: Record<string, KeyAction> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  KeyR: 'up',
  KeyF: 'down',
  PageUp: 'up',
  PageDown: 'down',
  ArrowLeft: 'rotLeft',
  ArrowRight: 'rotRight',
  ArrowUp: 'rotUp',
  ArrowDown: 'rotDown',
  NumpadAdd: 'zoomIn',
  NumpadSubtract: 'zoomOut',
};

/** Movement action of a key event (layout independent for letters, by character for + / -). */
function keyAction(e: KeyboardEvent): KeyAction | null {
  if (e.key === '+' || e.key === '=') return 'zoomIn';
  if (e.key === '-' || e.key === '_') return 'zoomOut';
  return CODE_ACTIONS[e.code] ?? null;
}

interface Flight {
  fromTarget: Vector3;
  toTarget: Vector3;
  fromDist: number;
  toDist: number;
  t: number;
  duration: number;
  /** Turns the view direction (target -> camera) from `fromDir` to `toDir` on the way. */
  fromDir?: Vector3;
  turn?: Quaternion;
}

const IDENTITY = new Quaternion();

/** What a two-finger touch gesture does: decided after the fingers have moved a few pixels. */
export type TwoFingerMode = 'undecided' | 'zoom' | 'pan';

/**
 * Classifies a two-finger gesture from the change of the finger distance (d0 -> d) and the
 * movement of their midpoint (dm, CSS px): once either exceeds the threshold, a pinch (the
 * distance changes at least about as much as the midpoint moves) only zooms, so that the view
 * centre stays where it is; otherwise the fingers pan (and may zoom as well).
 */
export function twoFingerMode(d0: number, d: number, dm: number, threshold = 10): TwoFingerMode {
  const dd = Math.abs(d - d0);
  if (Math.max(dd, dm) < threshold) return 'undecided';
  return dd >= 0.8 * dm ? 'zoom' : 'pan';
}

/**
 * Orbit-style navigation around a view centre (the orbit target):
 * mouse / touch via OrbitControls, plus keyboard movement and animated fly-to.
 */
export class Navigation {
  readonly controls: OrbitControls;
  private readonly keys = new Map<string, KeyAction>();
  private fast = false;
  private flight: Flight | null = null;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly spherical = new Spherical();
  /** Called whenever the view changes (camera or target moved). */
  onChange: () => void = () => {};
  /** Keyboard shortcuts that are not movement (handled by the app). */
  onShortcut: (key: string, e: KeyboardEvent) => void = () => {};

  constructor(
    readonly camera: PerspectiveCamera,
    readonly dom: HTMLElement,
  ) {
    const c = new OrbitControls(camera, dom);
    c.enableDamping = true;
    c.dampingFactor = 0.12;
    c.screenSpacePanning = true;
    c.rotateSpeed = 0.6;
    c.zoomSpeed = 1.2;
    c.panSpeed = 1.0;
    c.minDistance = 0.02;
    c.maxDistance = 5_000_000_000;
    c.zoomToCursor = false;
    c.addEventListener('change', () => this.onChange());
    c.addEventListener('start', () => {
      this.flight = null;
    });
    this.controls = c;
    this.watchTwoFingers(dom);

    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this.fast = e.shiftKey;
    });
    window.addEventListener('keydown', (e) => {
      this.fast = e.shiftKey;
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  /**
   * Pinch without panning: OrbitControls zooms and pans with two fingers at once, so a pinch on a
   * centred star moved it a little. The gesture is classified (twoFingerMode) and panning switched
   * off for a pinch. These listeners run before OrbitControls' (capture phase on the window); panning
   * stays on at the second finger's touch-down, so that OrbitControls starts its pan from there.
   */
  private watchTwoFingers(dom: HTMLElement): void {
    const c = this.controls;
    const pts = new Map<number, { x: number; y: number }>();
    let gesture: { d0: number; mx: number; my: number; mode: TwoFingerMode } | null = null;
    const geometry = () => {
      const [a, b] = [...pts.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    const reset = () => {
      gesture = null;
      c.enablePan = true;
    };
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType !== 'touch' || e.target !== dom) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        reset();
        if (pts.size === 2) {
          const g = geometry();
          gesture = { d0: g.d, mx: g.mx, my: g.my, mode: 'undecided' };
        }
      },
      { capture: true },
    );
    window.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType !== 'touch' || !pts.has(e.pointerId)) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (!gesture || pts.size !== 2) return;
        if (gesture.mode === 'undecided') {
          const g = geometry();
          gesture.mode = twoFingerMode(gesture.d0, g.d, Math.hypot(g.mx - gesture.mx, g.my - gesture.my));
        }
        c.enablePan = gesture.mode === 'pan';
      },
      { capture: true },
    );
    const up = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return;
      reset();
    };
    window.addEventListener('pointerup', up, { capture: true });
    window.addEventListener('pointercancel', up, { capture: true });
  }

  get target(): Vector3 {
    return this.controls.target;
  }

  get distance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  private keyDown(e: KeyboardEvent): void {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const action = keyAction(e);
    if (action) {
      this.keys.set(e.code, action);
      this.flight = null;
      e.preventDefault();
      return;
    }
    this.onShortcut(e.key, e);
  }

  /**
   * Animate the view centre to a point; optionally change the camera distance and the direction
   * from the view centre to the camera (a unit vector; kept a little away from straight up or down).
   */
  flyTo(point: Vector3, distance?: number, duration = 1.2, direction?: Vector3): void {
    const flight: Flight = {
      fromTarget: this.controls.target.clone(),
      toTarget: point.clone(),
      fromDist: this.distance,
      toDist: distance ?? this.distance,
      t: 0,
      duration,
    };
    if (direction && direction.lengthSq() > 0) {
      const from = this.camera.position.clone().sub(this.controls.target);
      if (from.lengthSq() < 1e-12) from.set(0, 0, 1);
      from.normalize();
      const to = direction.clone().normalize();
      to.y = MathUtils.clamp(to.y, -0.97, 0.97);
      const h = Math.hypot(to.x, to.z) || 1;
      const k = Math.sqrt(1 - to.y * to.y) / h;
      to.x *= k;
      to.z *= k;
      if (to.x === 0 && to.z === 0) to.x = Math.sqrt(1 - to.y * to.y);
      flight.fromDir = from;
      flight.turn = new Quaternion().setFromUnitVectors(from, to);
    }
    this.flight = flight;
  }

  /** Sets the camera distance at once, keeping the view centre and direction (a running flight keeps its target). */
  setDistance(distance: number): void {
    const c = this.controls;
    const d = MathUtils.clamp(distance, c.minDistance, c.maxDistance);
    const offset = this.tmp.copy(this.camera.position).sub(c.target);
    if (offset.lengthSq() < 1e-12) offset.set(0, 0, 1);
    offset.setLength(d);
    this.camera.position.copy(c.target).add(offset);
    if (this.flight) {
      this.flight.fromDist = d;
      this.flight.toDist = d;
    }
    this.onChange();
  }

  /** Jump without animation. */
  setView(target: Vector3, offset: Vector3): void {
    this.flight = null;
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(offset);
    this.controls.update();
    this.onChange();
  }

  /** Advance animations and keyboard movement; returns true if the view changed. */
  update(dt: number): boolean {
    let changed = false;
    const c = this.controls;
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(f.t + dt / f.duration, 1);
      const k = f.t < 0.5 ? 4 * f.t * f.t * f.t : 1 - Math.pow(-2 * f.t + 2, 3) / 2;
      const offset = this.tmp.copy(this.camera.position).sub(c.target);
      if (f.fromDir && f.turn) offset.copy(f.fromDir).applyQuaternion(new Quaternion().slerpQuaternions(IDENTITY, f.turn, k));
      const dist = Math.exp(MathUtils.lerp(Math.log(f.fromDist), Math.log(f.toDist), k));
      offset.setLength(dist);
      c.target.lerpVectors(f.fromTarget, f.toTarget, k);
      this.camera.position.copy(c.target).add(offset);
      if (f.t >= 1) this.flight = null;
      changed = true;
    }
    if (this.keys.size > 0) {
      changed = this.applyKeys(dt) || changed;
    }
    // OrbitControls.update returns true when damping is still moving the camera
    if (c.update(dt)) changed = true;
    if (changed) this.onChange();
    return changed;
  }

  private applyKeys(dt: number): boolean {
    const k = new Set(this.keys.values());
    const fast = this.fast;
    const dist = this.distance;
    const speed = dist * (fast ? 2.5 : 0.9) * dt; // move ~ one camera distance per second
    const rot = (fast ? 1.8 : 0.9) * dt;
    const c = this.controls;
    const forward = this.tmp.copy(c.target).sub(this.camera.position);
    forward.y = 0;
    if (forward.lengthSq() < 1e-12) forward.set(0, 0, -1);
    forward.normalize();
    const right = this.tmp2.crossVectors(forward, UP).normalize();
    const move = new Vector3();
    if (k.has('forward')) move.addScaledVector(forward, speed);
    if (k.has('back')) move.addScaledVector(forward, -speed);
    if (k.has('right')) move.addScaledVector(right, speed);
    if (k.has('left')) move.addScaledVector(right, -speed);
    if (k.has('up')) move.y += speed;
    if (k.has('down')) move.y -= speed;
    let changed = false;
    if (move.lengthSq() > 0) {
      c.target.add(move);
      this.camera.position.add(move);
      changed = true;
    }
    let dAz = 0;
    let dEl = 0;
    if (k.has('rotLeft')) dAz -= rot;
    if (k.has('rotRight')) dAz += rot;
    if (k.has('rotUp')) dEl -= rot;
    if (k.has('rotDown')) dEl += rot;
    let zoom = 1;
    if (k.has('zoomIn')) zoom *= Math.exp(-1.6 * dt * (fast ? 2 : 1));
    if (k.has('zoomOut')) zoom *= Math.exp(1.6 * dt * (fast ? 2 : 1));
    if (dAz !== 0 || dEl !== 0 || zoom !== 1) {
      const offset = this.tmp.copy(this.camera.position).sub(c.target);
      this.spherical.setFromVector3(offset);
      this.spherical.theta += dAz;
      this.spherical.phi = MathUtils.clamp(this.spherical.phi + dEl, 0.01, Math.PI - 0.01);
      this.spherical.radius = MathUtils.clamp(this.spherical.radius * zoom, c.minDistance, c.maxDistance);
      offset.setFromSpherical(this.spherical);
      this.camera.position.copy(c.target).add(offset);
      changed = true;
    }
    return changed;
  }

}
