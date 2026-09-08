import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchLiveJson } from './fetchJson';

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
    ...init,
  });

describe('live/fetchJson', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns ok for valid JSON payload', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ presence_count: 7 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchLiveJson<{ presence_count: number }>('https://example.test/widget', {
      requiredKeys: ['presence_count'],
      validate: (value): value is { presence_count: number } =>
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { presence_count?: unknown }).presence_count === 'number',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.presence_count).toBe(7);
      expect(result.status).toBe(200);
    }
  });

  it('classifies HTTP 429 as rate_limit and parses retry-after', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({}, { status: 429, headers: { 'retry-after': '3' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchLiveJson('https://example.test/rate-limited');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('rate_limit');
      expect(result.error.retryAfterMs).toBe(3_000);
    }
  });

  it('classifies missing expected keys as invalid', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ something_else: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchLiveJson<{ presence_count: number }>('https://example.test/widget', {
      requiredKeys: ['presence_count'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid');
    }
  });

  it.each([502, 503, 504])(
    'uebernimmt Retry-After bei HTTP %s als Netzwerkfehler',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status, headers: { 'Retry-After': '600' } })),
      );

      const result = await fetchLiveJson('https://example.test/unavailable');

      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'network', status, retryAfterMs: 600_000 },
      });
    },
  );

  it('classifies timeout errors', async () => {
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchLiveJson('https://example.test/slow', { timeoutMs: 5 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('timeout');
    }
  });

  it('classifies fetch rejections as network', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchLiveJson('https://example.test/offline');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('network');
    }
  });
});
