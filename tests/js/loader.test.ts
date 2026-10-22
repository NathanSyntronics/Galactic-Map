import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HttpError,
  LruCache,
  GIVE_UP_RETRY_MS,
  MAX_ATTEMPTS,
  NodeLoader,
  Octree,
  PackFetcher,
  isPermanentError,
  retryDelay,
  type Manifest,
} from '../../src/data/octree';
import { FormatError } from '../../src/data/format';

type Mode = 'range' | 'whole';

/** In-memory static file server; `mode(n)` decides for the n-th request whether it honours Range. */
function server(files: Record<string, Uint8Array>, mode: (n: number) => Mode = () => 'range') {
  const calls: { url: string; range: string | null; status: number }[] = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    await Promise.resolve();
    const body = files[url];
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? null;
    const n = calls.length;
    if (!body) {
      calls.push({ url, range, status: 404 });
      return new Response('not found', { status: 404 });
    }
    const m = range && /^bytes=(\d+)-(\d+)$/.exec(range);
    if (m && mode(n) === 'range') {
      calls.push({ url, range, status: 206 });
      return new Response(body.slice(Number(m[1]), Number(m[2]) + 1), { status: 206 });
    }
    calls.push({ url, range, status: 200 });
    return new Response(body.slice(), { status: 200 });
  };
  return { fetchFn, calls };
}

const pack = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);
const bytesOf = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf));

describe('PackFetcher', () => {
  const files = { 'd/p0': pack(1000, 1), 'd/p1': pack(1000, 2), 'd/p2': pack(1000, 3) };
  const names = ['p0', 'p1', 'p2'];

  it('reads node blobs with Range requests', async () => {
    const { fetchFn, calls } = server(files);
    const f = new PackFetcher('d/', names, fetchFn);
    const parts = await Promise.all([f.fetch(0, 0, 100), f.fetch(0, 100, 50), f.fetch(1, 10, 20)]);
    expect(bytesOf(parts[1])).toEqual(Array.from(files['d/p0'].slice(100, 150)));
    expect(bytesOf(parts[2])).toEqual(Array.from(files['d/p1'].slice(10, 30)));
    expect(calls.every((c) => c.status === 206)).toBe(true);
    expect(f.cachedPacks).toBe(0);
  });

  it('downloads a pack once when the server ignores Range, however many nodes are requested at once', async () => {
    const { fetchFn, calls } = server(files, () => 'whole');
    const f = new PackFetcher('d/', names, fetchFn);
    const offsets = [0, 100, 200, 300, 400, 500];
    const parts = await Promise.all(offsets.map((o) => f.fetch(0, o, 100)));
    parts.forEach((p, k) => expect(bytesOf(p)).toEqual(Array.from(files['d/p0'].slice(offsets[k], offsets[k] + 100))));
    expect(calls.length).toBe(1);
    expect(f.fullDownloads).toBe(1);
    // later requests are served from the cached pack
    await f.fetch(0, 900, 100);
    expect(calls.length).toBe(1);
  });

  it('decides per response whether the range was honoured', async () => {
    // the second response (e.g. a CDN cache miss) ignores the range
    const { fetchFn, calls } = server(files, (n) => (n === 1 ? 'whole' : 'range'));
    const f = new PackFetcher('d/', names, fetchFn);
    const a = await f.fetch(0, 0, 10);
    const b = await f.fetch(1, 20, 10);
    const c = await f.fetch(2, 30, 10);
    const d = await f.fetch(1, 40, 10);
    expect(bytesOf(a)).toEqual(Array.from(files['d/p0'].slice(0, 10)));
    expect(bytesOf(b)).toEqual(Array.from(files['d/p1'].slice(20, 30)));
    expect(bytesOf(c)).toEqual(Array.from(files['d/p2'].slice(30, 40)));
    expect(bytesOf(d)).toEqual(Array.from(files['d/p1'].slice(40, 50)));
    // pack 2 is still read with ranges; pack 1 came whole once and is reused
    expect(calls.map((x) => x.status)).toEqual([206, 200, 206]);
  });

  it('keeps at most maxPacks whole packs in memory', async () => {
    const { fetchFn, calls } = server(files, () => 'whole');
    const f = new PackFetcher('d/', names, fetchFn, 2);
    await f.fetch(0, 0, 10);
    await f.fetch(1, 0, 10);
    await f.fetch(2, 0, 10);
    expect(f.cachedPacks).toBe(2);
    await f.fetch(0, 0, 10); // evicted, fetched again
    expect(calls.length).toBe(4);
    await f.fetch(0, 10, 10); // now cached
    expect(calls.length).toBe(4);
  });

  it('rejects a truncated pack and fetches it again next time', async () => {
    const short = { 'd/p0': pack(50, 1) };
    let n = 0;
    const fetchFn = async () => {
      n++;
      return new Response(n === 1 ? short['d/p0'] : files['d/p0'], { status: 200 });
    };
    const f = new PackFetcher('d/', names, fetchFn);
    await expect(f.fetch(0, 100, 10)).rejects.toThrow(/truncated/);
    expect(bytesOf(await f.fetch(0, 100, 10))).toEqual(Array.from(files['d/p0'].slice(100, 110)));
  });

  it('asks once more past the browser cache when a range comes back short', async () => {
    const { fetchFn: ok } = server(files);
    const inits: (RequestInit | undefined)[] = [];
    // the cache answers with an empty body; the server itself (no-store) with the right bytes
    const fetchFn = async (url: string, init?: RequestInit) => {
      inits.push(init);
      return init?.cache === 'no-store' ? ok(url, init) : new Response(new Uint8Array(0), { status: 206 });
    };
    const f = new PackFetcher('d/', names, fetchFn);
    expect(bytesOf(await f.fetch(0, 100, 50))).toEqual(Array.from(files['d/p0'].slice(100, 150)));
    expect(inits.map((i) => i?.cache)).toEqual([undefined, 'no-store']);
    // a server that ignores the range on the second try still serves the blob
    const whole = async (_url: string, init?: RequestInit) =>
      init?.cache === 'no-store' ? new Response(files['d/p1'].slice(), { status: 200 }) : new Response(new Uint8Array(3), { status: 206 });
    const g = new PackFetcher('d/', names, whole);
    expect(bytesOf(await g.fetch(1, 10, 20))).toEqual(Array.from(files['d/p1'].slice(10, 30)));
  });

  it('reports a range that stays short as a transient error', async () => {
    let n = 0;
    const fetchFn = async () => {
      n++;
      return new Response(new Uint8Array(5), { status: 206 });
    };
    const f = new PackFetcher('d/', names, fetchFn);
    const err = await f.fetch(0, 0, 10).catch((e) => e);
    expect(String(err)).toMatch(/short range read 5\/10/);
    expect(isPermanentError(err)).toBe(false);
    expect(n).toBe(2);
  });

  it('reports HTTP errors', async () => {
    const { fetchFn } = server({});
    const f = new PackFetcher('d/', names, fetchFn);
    const err = await f.fetch(0, 0, 10).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(isPermanentError(err)).toBe(true);
  });
});

