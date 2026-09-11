import { afterEach, describe, expect, it, vi } from 'vitest';

import { getLiveResource, resetLiveResourceCache } from './cache';
import type { LiveDataState } from './types';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

class VisibilityTestDocument {
  visibilityState: DocumentVisibilityState;
  private listeners = new Set<() => void>();

  constructor(initialState: DocumentVisibilityState) {
    this.visibilityState = initialState;
  }

  addEventListener(event: string, listener: EventListenerOrEventListenerObject): void {
    if (event !== 'visibilitychange') return;
    if (typeof listener !== 'function') return;
    this.listeners.add(listener as () => void);
  }

  removeEventListener(event: string, listener: EventListenerOrEventListenerObject): void {
    if (event !== 'visibilitychange') return;
    if (typeof listener !== 'function') return;
    this.listeners.delete(listener as () => void);
  }

  setVisibilityState(nextState: DocumentVisibilityState): void {
    this.visibilityState = nextState;
    [...this.listeners].forEach((listener) => listener());
  }
}

const BASE_OPTIONS = {
  staleAfterMs: 1_000,
  maxCacheAgeMs: 10_000,
  cachePrefix: 'test-live:',
} as const;

describe('live/cache', () => {
  afterEach(() => {
    resetLiveResourceCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns cached data immediately and revalidates in background', async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'test-live:counter',
      JSON.stringify({
        status: 'ok',
        data: '12',
        updatedAt: 4_000,
        fetchedAt: 4_000,
      }),
    );

    const fetcher = vi.fn(async (): Promise<LiveDataState<string>> => ({
      status: 'ok',
      data: '13',
      updatedAt: 5_000,
      fetchedAt: 5_000,
    }));

    const resource = getLiveResource('counter', fetcher, {
      ...BASE_OPTIONS,
      storage,
      now: () => 4_500,
    });

    expect(resource.state).toEqual({
      status: 'ok',
      data: '12',
      updatedAt: 4_000,
      fetchedAt: 4_000,
      error: undefined,
    });

    const latest = await resource.revalidate;

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(latest).toEqual({
      status: 'ok',
      data: '13',
      updatedAt: 5_000,
      fetchedAt: 5_000,
      error: undefined,
    });
  });

  it('returns stale cached data when refresh fails but cache is still valid', async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'test-live:counter',
      JSON.stringify({
        status: 'ok',
        data: '12',
        updatedAt: 4_000,
        fetchedAt: 4_000,
      }),
    );

    const resource = getLiveResource(
      'counter',
      async (): Promise<LiveDataState<string>> => ({
        status: 'error',
        fetchedAt: 5_000,
        error: {
          kind: 'network',
          message: 'offline',
        },
      }),
      {
        ...BASE_OPTIONS,
        storage,
        now: () => 6_500,
      },
    );

    expect(resource.state.status).toBe('stale');

    const latest = await resource.revalidate;

    expect(latest).toEqual({
      status: 'stale',
      data: '12',
      updatedAt: 4_000,
      fetchedAt: 5_000,
      error: {
        kind: 'network',
        message: 'offline',
      },
    });
  });

  it('returns stale cached data when refresh has invalid response but cache is still valid', async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'test-live:counter',
      JSON.stringify({
        status: 'ok',
        data: '12',
        updatedAt: 4_000,
        fetchedAt: 4_000,
      }),
    );

    const resource = getLiveResource(
      'counter',
      async (): Promise<LiveDataState<string>> => ({
        status: 'error',
        fetchedAt: 5_000,
        error: {
          kind: 'invalid',
          message: 'schema mismatch',
        },
      }),
      {
        ...BASE_OPTIONS,
        storage,
        now: () => 6_500,
      },
    );

    expect(resource.state.status).toBe('stale');

    const latest = await resource.revalidate;

    expect(latest).toEqual({
      status: 'stale',
      data: '12',
      updatedAt: 4_000,
      fetchedAt: 5_000,
      error: {
        kind: 'invalid',
        message: 'schema mismatch',
      },
    });
  });

  it('returns error when cache is too old and refresh fails', async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'test-live:counter',
      JSON.stringify({
        status: 'ok',
        data: '12',
        updatedAt: 1_000,
        fetchedAt: 1_000,
      }),
    );

    const resource = getLiveResource(
      'counter',
      async (): Promise<LiveDataState<string>> => ({
        status: 'error',
        fetchedAt: 20_000,
        error: {
          kind: 'network',
          message: 'offline',
        },
      }),
      {
        ...BASE_OPTIONS,
        storage,
        now: () => 20_000,
      },
    );

    expect(resource.state).toEqual({
      status: 'error',
      fetchedAt: 20_000,
      error: {
        kind: 'invalid',
        message: 'Zwischengespeicherte Daten sind zu alt.',
      },
    });
    expect(storage.getItem('test-live:counter')).toBeNull();

    const latest = await resource.revalidate;

    expect(latest).toEqual({
      status: 'error',
      fetchedAt: 20_000,
      error: {
        kind: 'network',
        message: 'offline',
      },
    });
  });

  it('dedupes revalidation requests for the same key', async () => {
    const storage = new MemoryStorage();
    const fetcher = vi.fn(async (): Promise<LiveDataState<string>> => ({
      status: 'ok',
      data: '7',
      updatedAt: 8_000,
      fetchedAt: 8_000,
    }));

    const first = getLiveResource('shared', fetcher, {
      ...BASE_OPTIONS,
      storage,
      now: () => 7_000,
    });
    const second = getLiveResource('shared', fetcher, {
      ...BASE_OPTIONS,
      storage,
      now: () => 7_000,
    });

    expect(first.revalidate).toBe(second.revalidate);

    const [one, two] = await Promise.all([first.revalidate, second.revalidate]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(one).toEqual(two);
  });

  it('blocks revalidation while tab is hidden', async () => {
    const storage = new MemoryStorage();
    const visibilityDocument = new VisibilityTestDocument('hidden');
    vi.stubGlobal('document', visibilityDocument as unknown as Document);

    let now = 2_000;
    const fetcher = vi.fn(async (): Promise<LiveDataState<string>> => ({
      status: 'ok',
      data: '13',
      updatedAt: now,
      fetchedAt: now,
    }));

    const resource = getLiveResource('counter', fetcher, {
      ...BASE_OPTIONS,
      storage,
      now: () => now,
    });

    expect(resource.state).toEqual({
      status: 'loading',
      fetchedAt: 2_000,
    });
    expect(fetcher).toHaveBeenCalledTimes(0);

    now = 2_300;
    visibilityDocument.setVisibilityState('visible');

    const latest = await resource.revalidate;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(latest).toEqual({
      status: 'ok',
      data: '13',
      updatedAt: 2_300,
      fetchedAt: 2_300,
      error: undefined,
    });
  });

  it('waits for visible tab before revalidating stale data', async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'test-live:counter',
      JSON.stringify({
        status: 'ok',
        data: '12',
        updatedAt: 1_000,
        fetchedAt: 1_000,
      }),
    );

    const visibilityDocument = new VisibilityTestDocument('hidden');
    vi.stubGlobal('document', visibilityDocument as unknown as Document);

    let now = 2_500;
    const fetcher = vi.fn(async (): Promise<LiveDataState<string>> => ({
      status: 'ok',
      data: '13',
      updatedAt: now,
      fetchedAt: now,
    }));

    const first = getLiveResource('counter', fetcher, {
      ...BASE_OPTIONS,
      storage,
      now: () => now,
    });
    const second = getLiveResource('counter', fetcher, {
      ...BASE_OPTIONS,
      storage,
      now: () => now,
    });

    expect(first.revalidate).toBe(second.revalidate);
    expect(fetcher).toHaveBeenCalledTimes(0);

    now = 2_700;
    visibilityDocument.setVisibilityState('visible');

    const [one, two] = await Promise.all([first.revalidate, second.revalidate]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(one).toEqual(two);
    expect(one).toEqual({
      status: 'ok',
      data: '13',
      updatedAt: 2_700,
      fetchedAt: 2_700,
      error: undefined,
    });
  });

  it('throttles revalidation by minRevalidateIntervalMs per key', async () => {
    const storage = new MemoryStorage();
    let now = 7_000;
    const fetcher = vi.fn(async (): Promise<LiveDataState<string>> => ({
      status: 'ok',
      data: '7',
      updatedAt: now,
      fetchedAt: now,
    }));

    const first = getLiveResource('shared', fetcher, {
      ...BASE_OPTIONS,
      storage,
      now: () => now,
      minRevalidateIntervalMs: 10_000,
    });
    await first.revalidate;
    expect(fetcher).toHaveBeenCalledTimes(1);

    now = 8_000;
    const second = getLiveResource('shared', fetcher, {
      ...BASE_OPTIONS,
      storage,
      now: () => now,
      minRevalidateIntervalMs: 10_000,
    });
    const latest = await second.revalidate;

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(latest).toEqual({
      status: 'ok',
      data: '7',
      updatedAt: 7_000,
      fetchedAt: 7_000,
      error: undefined,
    });
  });

  it.each(['network', 'timeout'] as const)(
    'retries after a %s failure without leaving a loading state with no request',
    async (kind) => {
      const fetcher = vi
        .fn<() => Promise<LiveDataState<string>>>()
        .mockResolvedValueOnce({ status: 'error', error: { kind } })
        .mockResolvedValueOnce({ status: 'ok', data: 'recovered' });
      const options = {
        ...BASE_OPTIONS,
        storage: null,
        now: () => 7_000,
        minRevalidateIntervalMs: 15_000,
      };

      expect((await getLiveResource('retry', fetcher, options).revalidate)?.status).toBe('error');
      const retry = getLiveResource('retry', fetcher, options);
      const duplicate = getLiveResource('retry', fetcher, options);
      expect(retry.revalidate).toBe(duplicate.revalidate);
      expect((await retry.revalidate)?.data).toBe('recovered');
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it('refreshes an expired snapshot even within the revalidation interval', async () => {
    let now = 1_000;
    const fetcher = vi.fn(async (): Promise<LiveDataState<number>> => ({
      status: 'ok',
      data: now,
      updatedAt: now,
    }));
    const options = {
      ...BASE_OPTIONS,
      storage: null,
      now: () => now,
      minRevalidateIntervalMs: 15_000,
    };
    await getLiveResource('expired', fetcher, options).revalidate;
    now = 12_000;
    expect((await getLiveResource('expired', fetcher, options).revalidate)?.data).toBe(12_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reads legacy cache payload format', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'test-live:legacy',
      JSON.stringify({
        kind: 'empty',
        value: '0',
        timestamp: 5_000,
      }),
    );

    const resource = getLiveResource('legacy', async () => ({ status: 'loading' }), {
      ...BASE_OPTIONS,
      storage,
      now: () => 5_500,
      revalidate: false,
    });

    expect(resource.state).toEqual({
      status: 'empty',
      data: '0',
      updatedAt: 5_000,
      fetchedAt: 5_000,
      error: undefined,
    });
    expect(resource.revalidate).toBeNull();
  });
});
