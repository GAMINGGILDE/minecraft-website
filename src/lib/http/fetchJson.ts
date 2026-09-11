import { parseRetryAfterMs } from './retryAfter';

export type FetchJsonOptions = {
  signal?: AbortSignal;
  cache?: RequestCache;
  headers?: HeadersInit;
  timeoutMs?: number;
};

export class FetchJsonHttpError extends Error {
  status: number;
  retryAfterMs?: number;

  constructor(status: number, retryAfterMs?: number) {
    super(`HTTP ${status}`);
    this.name = 'FetchJsonHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Gemeinsamer JSON-Fetch-Helper fuer Browser-Aufrufe.
 * Wirft bei non-2xx, damit Aufrufer Fehlerbehandlung explizit machen.
 */
export async function fetchJsonOrThrow<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { signal, cache, headers, timeoutMs = 15_000 } = options;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Zeitlimit überschritten.', 'TimeoutError')),
    timeoutMs,
  );
  try {
    const requestHeaders = new Headers(headers);
    if (!requestHeaders.has('Accept')) requestHeaders.set('Accept', 'application/json');
    const res = await fetch(url, { signal: controller.signal, cache, headers: requestHeaders });

    if (!res.ok) {
      const retryAfterMs =
        res.status === 429 ? parseRetryAfterMs(res.headers.get('retry-after')) : undefined;
      throw new FetchJsonHttpError(res.status, retryAfterMs);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
