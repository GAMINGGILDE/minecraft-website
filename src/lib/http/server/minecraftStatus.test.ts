import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMinecraftStatus } from './minecraftStatus';

const now = new Date('2026-09-08T12:00:00Z').getTime();
const request = () => new Request('https://minecraft-gilde.de/api/minecraft-status/');
const payload = (extra = {}) => ({
  online: true,
  players: { online: 3, list: [{ name: 'Steve' }] },
  debug: { cachetime: now / 1_000 - 120, cacheexpire: now / 1_000 + 180 },
  ...extra,
});

function memoryCache() {
  const entries = new Map<string, Response>();
  return {
    match: vi.fn(async (key: RequestInfo | URL) => entries.get(new Request(key).url)?.clone()),
    put: vi.fn(async (key: RequestInfo | URL, response: Response) => {
      entries.set(new Request(key).url, response.clone());
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Minecraft-Status im Worker', () => {
  it('teilt eine normalisierte Antwort zwischen Besuchern bis zur Ablaufzeit der Quelle', async () => {
    const cache = memoryCache();
    const fetcher = vi.fn(async () => Response.json(payload()));
    vi.stubGlobal('fetch', fetcher);
    const first = await handleMinecraftStatus(request(), cache);
    expect(await first.json()).toMatchObject({
      stale: false,
      data: {
        players: { online: 3, list: [{ name: 'Steve' }] },
        updatedAt: now - 120_000,
        expiresAt: now + 180_000,
      },
    });
    vi.setSystemTime(now + 179_000);
    const second = await handleMinecraftStatus(
      new Request(`${request().url}?server=evil.example`),
      cache,
    );
    expect(second.headers.get('X-Minecraft-Cache')).toBe('HIT');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.mcsrvstat.us/3/minecraft-gilde.de',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': expect.any(String) }),
      }),
    );
    vi.setSystemTime(now + 180_000);
    await handleMinecraftStatus(request(), cache);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('erhaelt bei einem Ausfall den letzten Stand und teilt auch die Retry-Pause', async () => {
    const cache = memoryCache();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(payload()))
      .mockImplementation(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    await handleMinecraftStatus(request(), cache);
    vi.setSystemTime(now + 181_000);
    const failed = await handleMinecraftStatus(request(), cache);
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({
      stale: true,
      retryAfterMs: 30_000,
      data: { updatedAt: now - 120_000, players: { online: 3 } },
    });
    await handleMinecraftStatus(request(), cache);
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.setSystemTime(now + 30 * 60_000);
    const expired = await handleMinecraftStatus(request(), cache);
    expect(expired.status).toBe(502);
    expect(await expired.json()).not.toHaveProperty('data');
  });

  it('uebernimmt einen bestaetigten Offline-Status statt alte Online-Daten zu behalten', async () => {
    const cache = memoryCache();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(payload()))
      .mockResolvedValueOnce(Response.json({ online: false }));
    vi.stubGlobal('fetch', fetcher);
    await handleMinecraftStatus(request(), cache);
    vi.setSystemTime(now + 181_000);
    const response = await handleMinecraftStatus(request(), cache);
    expect(await response.json()).toMatchObject({
      stale: false,
      data: { online: false, players: { online: 0, list: [] } },
    });
  });

  it('respektiert Retry-After auch ohne vorherigen Erfolg', async () => {
    const cache = memoryCache();
    const fetcher = vi.fn(
      async () => new Response(null, { status: 429, headers: { 'Retry-After': '120' } }),
    );
    vi.stubGlobal('fetch', fetcher);
    expect((await handleMinecraftStatus(request(), cache)).status).toBe(429);
    vi.setSystemTime(now + 60_000);
    const response = await handleMinecraftStatus(request(), cache);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(now + 120_000);
    await handleMinecraftStatus(request(), cache);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { online: true }, { online: true, players: { online: null } }])(
    'behandelt ungueltige Daten als Fehler: %j',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(body)),
      );
      expect((await handleMinecraftStatus(request(), memoryCache())).status).toBe(502);
    },
  );

  it('begrenzt die Wartezeit auch beim Lesen des Antwortkoerpers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url, { signal }) =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{'));
                signal.addEventListener('abort', () => controller.error(signal.reason));
              },
            }),
          ),
      ),
    );
    const response = handleMinecraftStatus(request(), memoryCache());
    await vi.advanceTimersByTimeAsync(6_500);
    expect((await response).status).toBe(504);
  });

  it('verwirft uebergrosse Antworten und liefert bei HEAD keinen Body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(' '.repeat(256 * 1_024 + 1))),
    );
    const response = await handleMinecraftStatus(
      new Request(request(), { method: 'HEAD' }),
      memoryCache(),
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('');
  });

  it('liefert bei Cache-Ausfall weiterhin Daten aus der Quelle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(payload())),
    );
    const cache = {
      match: vi.fn().mockRejectedValue(new Error('Cache')),
      put: vi.fn().mockRejectedValue(new Error('Cache')),
    };
    expect((await handleMinecraftStatus(request(), cache)).status).toBe(200);
  });
});
