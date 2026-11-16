// computeJumpLinks in a worker, so that the map goes on while a large network is computed; on the
// main thread where workers are unavailable (or the worker failed). The result is the same.
import { computeJumpLinks, type JumpLinks, type JumpParams, type JumpPlaces } from './jumps';

let worker: Worker | null | undefined;
let nextId = 0;
const pending = new Map<number, (links: JumpLinks | null) => void>();

function linksWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./links-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; links: JumpLinks }>) => {
      const done = pending.get(e.data.id);
      pending.delete(e.data.id);
      done?.(e.data.links);
    };
    worker.onerror = (e) => {
      // (the pending jobs are computed here instead)
      console.warn('jump links worker failed', e.message);
      worker?.terminate();
      worker = null;
      for (const done of pending.values()) done(null);
      pending.clear();
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** The links of `places` (see computeJumpLinks), computed in a worker when possible. */
export async function computeJumpLinksAsync(places: JumpPlaces, params: JumpParams): Promise<JumpLinks> {
  const w = typeof Worker === 'undefined' ? null : linksWorker();
  if (w) {
    const id = nextId++;
    // (the arrays are copied: the caller keeps its own)
    const job = { id, places: { count: places.count, positions: places.positions, capacities: places.capacities, keys: places.keys }, params };
    const links = await new Promise<JumpLinks | null>((resolve) => {
      pending.set(id, resolve);
      try {
        w.postMessage(job);
      } catch {
        pending.delete(id);
        resolve(null);
      }
    });
    if (links) return links;
  }
  return computeJumpLinks(places, params);
}
