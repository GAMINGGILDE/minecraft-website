import { minecraftGilde } from '../../../config/minecraftGilde';
import {
  getMinecraftStatusRetryMs,
  isMinecraftStatusSnapshot,
  isUsableMinecraftStatus,
  MINECRAFT_STATUS_MAX_AGE_MS,
  MINECRAFT_STATUS_RETRY_MS,
  parseMinecraftStatus,
  type MinecraftStatusResponse,
  type MinecraftStatusSnapshot,
} from '../../minecraft/status';
import { parseRetryAfterMs } from '../retryAfter';

const UPSTREAM_TIMEOUT_MS = 6_500;
const MAX_RESPONSE_BYTES = 256 * 1_024;

interface CacheEntry {
  data?: MinecraftStatusSnapshot;
  retryAt: number;
  errorStatus?: number;
  failures?: number;
}

type StatusCache = Pick<Cache, 'match' | 'put'>;

function runtimeCache(): StatusCache | undefined {
  return typeof caches !== 'undefined' && 'default' in caches
    ? (caches.default as Cache)
    : undefined;
}

async function readCache(cache: StatusCache | undefined, key: Request): Promise<CacheEntry | null> {
  try {
    const response = await cache?.match(key);
    if (!response) return null;
    const entry: unknown = await response.json();
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('retryAt' in entry) ||
      typeof entry.retryAt !== 'number' ||
      !Number.isFinite(entry.retryAt) ||
      ('failures' in entry &&
        (typeof entry.failures !== 'number' ||
          !Number.isSafeInteger(entry.failures) ||
          entry.failures < 0)) ||
      ('data' in entry && !isMinecraftStatusSnapshot(entry.data)) ||
      ('errorStatus' in entry && ![429, 502, 504].includes(Number(entry.errorStatus)))
    )
      return null;
    return entry as CacheEntry;
  } catch {
    console.warn(JSON.stringify({ event: 'minecraft_status_cache_read_failed' }));
    return null;
  }
}

async function writeCache(
  cache: StatusCache | undefined,
  key: Request,
  entry: CacheEntry,
): Promise<void> {
  if (!cache) return;
  // Die Fehlerstufe muss auch ohne Fallback-Daten bis nach der Retry-Pause erhalten bleiben.
  const retainUntil = Math.max(
    entry.retryAt + (entry.failures ? MINECRAFT_STATUS_MAX_AGE_MS : 0),
    (entry.data?.updatedAt ?? 0) + MINECRAFT_STATUS_MAX_AGE_MS,
  );
  const ttl = Math.max(1, Math.ceil((retainUntil - Date.now()) / 1_000));
  try {
    await cache.put(
      key,
      Response.json(entry, { headers: { 'Cache-Control': `public, max-age=${ttl}` } }),
    );
  } catch {
    console.warn(JSON.stringify({ event: 'minecraft_status_cache_write_failed' }));
  }
}

async function readUpstreamJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Leere Statusantwort.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Statusantwort ist zu gross.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

function statusResponse(request: Request, entry: CacheEntry, source: string): Response {
  const now = Date.now();
  const data = entry.data && isUsableMinecraftStatus(entry.data, now) ? entry.data : undefined;
  const retryAfterMs = Math.max(0, entry.retryAt - now);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    // Der interne Edge-Cache verwaltet Frische und Fehler-Fallback getrennt.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Minecraft-Cache': source,
  };
  if (!data) headers['Retry-After'] = String(Math.max(1, Math.ceil(retryAfterMs / 1_000)));
  const body: MinecraftStatusResponse | { error: string } = data
    ? {
        data,
        stale: Boolean(entry.errorStatus) || now >= data.expiresAt,
        ...(retryAfterMs > 0 && entry.errorStatus ? { retryAfterMs } : {}),
      }
    : { error: 'Minecraft-Status aktuell nicht verfügbar.' };
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), {
    status: data ? 200 : (entry.errorStatus ?? 502),
    headers,
  });
}

export async function handleMinecraftStatus(
  request: Request,
  cache: StatusCache | undefined = runtimeCache(),
): Promise<Response> {
  // Host und Parameter des Besuchers duerfen das Abfrageziel nicht beeinflussen.
  const key = new Request(
    `https://minecraft-gilde.de/__cache/minecraft-status/v1/${encodeURIComponent(minecraftGilde.serverIp)}`,
  );
  const cached = await readCache(cache, key);
  const now = Date.now();
  if (cached && (cached.retryAt > now || (cached.data && cached.data.expiresAt > now))) {
    return statusResponse(request, cached, 'HIT');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let errorStatus = 502;
  const failures = Math.min(3, (cached?.failures ?? 0) + 1);
  let retryMs = getMinecraftStatusRetryMs(failures);
  let next: CacheEntry;
  try {
    const response = await fetch(
      `https://api.mcsrvstat.us/3/${encodeURIComponent(minecraftGilde.serverIp)}`,
      {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'MinecraftGilde-Website/1.0 (+https://minecraft-gilde.de)',
        },
      },
    );
    if (!response.ok) {
      if (response.status === 429) errorStatus = 429;
      retryMs = Math.max(retryMs, parseRetryAfterMs(response.headers.get('Retry-After')) ?? 0);
      await response.body?.cancel();
      throw new Error('Statusquelle nicht verfuegbar.');
    }
    const data = parseMinecraftStatus(await readUpstreamJson(response));
    if (!data) throw new Error('Ungueltige Statusantwort.');
    next = { data, retryAt: Math.max(data.expiresAt, Date.now() + MINECRAFT_STATUS_RETRY_MS) };
  } catch {
    if (controller.signal.aborted) errorStatus = 504;
    const data = cached?.data && isUsableMinecraftStatus(cached.data) ? cached.data : undefined;
    next = { ...(data ? { data } : {}), errorStatus, failures, retryAt: Date.now() + retryMs };
    console.warn(
      JSON.stringify({
        event: 'minecraft_status_upstream_failed',
        status: errorStatus,
        fallback: Boolean(data),
      }),
    );
  } finally {
    clearTimeout(timeout);
  }
  await writeCache(cache, key, next);
  return statusResponse(request, next, next.errorStatus ? 'FALLBACK' : 'MISS');
}
