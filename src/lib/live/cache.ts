import type { LiveDataError, LiveDataState, LiveDataStatus } from './types';

const DEFAULT_CACHE_PREFIX = 'mg:live-resource:v1:';

type CacheableStatus = Extract<LiveDataStatus, 'ok' | 'empty'>;

type LiveResourceCacheEntry<T> = {
  data: T;
  updatedAt: number;
  fetchedAt: number;
  status?: CacheableStatus;
};

type LiveResourceCachePayload = {
  data?: unknown;
  value?: unknown;
  updatedAt?: unknown;
  fetchedAt?: unknown;
  timestamp?: unknown;
  status?: unknown;
  kind?: unknown;
};

const memoryCache = new Map<string, LiveResourceCacheEntry<unknown>>();
const inFlightRequests = new Map<string, Promise<LiveDataState<unknown>>>();
const pendingVisibilityRequests = new Map<string, Promise<LiveDataState<unknown>>>();
const lastRevalidateAtByKey = new Map<string, number>();

export type LiveResourceFetcher<T> = () => Promise<LiveDataState<T>>;

export interface GetLiveResourceOptions {
  staleAfterMs: number;
  maxCacheAgeMs: number;
  persist?: boolean;
  cachePrefix?: string;
  storage?: Storage | null;
  now?: () => number;
  revalidate?: boolean;
  minRevalidateIntervalMs?: number;
}

export interface LiveResourceResult<T> {
  state: LiveDataState<T>;
  revalidate: Promise<LiveDataState<T>> | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const resolveNow = (options: GetLiveResourceOptions): number => {
  const value = options.now?.();
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
};

const resolveStorage = (options: GetLiveResourceOptions): Storage | null => {
  if (options.persist === false) return null;
  if ('storage' in options) return options.storage ?? null;

  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const resolveMinRevalidateIntervalMs = (options: GetLiveResourceOptions): number => {
  const value = options.minRevalidateIntervalMs;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
};

const isVisibilityApiAvailable = (): boolean =>
  typeof document !== 'undefined' &&
  typeof document.addEventListener === 'function' &&
  typeof document.removeEventListener === 'function' &&
  typeof document.visibilityState === 'string';

const isDocumentVisible = (): boolean => {
  if (!isVisibilityApiAvailable()) return true;
  return document.visibilityState === 'visible';
};

const toStorageKey = (key: string, options: GetLiveResourceOptions): string => {
  const prefix = options.cachePrefix ?? DEFAULT_CACHE_PREFIX;
  return `${prefix}${key}`;
};

const parseStatus = (payload: LiveResourceCachePayload): CacheableStatus => {
  if (payload.status === 'empty' || payload.kind === 'empty') return 'empty';
  return 'ok';
};

const parseTimestamp = (
  payload: LiveResourceCachePayload,
  preferred: 'updatedAt' | 'fetchedAt',
): number | null => {
  const candidate = payload[preferred];
  if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  if (typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp)) {
    return payload.timestamp;
  }
  return null;
};

const parseCachePayload = <T>(value: unknown): LiveResourceCacheEntry<T> | null => {
  if (!isRecord(value)) return null;

  const payload = value as LiveResourceCachePayload;
  const data = 'data' in payload ? payload.data : payload.value;
  if (typeof data === 'undefined') return null;

  const updatedAt = parseTimestamp(payload, 'updatedAt');
  const fetchedAt = parseTimestamp(payload, 'fetchedAt');
  if (updatedAt == null || fetchedAt == null) return null;

  return {
    status: parseStatus(payload),
    data: data as T,
    updatedAt,
    fetchedAt,
  };
};

const clearCachedEntry = (
  storageKey: string,
  storage: Storage | null,
  clearPersisted: boolean,
): void => {
  memoryCache.delete(storageKey);
  if (!clearPersisted || !storage) return;
  try {
    storage.removeItem(storageKey);
  } catch {
    // Unkritisch: localStorage kann blockiert sein.
  }
};

const readCachedEntry = <T>(
  storageKey: string,
  storage: Storage | null,
): LiveResourceCacheEntry<T> | null => {
  const fromMemory = memoryCache.get(storageKey);
  if (fromMemory) return fromMemory as LiveResourceCacheEntry<T>;
  if (!storage) return null;

  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return null;

    const parsed = parseCachePayload<T>(JSON.parse(raw));
    if (!parsed) {
      clearCachedEntry(storageKey, storage, true);
      return null;
    }

    memoryCache.set(storageKey, parsed as LiveResourceCacheEntry<unknown>);
    return parsed;
  } catch {
    return null;
  }
};