describe('error classification and backoff', () => {
  it('treats missing files and bad data as permanent, network and server errors as transient', () => {
    expect(isPermanentError(new HttpError(404, 'x'))).toBe(true);
    expect(isPermanentError(new HttpError(416, 'x'))).toBe(true);
    expect(isPermanentError(new FormatError('bad magic'))).toBe(true);
    expect(isPermanentError(new HttpError(503, 'x'))).toBe(false);
    expect(isPermanentError(new HttpError(429, 'x'))).toBe(false);
    expect(isPermanentError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isPermanentError(new Error('short range read'))).toBe(false);
  });

  it('backs off exponentially, capped', () => {
    expect([1, 2, 3, 4].map(retryDelay)).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelay(20)).toBe(30_000);
  });

  it('evicts the least recently used entry', () => {
    const c = new LruCache<number, string>(2);
    c.set(1, 'a');
    c.set(2, 'b');
    c.get(1);
    c.set(3, 'c');
    expect(c.get(2)).toBeUndefined();
    expect(c.get(1)).toBe('a');
    expect(c.size).toBe(2);
  });
});

describe('NodeLoader', () => {
  // Fixture written by pipeline/tests/make_js_fixture.py: one root node in n/p000.bin
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'data');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const packBytes = new Uint8Array(readFileSync(join(dir, manifest.packs[0])));
  const octree = new Octree(manifest);
  const url = `base/${manifest.packs[0]}`;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** fetch that fails the first `failures` requests with `error`, then serves the fixture. */
  function flaky(failures: number, error: () => unknown) {
    let calls = 0;
    const fetchFn = async (u: string, init?: RequestInit) => {
      calls++;
      if (calls <= failures) {
        const e = error();
        if (typeof e === 'number') return new Response('', { status: e });
        throw e;
      }
      const { fetchFn: ok } = server({ [url]: packBytes });
      return ok(u, init);
    };
    return { fetchFn, count: () => calls };
  }

  function makeLoader(fetchFn: (u: string, init?: RequestInit) => Promise<Response>) {
    const loader = new NodeLoader('base/', manifest.packs, { fetch: fetchFn, now: () => Date.now() });
    const loaded: string[] = [];
    const failed: string[] = [];
    loader.onLoaded = (n) => loaded.push(n.path);
    loader.onFailed = (n) => failed.push(n.path);
    return { loader, loaded, failed };
  }

  it('retries a transient failure of the root node by itself, without a view change', async () => {
    const net = flaky(1, () => new TypeError('Failed to fetch'));
    const { loader, loaded, failed } = makeLoader(net.fetchFn);
    loader.request([octree.root], 1e6);
    await vi.advanceTimersByTimeAsync(10);
    expect(loaded).toEqual([]);
    expect(loader.pendingCount).toBe(1); // waiting for the retry
    await vi.advanceTimersByTimeAsync(1000);
    expect(loaded).toEqual(['r']);
    expect(failed).toEqual([]);
    expect(loader.get('r')?.count).toBe(4);
    expect(loader.pendingCount).toBe(0);
  });

  it('gives up after MAX_ATTEMPTS transient failures and reports it once', async () => {
    const net = flaky(100, () => 503);
    const { loader, loaded, failed } = makeLoader(net.fetchFn);
    loader.request([octree.root], 1e6);
    await vi.advanceTimersByTimeAsync(45_000); // 1 + 2 + 4 + 8 + 16 s of backoff
    expect(net.count()).toBe(MAX_ATTEMPTS);
    expect(loaded).toEqual([]);
    expect(failed).toEqual(['r']);
    expect(loader.hasFailed('r')).toBe(true);
    // a later view change does not hammer the server again
    loader.request([octree.root], 1e6);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(net.count()).toBe(MAX_ATTEMPTS);
    expect(loader.pendingCount).toBe(0);
    // only one more attempt per GIVE_UP_RETRY_MS while the node is wanted, reported only once
    await vi.advanceTimersByTimeAsync(3 * GIVE_UP_RETRY_MS);
    expect(net.count()).toBeLessThanOrEqual(MAX_ATTEMPTS + 3);
    expect(failed).toEqual(['r']);
  });

  it('tries a given-up node again much later, if it is still wanted, and then loads it', async () => {
    const net = flaky(MAX_ATTEMPTS, () => new TypeError('offline'));
    const { loader, loaded, failed } = makeLoader(net.fetchFn);
    loader.request([octree.root], 1e6);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failed).toEqual(['r']);
    expect(net.count()).toBe(MAX_ATTEMPTS);
    await vi.advanceTimersByTimeAsync(GIVE_UP_RETRY_MS);
    expect(net.count()).toBe(MAX_ATTEMPTS + 1);
    expect(loaded).toEqual(['r']);
    expect(loader.hasFailed('r')).toBe(false);
    expect(failed).toEqual(['r']); // reported once
  });

  it('fetches a given-up node again at once when asked to retry', async () => {
    const net = flaky(MAX_ATTEMPTS, () => 503);
    const { loader, loaded, failed } = makeLoader(net.fetchFn);
    loader.request([octree.root], 1e6);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failed).toEqual(['r']);
    loader.retry('r');
    expect(loader.hasFailed('r')).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(net.count()).toBe(MAX_ATTEMPTS + 1);
    expect(loaded).toEqual(['r']);
  });

  it('does not retry permanent errors, even when asked to', async () => {
    const net = flaky(100, () => 404);
    const { loader, failed } = makeLoader(net.fetchFn);
    loader.request([octree.root], 1e6);
    await vi.advanceTimersByTimeAsync(60_000);
    loader.retry('r');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(net.count()).toBe(1);
    expect(failed).toEqual(['r']);
    expect(loader.hasFailed('r')).toBe(true);
  });

  it('does not retry permanent errors', async () => {
    const net = flaky(100, () => 404);
    const { loader, failed } = makeLoader(net.fetchFn);
    loader.request([octree.root], 1e6);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(net.count()).toBe(1);
    expect(failed).toEqual(['r']);
  });

  it('does not retry nodes that are no longer wanted until they are requested again', async () => {
    const net = flaky(1, () => new TypeError('reset'));
    const { loader, loaded } = makeLoader(net.fetchFn);
    loader.request([octree.root], 1e6);
    await vi.advanceTimersByTimeAsync(10);
    loader.request([], 1e6); // view moved away
    await vi.advanceTimersByTimeAsync(5000);
    expect(net.count()).toBe(1);
    loader.request([octree.root], 1e6);
    await vi.advanceTimersByTimeAsync(10);
    expect(loaded).toEqual(['r']);
  });
});
