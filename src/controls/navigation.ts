import { MathUtils, PerspectiveCamera, Quaternion, Spherical, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Tour } from './tour';

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

/** OrbitControls states that turn the view (mouse and one finger; two fingers that also turn). */
const ROTATE_STATES = new Set([0, 3, 6]);

/** A route flyby in progress. */
interface TourState {
  tour: Tour;
  /** Flying to the first waypoint, then along the route. */
  phase: 'approach' | 'run';
  /** The camera turns to look along the route, until the user turns the view. */
  steer: boolean;
  /** Where the view centre was relative to the route when the run began; fades out. */
  lag: Vector3;
  index: number;
}

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
  private tourState: TourState | null = null;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly spherical = new Spherical();
  /** Called whenever the view changes (camera or target moved). */
  onChange: () => void = () => {};
  /** Keyboard shortcuts that are not movement (handled by the app). */
  onShortcut: (key: string, e: KeyboardEvent) => void = () => {};
  /** The flyby passed the waypoint nearest to it changed (index into its points). */
  onTourStep: (index: number) => void = () => {};
  /** The flyby ended: at the destination (finished) or stopped. */
  onTourEnd: (finished: boolean) => void = () => {};

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
    // down to the orbits of the innermost planets (a visible radius of 1e-7 ly, see RADIUS_MIN)
    c.minDistance = 2.2e-7;
    c.maxDistance = 5_000_000_000;
    c.zoomToCursor = false;
    c.addEventListener('change', () => this.onChange());
    c.addEventListener('start', () => {
      this.flight = null;
      // a flyby goes on, but the view is the user's once they turn it (zooming and panning keep the steering)
      if (this.tourState && ROTATE_STATES.has((c as unknown as { state: number }).state)) this.tourState.steer = false;
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
      if (this.tourState && action.startsWith('rot')) this.tourState.steer = false;
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
    // somewhere else: a flyby stops
    this.stopTour();
    this.startFlight(point, distance, duration, direction);
  }

  private startFlight(point: Vector3, distance?: number, duration = 1.2, direction?: Vector3): void {
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

  /**
   * Moves the destination of the running flight (or of a short new one) to `point`, if the flight
   * goes to `from` or, without one, the view centre is within `tolerance` of it: a target that
   * turned out a little off (a rounded position) is corrected without a second flight.
   */
  retarget(from: Vector3, point: Vector3, tolerance: number): boolean {
    const f = this.flight;
    if (f && f.toTarget.distanceTo(from) <= tolerance) {
      f.toTarget.copy(point);
      return true;
    }
    if (!f && this.controls.target.distanceTo(from) <= tolerance) {
      this.flyTo(point);
      return true;
    }
    return false;
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

  /**
   * Flies along a route: first to the waypoint `from` (camera distance `distance`, looking along
   * the route), then through the waypoints, `step` seconds each (see Tour).
   */
  startTour(points: Vector3[], step: number, distance: number, from = 0): void {
    this.stopTour();
    const tour = new Tour(points, step, from);
    if (tour.done) return;
    const start = tour.position(tour.s);
    const approach = Math.min(2.2, 0.9 + Math.log10(1 + this.controls.target.distanceTo(start) / Math.max(distance, 1e-6)));
    this.startFlight(start, distance, approach, tour.viewDirection(tour.s));
    this.tourState = { tour, phase: 'approach', steer: true, lag: new Vector3(), index: tour.index };
    this.onTourStep(tour.index);
  }

  /** Stops a flyby (the view stays where it is). */
  stopTour(): void {
    if (!this.tourState) return;
    this.tourState = null;
    this.onTourEnd(false);
  }

  /** Changes the seconds per waypoint of the running flyby. */
  setTourStep(step: number): void {
    if (this.tourState) this.tourState.tour.step = step;
  }

  get touring(): boolean {
    return this.tourState !== null;
  }

  /** The waypoint the flyby is nearest to (-1 without one). */
  get tourIndex(): number {
    return this.tourState?.index ?? -1;
  }

  /** One frame of a flyby: moves view centre and camera along the route (the user's panning stays as an offset). */
  private updateTour(dt: number): boolean {
    const st = this.tourState!;
    const { tour } = st;
    const c = this.controls;
    if (st.phase === 'approach') {
      if (this.flight) return false;
      // arrived (or the user took the approach over): the route from here, any distance left fades out
      st.phase = 'run';
      st.lag.subVectors(c.target, tour.position(tour.s));
    }
    const before = tour.position(tour.s);
    const lagBefore = st.lag.clone();
    tour.advance(dt);
    st.lag.multiplyScalar(Math.exp(-3 * dt));
    const move = tour.position(tour.s).sub(before).add(st.lag).sub(lagBefore);
    c.target.add(move);
    this.camera.position.add(move);
    if (st.steer) {
      const offset = this.tmp.copy(this.camera.position).sub(c.target);
      const dist = offset.length() || 1;
      offset.divideScalar(dist).lerp(tour.viewDirection(tour.s), 1 - Math.exp(-0.9 * dt)).normalize();
      this.camera.position.copy(c.target).addScaledVector(offset, dist);
    }
    if (tour.index !== st.index) {
      st.index = tour.index;
      this.onTourStep(st.index);
    }
    if (tour.done) {
      this.tourState = null;
      this.onTourEnd(true);
    }
    return true;
  }

  /** Jump without animation. */
  setView(target: Vector3, offset: Vector3): void {
    this.stopTour();
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
    if (this.tourState) changed = this.updateTour(dt) || changed;
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