const writeCachedEntry = <T>(
  storageKey: string,
  entry: LiveResourceCacheEntry<T>,
  storage: Storage | null,
): void => {
  memoryCache.set(storageKey, entry as LiveResourceCacheEntry<unknown>);
  if (!storage) return;

  try {
    storage.setItem(storageKey, JSON.stringify(entry));
  } catch {
    // Unkritisch: localStorage kann blockiert sein.
  }
};

const toCacheableState = <T>(
  state: LiveDataState<T>,
  fetchedAt: number,
): LiveResourceCacheEntry<T> | null => {
  if ((state.status !== 'ok' && state.status !== 'empty') || typeof state.data === 'undefined') {
    return null;
  }

  const resolvedFetchedAt = state.fetchedAt ?? fetchedAt;
  const resolvedUpdatedAt = state.updatedAt ?? resolvedFetchedAt;

  return {
    status: state.status,
    data: state.data,
    updatedAt: resolvedUpdatedAt,
    fetchedAt: resolvedFetchedAt,
  };
};

const toLiveError = (error: unknown): LiveDataError => {
  if (error instanceof Error) {
    return {
      kind: 'unknown',
      message: error.message || 'Daten konnten nicht geladen werden.',
    };
  }

  return {
    kind: 'unknown',
    message: 'Daten konnten nicht geladen werden.',
  };
};

const toStateFromCache = <T>(
  entry: LiveResourceCacheEntry<T>,
  status: LiveDataStatus,
  fetchedAt?: number,
  error?: LiveDataError,
): LiveDataState<T> => ({
  status,
  data: entry.data,
  updatedAt: entry.updatedAt,
  fetchedAt: fetchedAt ?? entry.fetchedAt,
  error,
});

const resolveStateTimestamp = <T>(state: LiveDataState<T>): number | null => {
  if (typeof state.updatedAt === 'number' && Number.isFinite(state.updatedAt)) {
    return state.updatedAt;
  }
  if (typeof state.fetchedAt === 'number' && Number.isFinite(state.fetchedAt)) {
    return state.fetchedAt;
  }
  return null;
};

const shouldRevalidate = <T>(state: LiveDataState<T>, options: GetLiveResourceOptions): boolean => {
  if (state.status === 'loading' || state.status === 'error' || state.status === 'stale') {
    return true;
  }

  const timestamp = resolveStateTimestamp(state);
  if (timestamp == null) return true;

  const ageMs = Math.max(0, resolveNow(options) - timestamp);
  return ageMs > options.staleAfterMs;
};

const readInitialState = <T>(
  storageKey: string,
  options: GetLiveResourceOptions,
  storage: Storage | null,
): LiveDataState<T> => {
  const now = resolveNow(options);
  const cached = readCachedEntry<T>(storageKey, storage);
  if (!cached) {
    return {
      status: 'loading',
      fetchedAt: now,
    };
  }

  const ageMs = Math.max(0, now - cached.updatedAt);
  if (ageMs > options.maxCacheAgeMs) {
    clearCachedEntry(storageKey, storage, true);
    return {
      status: 'error',
      fetchedAt: now,
      error: {
        kind: 'invalid',
        message: 'Zwischengespeicherte Daten sind zu alt.',
      },
    };
  }

  if (ageMs > options.staleAfterMs) return toStateFromCache(cached, 'stale');
  return toStateFromCache(cached, cached.status ?? 'ok');
};

