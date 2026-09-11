import type { APIContext } from 'astro';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleStatsApiProxy } from './statsApiProxy';

const { createConnection } = vi.hoisted(() => ({ createConnection: vi.fn() }));
vi.mock('cloudflare:workers', () => ({
  env: {
    STATS_DB_HOST: 'localhost',
    STATS_DB_USER: 'test',
    STATS_DB_PASS: 'test',
    STATS_DB_NAME: 'test',
  },
}));
vi.mock('mysql2/promise', () => ({ default: { createConnection } }));

function context(path = 'metrics', headers: HeadersInit = {}, method = 'GET'): APIContext {
  return {
    request: new Request(`https://minecraft-gilde.de/api/${path}`, { headers, method }),
    params: { path: path.split('/')[0] },
    locals: {},
  } as unknown as APIContext;
}

describe('Statistik-API: HTTP-Validierung', () => {
  beforeEach(() => {
    const cached = new Response('{"metrics":{}}', {
      headers: {
        ETag: '"current"',
        'Last-Modified': 'Fri, 11 Sep 2026 06:00:00 GMT',
        'Cache-Control': 'public, max-age=3600',
        'Content-Type': 'application/json',
        'X-Stats-Api-Cache': 'MISS',
      },
    });
    vi.stubGlobal('caches', { default: { match: vi.fn(async () => cached.clone()) } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(['"current"', 'W/"current"', '"other", W/"current"', '*'])(
    'erkennt unveränderte Daten mit If-None-Match %s',
    async (etag) => {
      const response = await handleStatsApiProxy(context('metrics/', { 'If-None-Match': etag }));
      expect(response.status).toBe(304);
      expect(await response.text()).toBe('');
      expect(response.headers.get('X-Stats-Api-Cache')).toBe('HIT');
    },
  );

  it('gibt bei abweichendem ETag trotz passendem Datum die neuen Daten zurück', async () => {
    const response = await handleStatsApiProxy(
      context('metrics/', {
        'If-None-Match': '"old"',
        'If-Modified-Since': 'Fri, 11 Sep 2026 06:00:00 GMT',
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ metrics: {} });
  });

  it('prüft das Datum nur ohne If-None-Match und unterstützt HEAD', async () => {
    const response = await handleStatsApiProxy(
      context(
        'metrics/',
        {
          'If-Modified-Since': 'Fri, 11 Sep 2026 06:00:00 GMT',
        },
        'HEAD',
      ),
    );
    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
  });
});

describe('Statistik-API: Datenbank und Cache', () => {
  let stored: Map<string, Response>;
  let runId: number;
  let query: ReturnType<typeof vi.fn>;
  let end: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T06:00:00Z'));
    stored = new Map();
    runId = 1;
    query = vi.fn(async ({ sql }: { sql: string }) => {
      if (sql.includes('FROM site_state'))
        return [[{ run_id: runId, generated_at: '2026-09-11T06:00:00' }]];
      if (sql.includes('FROM metric_def'))
        return [[{ id: 'hours', label: 'Spielzeit', enabled: 1 }]];
      if (sql.includes('FROM v_world_state'))
        return [[{ world_name: 'world', world_age_days: runId, world_age_ticks: runId * 24000 }]];
      return [[]];
    });
    end = vi.fn(async () => {});
    createConnection.mockReset().mockResolvedValue({ query, end });
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async (key: Request) => stored.get(key.url)?.clone()),
        put: vi.fn(async (key: Request, response: Response) => {
          stored.set(key.url, response.clone());
        }),
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    'player/?uuid=invalid',
    'summary/',
    `summary/?metrics=${Array.from({ length: 13 }, (_, i) => `m${i}`).join(',')}`,
    'leaderboard/?metric=hours&cursor=invalid',
    `players/?q=${'a'.repeat(65)}`,
  ])('validiert %s vor dem Datenbankzugriff', async (path) => {
    expect((await handleStatsApiProxy(context(path))).status).toBe(400);
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('beantwortet zu kurze Suchanfragen ohne Datenbank', async () => {
    const response = await handleStatsApiProxy(context('players/?q=a'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [] });
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('teilt Cache-Eintraege fuer gleichwertige Suchanfragen und begrenzt SQL-Abfragen', async () => {
    const first = await handleStatsApiProxy(
      context('players/?q=%20StEvE%20&limit=999&tracking=one'),
    );
    const second = await handleStatsApiProxy(context('players/?limit=25&q=steve&tracking=two'));
    expect(first.status).toBe(200);
    expect(second.headers.get('X-Stats-Api-Cache')).toBe('HIT');
    expect(createConnection).toHaveBeenCalledOnce();
    expect(createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ connectTimeout: 5000 }),
    );
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ timeout: 8000 }), [
      'steve',
      'steve',
      'steve',
      25,
    ]);
    expect(end).toHaveBeenCalledOnce();
  });

  it('verwendet Metrikdefinitionen innerhalb eines Imports wieder', async () => {
    await handleStatsApiProxy(context('metrics/'));
    await handleStatsApiProxy(context('summary/?metrics=hours'));
    const metricQueries = () =>
      query.mock.calls.filter(([options]) => options.sql.includes('FROM metric_def'));
    expect(metricQueries()).toHaveLength(1);
    runId = 2;
    await handleStatsApiProxy(context('leaderboard/?metric=hours'));
    expect(metricQueries()).toHaveLength(2);
    expect(end).toHaveBeenCalledTimes(3);
  });

  it('meldet Suchfehler als 503 und speichert sie nicht als leere Trefferliste', async () => {
    query.mockRejectedValue(new Error('database unavailable'));
    const response = await handleStatsApiProxy(context('players/?q=steve'));
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(createConnection).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(2);
    expect(stored.size).toBe(0);
  });

  it('bewahrt Antworten fuer Fehlerfaelle auf, ohne ihre Frische zu verlaengern', async () => {
    const first = await handleStatsApiProxy(context('world-state/'));
    expect(first.headers.get('Cache-Control')).toContain('max-age=60');
    const retained = stored.get('https://minecraft-gilde.de/__cache/stats-api/v2/world-state')!;
    expect(retained.headers.get('Cache-Control')).toBe('public, max-age=360');
    await vi.advanceTimersByTimeAsync(40_000);
    const hit = await handleStatsApiProxy(context('world-state/'));
    expect(hit.headers.get('Age')).toBe('40');
    expect(hit.headers.get('X-Stats-Cache-Fresh-Until')).toBeNull();
    expect(createConnection).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(21_000);
    createConnection.mockRejectedValue(new Error('offline'));
    const stale = await handleStatsApiProxy(
      context('world-state/', { 'If-None-Match': first.headers.get('ETag')! }),
    );
    expect(stale.status).toBe(200);
    expect(stale.headers.get('X-Stats-Api-Cache')).toBe('STALE');
    expect(stale.headers.get('Cache-Control')).toBe('no-store');
    expect(await stale.json()).toMatchObject({ world: { ageDays: 1 } });
    await vi.advanceTimersByTimeAsync(300_000);
    expect((await handleStatsApiProxy(context('world-state/'))).status).toBe(500);
  });

  it('aktualisiert kurz abgelaufene Antworten im Hintergrund', async () => {
    await handleStatsApiProxy(context('world-state/'));
    await vi.advanceTimersByTimeAsync(61_000);
    runId = 2;
    const pending: Promise<unknown>[] = [];
    const ctx = context('world-state/');
    Object.assign(ctx.locals, {
      cfContext: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
    });
    const stale = await handleStatsApiProxy(ctx);
    expect(stale.headers.get('X-Stats-Api-Cache')).toBe('STALE');
    expect(await stale.json()).toMatchObject({ world: { ageDays: 1 } });
    await Promise.all(pending);
    const fresh = await handleStatsApiProxy(context('world-state/'));
    expect(fresh.headers.get('X-Stats-Api-Cache')).toBe('HIT');
    expect(await fresh.json()).toMatchObject({ world: { ageDays: 2 } });
  });

  it('begrenzt die gesamte Profil-Fallback-Kette auf neun Sekunden', async () => {
    const fetchMock = vi.fn(
      (_url, { signal }: RequestInit) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const responsePromise = handleStatsApiProxy(
      context('profile/?uuid=00000000-0000-0000-0000-000000009999'),
    );
    await vi.advanceTimersByTimeAsync(9000);
    const response = await responsePromise;
    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(createConnection).not.toHaveBeenCalled();
  });
});
