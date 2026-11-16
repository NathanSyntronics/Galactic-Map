// A jump network's links computed off the main thread (see links-async.ts): a large network (a
// faction's region of 500 ly: 900,000 places) takes a second or more, which would stop the map.
import { computeJumpLinks, type JumpParams, type JumpPlaces } from './jumps';

interface Job {
  id: number;
  places: JumpPlaces;
  params: JumpParams;
}

const scope = self as unknown as { onmessage: ((e: MessageEvent<Job>) => void) | null; postMessage: (msg: unknown, transfer: Transferable[]) => void };

scope.onmessage = (e) => {
  const { id, places, params } = e.data;
  const links = computeJumpLinks(places, params);
  scope.postMessage({ id, links }, [links.a.buffer, links.b.buffer, links.length.buffer, links.kind.buffer]);
};