const startRevalidation = <T>(
  storageKey: string,
  fetcher: LiveResourceFetcher<T>,
  options: GetLiveResourceOptions,
  storage: Storage | null,
): Promise<LiveDataState<T>> => {
  const existing = inFlightRequests.get(storageKey);
  if (existing) return existing as Promise<LiveDataState<T>>;

  const pendingVisibility = pendingVisibilityRequests.get(storageKey);
  if (pendingVisibility) return pendingVisibility as Promise<LiveDataState<T>>;

  if (!isDocumentVisible()) {
    const visibilityRequest = new Promise<LiveDataState<T>>((resolve) => {
      if (!isVisibilityApiAvailable()) {
        resolve(startRevalidation(storageKey, fetcher, options, storage));
        return;
      }

      const onVisibilityChange = (): void => {
        if (!isDocumentVisible()) return;

        document.removeEventListener('visibilitychange', onVisibilityChange);
        pendingVisibilityRequests.delete(storageKey);

        const currentState = readInitialState<T>(storageKey, options, storage);
        if (!shouldRevalidate(currentState, options)) {
          resolve(currentState);
          return;
        }

        resolve(startRevalidation(storageKey, fetcher, options, storage));
      };

      document.addEventListener('visibilitychange', onVisibilityChange);
    });

    pendingVisibilityRequests.set(storageKey, visibilityRequest as Promise<LiveDataState<unknown>>);
    return visibilityRequest;
  }

  const now = resolveNow(options);
  const minRevalidateIntervalMs = resolveMinRevalidateIntervalMs(options);
  if (minRevalidateIntervalMs > 0) {
    const lastRevalidateAt = lastRevalidateAtByKey.get(storageKey);
    if (typeof lastRevalidateAt === 'number' && now - lastRevalidateAt < minRevalidateIntervalMs) {
      const cachedState = readInitialState<T>(storageKey, options, storage);
      // Ohne nutzbare Daten muss ein Wiederholungsversuch wirklich eine Anfrage starten.
      if (cachedState.data !== undefined) return Promise.resolve(cachedState);
    }
  }

  lastRevalidateAtByKey.set(storageKey, now);

  const request: Promise<LiveDataState<T>> = (async (): Promise<LiveDataState<T>> => {
    let nextState: LiveDataState<T>;
    try {
      nextState = await fetcher();
    } catch (error) {
      nextState = {
        status: 'error',
        fetchedAt: resolveNow(options),
        error: toLiveError(error),
      };
    }

    const fetchFinishedAt = resolveNow(options);
    const cacheable = toCacheableState(nextState, fetchFinishedAt);
    if (cacheable) {
      writeCachedEntry(storageKey, cacheable, storage);
      return toStateFromCache(cacheable, cacheable.status ?? 'ok');
    }

    const fallback = readCachedEntry<T>(storageKey, storage);
    if (fallback) {
      const fallbackAgeMs = Math.max(0, fetchFinishedAt - fallback.updatedAt);
      if (fallbackAgeMs <= options.maxCacheAgeMs) {
        return toStateFromCache(
          fallback,
          'stale',
          nextState.fetchedAt ?? fallback.fetchedAt,
          nextState.error,
        );
      }

      clearCachedEntry(storageKey, storage, true);
    }

    if (nextState.status === 'error') return nextState;

    return {
      status: 'error',
      fetchedAt: nextState.fetchedAt ?? fetchFinishedAt,
      error: nextState.error ?? {
        kind: 'unknown',
        message: 'Daten konnten nicht aktualisiert werden.',
      },
    };
  })().finally(() => {
    inFlightRequests.delete(storageKey);
  });

  inFlightRequests.set(storageKey, request as Promise<LiveDataState<unknown>>);
  return request;
};

export const getLiveResource = <T>(
  key: string,
  fetcher: LiveResourceFetcher<T>,
  options: GetLiveResourceOptions,
): LiveResourceResult<T> => {
  const storage = resolveStorage(options);
  const storageKey = toStorageKey(key, options);
  const state = readInitialState<T>(storageKey, options, storage);

  if (options.revalidate === false) {
    return {
      state,
      revalidate: null,
    };
  }

  return {
    state,
    revalidate: startRevalidation(storageKey, fetcher, options, storage),
  };
};

export const resetLiveResourceCache = (): void => {
  memoryCache.clear();
  inFlightRequests.clear();
  pendingVisibilityRequests.clear();
  lastRevalidateAtByKey.clear();
};
