import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJsonOrThrow } from './fetchJson';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchJsonOrThrow', () => {
  it('begrenzt auch das Lesen eines haengenden Antwort-Bodys', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, { signal }: RequestInit) => ({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
          }),
      })),
    );
    const result = fetchJsonOrThrow('/api/test', { timeoutMs: 100 });
    const assertion = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reicht explizite Abbrueche weiter und entfernt den Timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, { signal }: RequestInit) =>
          new Promise((_resolve, reject) => {
            signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
          }),
      ),
    );
    const controller = new AbortController();
    const result = fetchJsonOrThrow('/api/test', { signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('erhaelt Headers-Instanzen und raeumt nach Erfolg auf', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => Response.json({ value: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await fetchJsonOrThrow('/api/test', { headers: new Headers({ 'X-Test': 'yes' }) }),
    ).toEqual({ value: 1 });
    const options = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(options.headers).get('X-Test')).toBe('yes');
    expect(new Headers(options.headers).get('Accept')).toBe('application/json');
    expect(vi.getTimerCount()).toBe(0);
  });
});
