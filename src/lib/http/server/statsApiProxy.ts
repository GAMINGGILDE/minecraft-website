import type { APIContext } from 'astro';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { env as workerEnv } from 'cloudflare:workers';
import mysql from 'mysql2/promise';
import type { Connection, ConnectionOptions, RowDataPacket } from 'mysql2/promise';
import { readBoundedText } from './readBoundedText';
import {
  BAN_STATUS_RATE_LIMIT,
  consumeDefaultFixedWindowRateLimit,
  type FixedWindowRateLimitDecision,
} from './rateLimit';

type CacheProfile = {
  maxAgeSeconds: number;
  staleWhileRevalidateSeconds: number;
  staleIfErrorSeconds: number;
};

type MetricDef = {
  label: string;
  category: string;
  unit: string | null;
  sortOrder: number;
  divisor: number | null;
  decimals: number | null;
};

type ActiveRun = {
  runId: number;
  generatedAt: Date | null;
  generatedIso: string | null;
  generatedTimeZone: string | null;
};

type MojangCacheEntry = {
  type: 'positive' | 'negative';
  body: string;
  mtime: number;
};

type MojangProfileFetchOptions = {
  allowFallback?: boolean;
  acceptFallbackProfile?: (body: string, provider: MojangFallbackProvider) => boolean;
};

type MojangCacheOptions = MojangProfileFetchOptions & {
  cacheKeyPrefix?: string;
  positiveMaxAgeSeconds?: (body: string) => number;
};

type MojangFallbackProvider = 'minetools' | 'ashcon';

type MojangProfileResult = {
  status: number;
  body: string;
};

type MojangSessionProfileResult = {
  profile: MojangProfileResult | null;
  status: number;
};

type MojangFallbackCandidate = MojangProfileResult & {
  provider: MojangFallbackProvider;
  convertedBody: string | null;
};

type MojangCachedResult =
  | {
      ok: true;
      type: 'positive' | 'negative';
      body: string;
      mtime: number;
      maxAgeSeconds: number;
    }
  | {
      ok: false;
      status: number;
      error: string;
      upstreamStatus?: number;
    };

type DbConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  charset: string;
};

type RuntimeEnv = Record<string, unknown>;

type RuntimeLocals = {
  cfContext?: {
    waitUntil?: (promise: Promise<unknown>) => void;
  };
};

type HyperdriveBinding = {
  connectionString?: unknown;
  host?: unknown;
  port?: unknown;
  user?: unknown;
  password?: unknown;
  database?: unknown;
};

const mojangMemoryCache = new Map<string, MojangCacheEntry>();

const API_MAX_LIMIT = 100;
const API_MAX_SEARCH = 25;
const PROFILE_FETCH_BUDGET_MS = 9_000;
const PROFILE_MAX_RESPONSE_BYTES = 256 * 1024;

const PROFILE_CACHE_FRESH_SECONDS = 6 * 3600;
const PROFILE_CACHE_NEGATIVE_SECONDS = 10 * 60;
const PROFILE_CACHE_STALE_ON_ERROR_SECONDS = 30;
const PROFILE_CACHE_STALE_WHILE_REVALIDATE_SECONDS = 30;
const PROFILE_CACHE_STALE_IF_ERROR_SECONDS = 24 * 3600;
const PROFILE_CACHE_KEY_PREFIX = 'mojang-profile';
const PROFILE_SESSION_CACHE_KEY_PREFIX = 'mojang-profile-session-v2';
const CAPE_EMPTY_PROFILE_CACHE_FRESH_SECONDS = 30 * 60;

const CACHE_PROFILES: Record<string, CacheProfile> = {
  metrics: {
    maxAgeSeconds: 3600,
    staleWhileRevalidateSeconds: 300,
    staleIfErrorSeconds: 24 * 3600,
  },
  summary: {
    maxAgeSeconds: 60,
    staleWhileRevalidateSeconds: 30,
    staleIfErrorSeconds: 300,
  },
  leaderboards: {
    maxAgeSeconds: 60,
    staleWhileRevalidateSeconds: 30,
    staleIfErrorSeconds: 300,
  },
  'world-state': {
    maxAgeSeconds: 60,
    staleWhileRevalidateSeconds: 30,
    staleIfErrorSeconds: 300,
  },
  leaderboard: {
    maxAgeSeconds: 60,
    staleWhileRevalidateSeconds: 30,
    staleIfErrorSeconds: 300,
  },
  players: {
    maxAgeSeconds: 30,
    staleWhileRevalidateSeconds: 30,
    staleIfErrorSeconds: 120,
  },
  player: {
    maxAgeSeconds: 60,
    staleWhileRevalidateSeconds: 30,
    staleIfErrorSeconds: 300,
  },
  'ban-status': {
    maxAgeSeconds: 60,
    staleWhileRevalidateSeconds: 30,
    staleIfErrorSeconds: 300,
  },
  cape: {
    maxAgeSeconds: PROFILE_CACHE_FRESH_SECONDS,
    staleWhileRevalidateSeconds: PROFILE_CACHE_STALE_WHILE_REVALIDATE_SECONDS,
    staleIfErrorSeconds: PROFILE_CACHE_STALE_IF_ERROR_SECONDS,
  },
  profile: {
    maxAgeSeconds: PROFILE_CACHE_FRESH_SECONDS,
    staleWhileRevalidateSeconds: PROFILE_CACHE_STALE_WHILE_REVALIDATE_SECONDS,
    staleIfErrorSeconds: PROFILE_CACHE_STALE_IF_ERROR_SECONDS,
  },
  default: {
    maxAgeSeconds: 30,
    staleWhileRevalidateSeconds: 30,
    staleIfErrorSeconds: 120,
  },
};

const ALLOWED_ENDPOINTS = new Set([
  'metrics',
  'summary',
  'leaderboards',
  'world-state',
  'leaderboard',
  'players',
  'player',
  'ban-status',
  'cape',
  'profile',
]);

function summarizeError(error: unknown): {
  name: string;
  message: string;
  code?: string;
  errno?: number;
} {
  const errorObject = error as {
    message?: unknown;
    name?: unknown;
    code?: unknown;
    errno?: unknown;
  };
  return {
    name: typeof errorObject?.name === 'string' ? errorObject.name : 'UnknownError',
    message: typeof errorObject?.message === 'string' ? errorObject.message : String(error),
    code: typeof errorObject?.code === 'string' ? errorObject.code : undefined,
    errno: typeof errorObject?.errno === 'number' ? errorObject.errno : undefined,
  };
}

function asRuntimeEnv(): RuntimeEnv {
  return workerEnv as RuntimeEnv;
}

function asExecutionContext(context: APIContext):
  | {
      waitUntil?: (promise: Promise<unknown>) => void;
    }
  | undefined {
  return (context.locals as RuntimeLocals).cfContext;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== 'string') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function getEdgeCache(): Cache | null {
  if (typeof caches === 'undefined') return null;
  const maybeCache = (caches as unknown as { default?: Cache }).default;
  return maybeCache ?? null;
}

function buildCacheControl(profile: CacheProfile): string {
  return `public, max-age=${profile.maxAgeSeconds}, s-maxage=${profile.maxAgeSeconds}, stale-while-revalidate=${profile.staleWhileRevalidateSeconds}, stale-if-error=${profile.staleIfErrorSeconds}`;
}

function resolveCacheProfile(endpoint: string): CacheProfile {
  return CACHE_PROFILES[endpoint] ?? CACHE_PROFILES.default;
}

function sha1Hex(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function sanitizeUuidHex(input: string | null): string | null {
  if (!input) return null;
  const cleaned = input.toLowerCase().replace(/[^0-9a-f]/g, '');
  return cleaned.length === 32 ? cleaned : null;
}

function uuidHexToDashed(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function encodeCursor(value: number, uuidHex: string): string {
  const plain = `${value}:${uuidHex.toLowerCase()}`;
  return Buffer.from(plain, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { value: number; uuidHex: string } | null {
  const value = cursor.trim();
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const [rawValue, rawUuidHex] = decoded.split(':', 2);
    if (rawValue === undefined || rawUuidHex === undefined) return null;
    const parsedValue = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsedValue)) return null;
    const uuidHex = sanitizeUuidHex(rawUuidHex);
    if (!uuidHex) return null;
    return { value: parsedValue, uuidHex };
  } catch {
    return null;
  }
}

function clampLimit(limit: number): number {
  const n = Number.isFinite(limit) ? Math.trunc(limit) : 1;
  if (n < 1) return 1;
  if (n > API_MAX_LIMIT) return API_MAX_LIMIT;
  return n;
}

function escapeLikeInput(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

function normalizeMysqlDateTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .trim()
    .replace(' ', 'T')
    .replace(/\.\d+$/, '');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalized)) return normalized;
  return null;
}

function toUtcIsoOrNull(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();

  const utcDateTime = normalizeMysqlDateTime(value);
  return utcDateTime ? `${utcDateTime}Z` : null;
}

function toUtcDateOrNull(value: unknown): Date | null {
  const iso = toUtcIsoOrNull(value);
  if (!iso) return null;

  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
}

function parseNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (Buffer.isBuffer(value)) {
    const parsed = Number(value.toString('utf8'));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function parseInteger(value: unknown, fallback = 0): number {
  return Math.trunc(parseNumber(value, fallback));
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return parseInteger(value, fallback ? 1 : 0) !== 0;
}

function applyDivisor(raw: number, divisor: number | null): number {
  if (divisor !== null && divisor > 0) {
    return raw / divisor;
  }
  return raw;
}

function withApiHeaders(
  source: Response,
  options: {
    cacheStatus: 'HIT' | 'MISS' | 'BYPASS' | 'STALE';
  },
): Response {
  const headers = new Headers(source.headers);
  headers.set('X-Stats-Api-Proxy', '1');
  headers.set('X-Stats-Api-Cache', options.cacheStatus);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.delete('Set-Cookie');
  headers.delete('set-cookie');

  return new Response(source.body, {
    status: source.status,
    statusText: source.statusText,
    headers,
  });
}

function withoutBody(response: Response): Response {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function maybeNotModified(request: Request, response: Response): Response | null {
  if (response.status !== 200) return null;
  const etag = response.headers.get('ETag');
  const lastModified = response.headers.get('Last-Modified');
  const ifNoneMatch = request.headers.get('If-None-Match');
  const ifModifiedSince = request.headers.get('If-Modified-Since');

  const etagMatches =
    ifNoneMatch !== null &&
    (ifNoneMatch.trim() === '*' ||
      (etag !== null &&
        (ifNoneMatch.match(/(?:W\/)?"[^"]*"/g) ?? []).some(
          (part) => part.replace(/^W\//, '') === etag.replace(/^W\//, ''),
        )));

  const modifiedSinceMatches =
    lastModified !== null &&
    ifModifiedSince !== null &&
    Number.isFinite(Date.parse(lastModified)) &&
    Number.isFinite(Date.parse(ifModifiedSince)) &&
    Date.parse(ifModifiedSince) >= Date.parse(lastModified);

  // If-None-Match hat auch bei einem abweichenden ETag Vorrang vor dem Datum.
  if (!(ifNoneMatch !== null ? etagMatches : modifiedSinceMatches)) {
    return null;
  }

  const headers = new Headers(response.headers);
  headers.delete('Content-Type');
  headers.delete('Content-Length');
  return new Response(null, { status: 304, headers });
}

function jsonResponse(
  payload: unknown,
  init: { status?: number; headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers,
  });
}

function jsonError(status: number, message: string): Response {
  return jsonResponse(
    { error: message },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}

function rateLimitErrorResponse(decision: FixedWindowRateLimitDecision): Response {
  return jsonResponse(
    { error: 'rate limit exceeded' },
    {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(decision.retryAfterSeconds),
        'X-RateLimit-Limit': String(decision.limit),
        'X-RateLimit-Remaining': String(decision.remaining),
        'X-RateLimit-Reset': String(Math.ceil(decision.resetAtMs / 1_000)),
      },
    },
  );
}

function firstForwardedAddress(headerValue: string | null): string | null {
  const value = headerValue?.split(',')[0]?.trim();
  return value && value.length > 0 ? value : null;
}

function readClientAddress(context: APIContext): string {
  return (
    firstForwardedAddress(context.request.headers.get('CF-Connecting-IP')) ??
    firstForwardedAddress(context.request.headers.get('X-Forwarded-For')) ??
    firstForwardedAddress(context.request.headers.get('X-Real-IP')) ??
    'unknown'
  );
}

function maybeRateLimitBanStatus(context: APIContext, endpoint: string): Response | null {
  if (endpoint !== 'ban-status') return null;

  const clientAddress = readClientAddress(context);
  const decision = consumeDefaultFixedWindowRateLimit(
    `ban-status:${clientAddress}`,
    BAN_STATUS_RATE_LIMIT,
  );
  return decision.allowed ? null : rateLimitErrorResponse(decision);
}

function resolveDbConfig(env: RuntimeEnv): DbConfig {
  const fromHyperdrive = resolveDbConfigFromHyperdrive(env.HYPERDRIVE);

  const host = fromHyperdrive.host ?? asNonEmptyString(env.STATS_DB_HOST);
  const port = fromHyperdrive.port ?? asPositiveInt(env.STATS_DB_PORT) ?? 3306;
  const user = fromHyperdrive.user ?? asNonEmptyString(env.STATS_DB_USER);
  const password = fromHyperdrive.password ?? asNonEmptyString(env.STATS_DB_PASS);
  const database = fromHyperdrive.database ?? asNonEmptyString(env.STATS_DB_NAME);
  const charset = asNonEmptyString(env.STATS_DB_CHARSET) ?? 'utf8mb4';

  if (!host || !user || !database || password === null) {
    throw new Error('DB not configured');
  }

  return {
    host,
    port,
    user,
    password,
    database,
    charset,
  };
}

function resolveDbConfigFromHyperdrive(bindingValue: unknown): Partial<DbConfig> {
  if (!bindingValue || typeof bindingValue !== 'object') {
    return {};
  }

  const binding = bindingValue as HyperdriveBinding;
  const connectionString = asNonEmptyString(binding.connectionString);
  if (!isSupportedSqlConnectionString(connectionString)) {
    return {};
  }
  const parsedFromConnection = parseConnectionString(connectionString);

  return {
    host: asNonEmptyString(binding.host) ?? parsedFromConnection.host ?? undefined,
    port: asPositiveInt(binding.port) ?? parsedFromConnection.port ?? undefined,
    user: asNonEmptyString(binding.user) ?? parsedFromConnection.user ?? undefined,
    password: asNonEmptyString(binding.password) ?? parsedFromConnection.password ?? undefined,
    database: asNonEmptyString(binding.database) ?? parsedFromConnection.database ?? undefined,
  };
}

function parseConnectionString(connectionString: string | null): Partial<DbConfig> {
  if (!connectionString) return {};

  try {
    const url = new URL(connectionString);
    const protocol = url.protocol.toLowerCase();
    if (protocol !== 'mysql:' && protocol !== 'mariadb:') {
      return {};
    }
    const database = url.pathname.replace(/^\/+/, '') || null;
    return {
      host: url.hostname || undefined,
      port: url.port ? Number.parseInt(url.port, 10) : undefined,
      user: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      database: database ?? undefined,
    };
  } catch {
    return {};
  }
}

function isSupportedSqlConnectionString(connectionString: string | null): boolean {
  if (!connectionString) return true;

  try {
    const protocol = new URL(connectionString).protocol.toLowerCase();
    return protocol === 'mysql:' || protocol === 'mariadb:';
  } catch {
    return false;
  }
}

async function createDbConnection(env: RuntimeEnv): Promise<Connection> {
  const db = resolveDbConfig(env);
  const options: ConnectionOptions = {
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    charset: db.charset,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: true,
    disableEval: true,
    connectTimeout: 5_000,
  };

  return mysql.createConnection(options);
}

async function queryRows<T extends RowDataPacket>(
  connection: Connection,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const [rows] = await connection.query<T[]>({ sql, timeout: 8_000 }, params);
  return rows;
}

async function closeDbConnection(connection: Connection): Promise<void> {
  try {
    await connection.end();
  } catch {
    // Die Verbindung ist nur request-lokal und darf das API-Ergebnis nicht ueberschreiben.
  }
}

async function getActiveRun(connection: Connection): Promise<ActiveRun> {
  const rows = await queryRows<RowDataPacket>(
    connection,
    `SELECT s.active_run_id AS run_id,
            DATE_FORMAT(r.generated_at, '%Y-%m-%dT%H:%i:%s') AS generated_at
     FROM site_state s
     LEFT JOIN import_run r ON r.id = s.active_run_id
     WHERE s.id = 1`,
  );
  const row = rows[0];
  const generatedIso = toUtcIsoOrNull(row?.generated_at);
  const generatedAt = toUtcDateOrNull(row?.generated_at);
  return {
    runId: parseInteger(row?.run_id, 0),
    generatedAt,
    generatedIso,
    generatedTimeZone: generatedIso ? 'UTC' : null,
  };
}

function emptyActiveRun(): ActiveRun {
  return {
    runId: 0,
    generatedAt: null,
    generatedIso: null,
    generatedTimeZone: null,
  };
}

async function loadMetricDefs(route: DataRouteContext): Promise<Record<string, MetricDef>> {
  const cache = route.active.runId > 0 ? getEdgeCache() : null;
  const key = new Request(
    new URL(`/__cache/stats-metric-defs/v1/${route.active.runId}`, route.requestUrl),
  );
  try {
    const cached = await cache?.match(key);
    if (cached) return (await cached.json()) as Record<string, MetricDef>;
  } catch {
    // Der optionale Cache darf die Datenbankabfrage nicht verhindern.
  }
  const defs = await queryMetricDefs(route.db);
  try {
    await cache?.put(
      key,
      Response.json(defs, { headers: { 'Cache-Control': 'public, max-age=3600' } }),
    );
  } catch {
    console.warn('[stats-api] metric cache write failed');
  }
  return defs;
}

async function queryMetricDefs(connection: Connection): Promise<Record<string, MetricDef>> {
  let rows: RowDataPacket[];
  try {
    rows = await queryRows<RowDataPacket>(
      connection,
      `SELECT id, label, category, unit, sort_order, enabled,
              COALESCE(divisor, NULL) AS divisor,
              COALESCE(decimals, NULL) AS decimals
       FROM metric_def
       WHERE enabled = 1
       ORDER BY sort_order ASC, id ASC`,
    );
  } catch (error) {
    const maybeError = error as { code?: unknown; message?: unknown };
    const isMissingLegacyColumn =
      maybeError?.code === 'ER_BAD_FIELD_ERROR' &&
      typeof maybeError?.message === 'string' &&
      (maybeError.message.includes("'divisor'") || maybeError.message.includes("'decimals'"));
    if (!isMissingLegacyColumn) throw error;

    rows = await queryRows<RowDataPacket>(
      connection,
      `SELECT id, label, category, unit, sort_order, enabled
       FROM metric_def
       WHERE enabled = 1
       ORDER BY sort_order ASC, id ASC`,
    );
  }

  const defs: Record<string, MetricDef> = {};
  for (const row of rows) {
    const id = asNonEmptyString(row.id);
    if (!id) continue;
    defs[id] = {
      label: String(row.label ?? ''),
      category: String(row.category ?? ''),
      unit: row.unit === null ? null : String(row.unit ?? ''),
      sortOrder: parseInteger(row.sort_order, 0),
      divisor:
        row.divisor === undefined || row.divisor === null ? null : parseInteger(row.divisor, 0),
      decimals:
        row.decimals === undefined || row.decimals === null ? null : parseInteger(row.decimals, 0),
    };
  }

  return defs;
}

async function fetchPlayersByHex(
  connection: Connection,
  uuidHexList: string[],
): Promise<Record<string, string>> {
  const unique = Array.from(
    new Set(uuidHexList.map((v) => v.toLowerCase()).filter((v) => v.length === 32)),
  );
  if (unique.length === 0) {
    return {};
  }

  const out: Record<string, string> = {};
  const chunkSize = 800;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => 'UNHEX(?)').join(',');
    const rows = await queryRows<RowDataPacket>(
      connection,
      `SELECT LOWER(HEX(uuid)) AS uuid_hex, name
       FROM v_player_profile
       WHERE uuid IN (${placeholders})`,
      chunk,
    );

    for (const row of rows) {
      const uuidHex = asNonEmptyString(row.uuid_hex);
      if (!uuidHex || uuidHex.length !== 32) continue;
      const dashed = uuidHexToDashed(uuidHex);
      out[dashed] = String(row.name ?? dashed);
    }
  }

  return out;
}

function decodeStatsPayload(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;

  let jsonText: string;
  if (Buffer.isBuffer(raw)) {
    try {
      jsonText = gunzipSync(raw).toString('utf8');
    } catch {
      jsonText = raw.toString('utf8');
    }
  } else if (typeof raw === 'string') {
    try {
      jsonText = gunzipSync(Buffer.from(raw, 'binary')).toString('utf8');
    } catch {
      jsonText = raw;
    }
  } else {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function parseJsonUnknown(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function decodeBase64Utf8(value: string): string | null {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function buildMojangProfileFromAshconBody(uuidHex: string, body: string): string | null {
  const parsed = parseJsonUnknown(body);
  if (!parsed || typeof parsed !== 'object') return null;

  const textures = (parsed as { textures?: unknown }).textures;
  if (!textures || typeof textures !== 'object') return null;

  const raw = (textures as { raw?: unknown }).raw;
  if (!raw || typeof raw !== 'object') return null;

  const textureValue = asNonEmptyString((raw as { value?: unknown }).value);
  if (!textureValue) return null;

  const textureSignature = asNonEmptyString((raw as { signature?: unknown }).signature);
  const rawUuid = asNonEmptyString((parsed as { uuid?: unknown }).uuid);
  const resolvedUuidHex = sanitizeUuidHex(rawUuid) ?? uuidHex;
  const resolvedName =
    asNonEmptyString((parsed as { username?: unknown }).username) ?? resolvedUuidHex;

  const property: { name: string; value: string; signature?: string } = {
    name: 'textures',
    value: textureValue,
  };
  if (textureSignature) {
    property.signature = textureSignature;
  }

  return JSON.stringify({
    id: resolvedUuidHex,
    name: resolvedName,
    properties: [property],
    profileActions: [],
  });
}

function buildMojangProfileFromMinetoolsBody(uuidHex: string, body: string): string | null {
  const parsed = parseJsonUnknown(body);
  if (!parsed || typeof parsed !== 'object') return null;

  const raw = (parsed as { raw?: unknown }).raw;
  if (raw && typeof raw === 'object') {
    const properties = (raw as { properties?: unknown }).properties;
    if (Array.isArray(properties)) {
      const hasTextures = properties.some(
        (property) =>
          property &&
          typeof property === 'object' &&
          (property as { name?: unknown }).name === 'textures' &&
          typeof (property as { value?: unknown }).value === 'string',
      );
      if (hasTextures) {
        const rawUuid = asNonEmptyString((raw as { id?: unknown }).id);
        const resolvedUuidHex = sanitizeUuidHex(rawUuid) ?? uuidHex;
        const resolvedName = asNonEmptyString((raw as { name?: unknown }).name) ?? resolvedUuidHex;
        return JSON.stringify({
          id: resolvedUuidHex,
          name: resolvedName,
          properties,
          profileActions: [],
        });
      }
    }
  }

  const decoded = (parsed as { decoded?: unknown }).decoded;
  if (!decoded || typeof decoded !== 'object') return null;

  const textures = (decoded as { textures?: unknown }).textures;
  if (!textures || typeof textures !== 'object') return null;

  const rawUuid = asNonEmptyString((decoded as { profileId?: unknown }).profileId);
  const resolvedUuidHex = sanitizeUuidHex(rawUuid) ?? uuidHex;
  const resolvedName =
    asNonEmptyString((decoded as { profileName?: unknown }).profileName) ?? resolvedUuidHex;
  const textureValue = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64');

  return JSON.stringify({
    id: resolvedUuidHex,
    name: resolvedName,
    properties: [{ name: 'textures', value: textureValue }],
    profileActions: [],
  });
}

function normalizeMinecraftTextureUrl(rawUrl: string): string {
  return rawUrl.toLowerCase().startsWith('http://textures.minecraft.net/')
    ? `https://${rawUrl.slice(7)}`
    : rawUrl;
}

function extractCapeFromTexturesPayload(textures: unknown): { url: string; alias?: string } | null {
  if (!textures || typeof textures !== 'object') return null;

  const cape = (textures as { textures?: { CAPE?: unknown } }).textures?.CAPE;
  if (!cape || typeof cape !== 'object') return null;

  const rawUrl = asNonEmptyString((cape as { url?: unknown }).url);
  if (!rawUrl) return null;

  const url = normalizeMinecraftTextureUrl(rawUrl);
  const alias = asNonEmptyString((cape as { alias?: unknown }).alias);
  return alias ? { url, alias } : { url };
}

function inspectTexturesProperty(property: unknown): {
  matched: boolean;
  cape: { url: string; alias?: string } | null;
} {
  if (!property || typeof property !== 'object') {
    return { matched: false, cape: null };
  }

  const name = (property as { name?: unknown }).name;
  const value = (property as { value?: unknown }).value;
  if (name !== 'textures' || typeof value !== 'string' || value.length === 0) {
    return { matched: false, cape: null };
  }

  const decoded = decodeBase64Utf8(value);
  if (!decoded) {
    return { matched: false, cape: null };
  }

  const textures = parseJsonUnknown(decoded);
  if (!textures || typeof textures !== 'object') {
    return { matched: false, cape: null };
  }

  return {
    matched: true,
    cape: extractCapeFromTexturesPayload(textures),
  };
}

function extractCapeFromProfile(profileJson: string): { url: string; alias?: string } | null {
  const profile = parseJsonUnknown(profileJson);
  if (!profile || typeof profile !== 'object') return null;

  const properties = (profile as { properties?: unknown }).properties;
  if (!Array.isArray(properties)) return null;

  for (const property of properties) {
    const result = inspectTexturesProperty(property);
    if (!result.matched) continue;
    return result.cape;
  }

  return null;
}

function mojangCacheMemoryKey(cacheKeyPrefix: string, uuidHex: string): string {
  return `${cacheKeyPrefix}:${uuidHex}`;
}

function resolvePositiveProfileMaxAgeSeconds(body: string, options: MojangCacheOptions): number {
  const resolved = options.positiveMaxAgeSeconds?.(body);
  return typeof resolved === 'number' && Number.isFinite(resolved) && resolved > 0
    ? resolved
    : PROFILE_CACHE_FRESH_SECONDS;
}

async function readMojangCache(
  uuidHex: string,
  cacheKeyPrefix = PROFILE_CACHE_KEY_PREFIX,
): Promise<MojangCacheEntry | null> {
  const edgeCache = getEdgeCache();
  if (edgeCache) {
    try {
      const key = new Request(`https://cache.internal.mg/${cacheKeyPrefix}/${uuidHex}`, {
        method: 'GET',
      });
      const cached = await edgeCache.match(key);
      if (cached) {
        const payload = (await cached.json()) as MojangCacheEntry;
        if (
          (payload.type === 'positive' || payload.type === 'negative') &&
          typeof payload.body === 'string' &&
          Number.isFinite(payload.mtime)
        ) {
          return payload;
        }
      }
    } catch {
      // Cache-Layer ist optional und darf den Request nicht brechen.
    }
  }

  const memoryKey = mojangCacheMemoryKey(cacheKeyPrefix, uuidHex);
  const inMemory = mojangMemoryCache.get(memoryKey);
  if (!inMemory) return null;
  if (
    (inMemory.type !== 'positive' && inMemory.type !== 'negative') ||
    typeof inMemory.body !== 'string' ||
    !Number.isFinite(inMemory.mtime)
  ) {
    mojangMemoryCache.delete(memoryKey);
    return null;
  }
  return inMemory;
}

function writeMojangCacheToEdge(
  uuidHex: string,
  entry: MojangCacheEntry,
  executionContext: ReturnType<typeof asExecutionContext>,
  cacheKeyPrefix = PROFILE_CACHE_KEY_PREFIX,
): void {
  const edgeCache = getEdgeCache();
  if (!edgeCache) return;

  try {
    const key = new Request(`https://cache.internal.mg/${cacheKeyPrefix}/${uuidHex}`, {
      method: 'GET',
    });
    const response = new Response(JSON.stringify(entry), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${PROFILE_CACHE_STALE_IF_ERROR_SECONDS}`,
      },
    });
    const putPromise = edgeCache.put(key, response);
    executionContext?.waitUntil?.(putPromise);
  } catch {
    // Cache-Layer ist optional und darf den Request nicht brechen.
  }
}

function writeMojangCache(
  uuidHex: string,
  entry: MojangCacheEntry,
  executionContext: ReturnType<typeof asExecutionContext>,
  cacheKeyPrefix = PROFILE_CACHE_KEY_PREFIX,
): void {
  mojangMemoryCache.set(mojangCacheMemoryKey(cacheKeyPrefix, uuidHex), entry);
  writeMojangCacheToEdge(uuidHex, entry, executionContext, cacheKeyPrefix);
}

function cleanupMojangMemoryCache(nowMs: number): void {
  const maxAgeMs = PROFILE_CACHE_STALE_IF_ERROR_SECONDS * 1000;
  for (const [uuidHex, entry] of mojangMemoryCache.entries()) {
    if (nowMs - entry.mtime > maxAgeMs) {
      mojangMemoryCache.delete(uuidHex);
    }
  }
}

function isTerminalMojangProfileStatus(status: number): boolean {
  return (
    status === 200 ||
    status === 204 ||
    status === 404 ||
    (status !== 403 && status !== 429 && status < 500)
  );
}

async function fetchProfileSource(
  url: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<MojangProfileResult> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    return {
      status: response.status,
      body: await readBoundedText(response, PROFILE_MAX_RESPONSE_BYTES),
    };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

async function fetchMojangSessionProfile(
  uuidHex: string,
  signal: AbortSignal,
): Promise<MojangSessionProfileResult> {
  try {
    const profile = await fetchProfileSource(
      `https://sessionserver.mojang.com/session/minecraft/profile/${encodeURIComponent(uuidHex)}`,
      signal,
      4_500,
    );
    if (isTerminalMojangProfileStatus(profile.status)) {
      return { profile, status: profile.status };
    }

    return { profile: null, status: profile.status };
  } catch {
    return { profile: null, status: 0 };
  }
}

async function fetchMojangFallbackCandidate(params: {
  uuidHex: string;
  provider: MojangFallbackProvider;
  url: string;
  convertBody: (uuidHex: string, body: string) => string | null;
  signal: AbortSignal;
}): Promise<MojangFallbackCandidate | null> {
  const { uuidHex, provider, url, convertBody } = params;

  try {
    const { status, body } = await fetchProfileSource(url, params.signal, 3_000);
    const convertedBody = status === 200 ? convertBody(uuidHex, body) : null;
    return { provider, status, body, convertedBody };
  } catch {
    return null;
  }
}

function resolveAcceptedFallbackCandidate(
  candidate: MojangFallbackCandidate | null,
  acceptFallbackProfile: NonNullable<MojangProfileFetchOptions['acceptFallbackProfile']>,
): MojangProfileResult | null {
  if (!candidate) return null;

  if (candidate.status === 200 && candidate.convertedBody) {
    return acceptFallbackProfile(candidate.convertedBody, candidate.provider)
      ? { status: 200, body: candidate.convertedBody }
      : null;
  }

  if (candidate.status === 204 || candidate.status === 404) {
    return { status: candidate.status, body: candidate.body };
  }

  return null;
}

async function fetchMojangProfile(
  uuidHex: string,
  options: MojangProfileFetchOptions = {},
): Promise<MojangProfileResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROFILE_FETCH_BUDGET_MS);
  try {
    return await fetchMojangProfileWithBudget(uuidHex, options, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchMojangProfileWithBudget(
  uuidHex: string,
  options: MojangProfileFetchOptions,
  signal: AbortSignal,
): Promise<MojangProfileResult> {
  const session = await fetchMojangSessionProfile(uuidHex, signal);
  if (session.profile) return session.profile;

  if (options.allowFallback === false) {
    return { status: session.status, body: '' };
  }

  const acceptFallbackProfile = options.acceptFallbackProfile ?? (() => true);

  const minetools = await fetchMojangFallbackCandidate({
    uuidHex,
    signal,
    provider: 'minetools',
    url: `https://api.minetools.eu/profile/${encodeURIComponent(uuidHex)}`,
    convertBody: buildMojangProfileFromMinetoolsBody,
  });
  const minetoolsProfile = resolveAcceptedFallbackCandidate(minetools, acceptFallbackProfile);
  if (minetoolsProfile) return minetoolsProfile;

  const ashcon = await fetchMojangFallbackCandidate({
    uuidHex,
    signal,
    provider: 'ashcon',
    url: `https://api.ashcon.app/mojang/v2/user/${encodeURIComponent(uuidHex)}`,
    convertBody: buildMojangProfileFromAshconBody,
  });
  const ashconProfile = resolveAcceptedFallbackCandidate(ashcon, acceptFallbackProfile);
  if (ashconProfile) return ashconProfile;

  if (ashcon) {
    return {
      status: session.status || ashcon.status,
      body: session.status ? '' : ashcon.body,
    };
  }

  return { status: session.status, body: '' };
}

async function fetchMojangProfileCached(
  context: APIContext,
  uuidHex: string,
  options: MojangCacheOptions = {},
): Promise<MojangCachedResult> {
  const now = Date.now();
  const cacheKeyPrefix = options.cacheKeyPrefix ?? PROFILE_CACHE_KEY_PREFIX;
  cleanupMojangMemoryCache(now);
  const cached = await readMojangCache(uuidHex, cacheKeyPrefix);

  if (cached) {
    const ageSeconds = Math.max(0, Math.floor((now - cached.mtime) / 1000));
    if (
      cached.type === 'positive' &&
      ageSeconds < resolvePositiveProfileMaxAgeSeconds(cached.body, options)
    ) {
      const maxAgeSeconds = resolvePositiveProfileMaxAgeSeconds(cached.body, options);
      return {
        ok: true,
        type: 'positive',
        body: cached.body,
        mtime: cached.mtime,
        maxAgeSeconds: Math.max(1, maxAgeSeconds - ageSeconds),
      };
    }
    if (cached.type === 'negative' && ageSeconds < PROFILE_CACHE_NEGATIVE_SECONDS) {
      return {
        ok: true,
        type: 'negative',
        body: '{}',
        mtime: cached.mtime,
        maxAgeSeconds: Math.max(1, PROFILE_CACHE_NEGATIVE_SECONDS - ageSeconds),
      };
    }
  }

  let upstreamStatus = 0;
  try {
    const upstream = await fetchMojangProfile(uuidHex, options);
    upstreamStatus = upstream.status;

    if (upstream.status === 200 && upstream.body) {
      try {
        JSON.parse(upstream.body);
      } catch {
        throw new Error('invalid json');
      }

      const entry: MojangCacheEntry = {
        type: 'positive',
        body: upstream.body,
        mtime: Date.now(),
      };
      writeMojangCache(uuidHex, entry, asExecutionContext(context), cacheKeyPrefix);
      const maxAgeSeconds = resolvePositiveProfileMaxAgeSeconds(entry.body, options);
      return {
        ok: true,
        type: 'positive',
        body: entry.body,
        mtime: entry.mtime,
        maxAgeSeconds,
      };
    }

    if (upstream.status === 204 || upstream.status === 404) {
      const entry: MojangCacheEntry = {
        type: 'negative',
        body: '{}',
        mtime: Date.now(),
      };
      writeMojangCache(uuidHex, entry, asExecutionContext(context), cacheKeyPrefix);
      return {
        ok: true,
        type: 'negative',
        body: '{}',
        mtime: entry.mtime,
        maxAgeSeconds: PROFILE_CACHE_NEGATIVE_SECONDS,
      };
    }
  } catch {
    // Ignorieren, danach wird stale fallback versucht.
  }

  if (cached) {
    return {
      ok: true,
      type: cached.type,
      body: cached.type === 'negative' ? '{}' : cached.body,
      mtime: cached.mtime,
      maxAgeSeconds: PROFILE_CACHE_STALE_ON_ERROR_SECONDS,
    };
  }

  return {
    ok: false,
    status: 502,
    error: 'upstream error',
    upstreamStatus,
  };
}

function cacheHeadersForEndpoint(endpoint: string): Headers {
  const profile = resolveCacheProfile(endpoint);
  return new Headers({
    'Cache-Control': buildCacheControl(profile),
  });
}

function etagHeaders(
  endpoint: string,
  etagKey: string,
  generatedAt: Date | null,
  maxAgeOverrideSeconds?: number,
): Headers {
  const headers = cacheHeadersForEndpoint(endpoint);
  headers.set('ETag', `"${sha1Hex(etagKey)}"`);
  if (generatedAt) {
    headers.set('Last-Modified', generatedAt.toUTCString());
  }
  if (maxAgeOverrideSeconds !== undefined) {
    headers.set(
      'Cache-Control',
      `public, max-age=${maxAgeOverrideSeconds}, s-maxage=${maxAgeOverrideSeconds}, stale-while-revalidate=${PROFILE_CACHE_STALE_WHILE_REVALIDATE_SECONDS}, stale-if-error=${PROFILE_CACHE_STALE_IF_ERROR_SECONDS}`,
    );
  }
  return headers;
}

function withGenerated<T extends Record<string, unknown>>(payload: T, active: ActiveRun): T {
  return {
    ...payload,
    __generated: active.generatedIso,
    __generated_timezone: active.generatedTimeZone,
  };
}

type DataRouteContext = {
  requestUrl: URL;
  endpoint: string;
  db: Connection;
  active: ActiveRun;
};

type EndpointUuidParams = {
  rawUuid: string;
  uuidHex: string | null;
};

type BanStatusQuery = {
  raw: string;
  nameLc: string;
  uuidHex: string | null;
};

type BanStatusKnownPlayer = {
  uuid: string | null;
  name: string;
  nameSource: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  seenInStats: boolean;
  seenInUsercache: boolean;
  seenInBans: boolean;
};

type BanStatusBan = {
  nameAtBan: string | null;
  reason: string | null;
  bannedBy: string | null;
  bannedAt: string | null;
  expiresAt: string | null;
  isPermanent: boolean;
};

type BanStatusKnownResult = {
  status: 'banned' | 'not_banned';
  player: BanStatusKnownPlayer;
  ban: BanStatusBan | null;
};

type WorldStateResult = {
  name: string;
  ageTicks: number;
  ageDays: number;
  importedAt: string | null;
  importedAtDate: Date | null;
};

function readEndpointUuidParams(
  requestUrl: URL,
  primaryParam: string,
  secondaryParam: string,
): EndpointUuidParams {
  const rawUuid = (
    requestUrl.searchParams.get(primaryParam) ??
    requestUrl.searchParams.get(secondaryParam) ??
    ''
  ).trim();
  return {
    rawUuid,
    uuidHex: sanitizeUuidHex(rawUuid),
  };
}

function mojangErrorResponse(errorResult: Extract<MojangCachedResult, { ok: false }>): Response {
  return jsonResponse(
    {
      error: errorResult.error,
      status: errorResult.upstreamStatus ?? 0,
    },
    {
      status: errorResult.status,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

function resolveCapeProfileMaxAgeSeconds(profileJson: string): number {
  return extractCapeFromProfile(profileJson)
    ? PROFILE_CACHE_FRESH_SECONDS
    : CAPE_EMPTY_PROFILE_CACHE_FRESH_SECONDS;
}

function acceptCapeFallbackProfile(body: string, provider: MojangFallbackProvider): boolean {
  return provider === 'minetools' || extractCapeFromProfile(body) !== null;
}

function parseRequestedMetrics(rawMetrics: string): string[] {
  return Array.from(
    new Set(
      rawMetrics
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
}

async function loadActiveRunSafely(connection: Connection, endpoint: string): Promise<ActiveRun> {
  try {
    return await getActiveRun(connection);
  } catch (error) {
    console.warn('[stats-api] active run lookup failed', {
      endpoint,
      ...summarizeError(error),
    });
    return emptyActiveRun();
  }
}

async function buildDataRouteContext(endpoint: string, requestUrl: URL): Promise<DataRouteContext> {
  const db = await createDbConnection(asRuntimeEnv());
  const active = await loadActiveRunSafely(db, endpoint);
  return {
    requestUrl,
    endpoint,
    db,
    active,
  };
}

async function handleCapeEndpoint(context: APIContext, requestUrl: URL): Promise<Response> {
  const { uuidHex } = readEndpointUuidParams(requestUrl, 'uuid', 'cape');
  if (!uuidHex) return jsonError(400, 'invalid uuid');

  const cached = await fetchMojangProfileCached(context, uuidHex, {
    allowFallback: true,
    acceptFallbackProfile: acceptCapeFallbackProfile,
    cacheKeyPrefix: PROFILE_SESSION_CACHE_KEY_PREFIX,
    positiveMaxAgeSeconds: resolveCapeProfileMaxAgeSeconds,
  });
  if (!cached.ok) return mojangErrorResponse(cached);

  const uuidDash = uuidHexToDashed(uuidHex);
  const cape = cached.type === 'positive' ? extractCapeFromProfile(cached.body) : null;
  const capeUrl = cape?.url ?? null;
  const hasCape = capeUrl !== null;

  const headers = etagHeaders(
    'cape',
    `cape:${uuidHex}:${sha1Hex(cached.body)}:${capeUrl ?? 'none'}`,
    new Date(cached.mtime),
    cached.maxAgeSeconds,
  );

  return jsonResponse(
    {
      found: cached.type !== 'negative',
      uuid: uuidDash,
      cape,
      capeUrl,
      hasCape,
    },
    { headers },
  );
}

async function handleProfileEndpoint(context: APIContext, requestUrl: URL): Promise<Response> {
  const { uuidHex } = readEndpointUuidParams(requestUrl, 'uuid', 'profile');
  if (!uuidHex) return jsonError(400, 'invalid uuid');

  const cached = await fetchMojangProfileCached(context, uuidHex);
  if (!cached.ok) return mojangErrorResponse(cached);

  const headers = etagHeaders(
    'profile',
    `profile:${uuidHex}:${sha1Hex(cached.body)}`,
    new Date(cached.mtime),
    cached.maxAgeSeconds,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(cached.body, { status: 200, headers });
}

async function handleMetricsEndpoint(route: DataRouteContext): Promise<Response> {
  const defs = await loadMetricDefs(route);
  const headers = etagHeaders('metrics', `metrics:${route.active.runId}`, route.active.generatedAt);
  return jsonResponse(withGenerated({ metrics: defs }, route.active), { headers });
}

async function handleSummaryEndpoint(route: DataRouteContext): Promise<Response> {
  const requested = parseRequestedMetrics(route.requestUrl.searchParams.get('metrics') ?? '');
  if (requested.length === 0) return jsonError(400, 'metrics required');
  if (requested.length > 12) return jsonError(400, 'too many metrics');

  const defs = await loadMetricDefs(route);
  for (const metric of requested) {
    if (!Object.hasOwn(defs, metric)) return jsonError(400, 'unknown metric');
  }

  const playerRows = await queryRows<RowDataPacket>(
    route.db,
    'SELECT COUNT(*) AS c FROM v_player_profile',
  );
  const playerCount = parseInteger(playerRows[0]?.c, 0);
  const totals = Object.fromEntries(requested.map((metric) => [metric, 0])) as Record<
    string,
    number
  >;

  const placeholders = requested.map(() => '?').join(',');
  const totalRows = await queryRows<RowDataPacket>(
    route.db,
    `SELECT metric_id, SUM(value) AS total_raw
     FROM v_metric_value
     WHERE metric_id IN (${placeholders})
     GROUP BY metric_id`,
    requested,
  );

  for (const row of totalRows) {
    const metricId = asNonEmptyString(row.metric_id);
    if (!metricId || !(metricId in totals)) continue;
    const raw = parseInteger(row.total_raw, 0);
    totals[metricId] = applyDivisor(raw, defs[metricId]?.divisor ?? null);
  }

  const etag = `summary:${route.active.runId}:${requested.join(',')}`;
  const headers = etagHeaders('summary', etag, route.active.generatedAt);
  return jsonResponse(
    withGenerated(
      {
        player_count: playerCount,
        totals,
      },
      route.active,
    ),
    { headers },
  );
}

async function fetchWorldState(route: DataRouteContext): Promise<WorldStateResult | null> {
  const rows = await queryRows<RowDataPacket>(
    route.db,
    `SELECT world_name,
            world_age_ticks,
            world_age_days,
            DATE_FORMAT(imported_at, '%Y-%m-%dT%H:%i:%s') AS imported_at
     FROM v_world_state
     ORDER BY CASE WHEN world_name = 'world' THEN 0 ELSE 1 END, world_name ASC
     LIMIT 1`,
  );

  const row = rows[0];
  if (!row) return null;

  const importedAt = toUtcIsoOrNull(row.imported_at);

  return {
    name: String(row.world_name ?? ''),
    ageTicks: parseInteger(row.world_age_ticks, 0),
    ageDays: parseInteger(row.world_age_days, 0),
    importedAt,
    importedAtDate: toUtcDateOrNull(row.imported_at),
  };
}

async function handleWorldStateEndpoint(route: DataRouteContext): Promise<Response> {
  const worldState = await fetchWorldState(route);
  const etagParts = worldState
    ? [
        route.active.runId,
        worldState.name,
        worldState.ageTicks,
        worldState.ageDays,
        worldState.importedAt ?? 'no-imported-at',
      ]
    : [route.active.runId, 'empty'];
  const lastModified = route.active.generatedAt ?? worldState?.importedAtDate ?? null;
  const headers = etagHeaders('world-state', `world-state:${etagParts.join(':')}`, lastModified);

  return jsonResponse(
    withGenerated(
      {
        world: worldState
          ? {
              name: worldState.name,
              ageTicks: worldState.ageTicks,
              ageDays: worldState.ageDays,
              importedAt: worldState.importedAt,
            }
          : null,
      },
      route.active,
    ),
    { headers },
  );
}

async function handleLeaderboardsEndpoint(route: DataRouteContext): Promise<Response> {
  const limit = clampLimit(parseInteger(route.requestUrl.searchParams.get('limit'), 50));
  const limitPlus = Math.min(limit + 1, API_MAX_LIMIT + 1);

  const defs = await loadMetricDefs(route);
  if (Object.keys(defs).length === 0 || route.active.runId === 0) {
    const headers = etagHeaders(
      'leaderboards',
      `leaderboards:${route.active.runId}:${limit}`,
      route.active.generatedAt,
    );
    return jsonResponse(
      withGenerated(
        {
          __players: {},
          boards: {},
          cursors: {},
        },
        route.active,
      ),
      { headers },
    );
  }

  const rows = await queryRows<RowDataPacket>(
    route.db,
    `SELECT metric_id, LOWER(HEX(uuid)) AS uuid_hex, value, rn
     FROM (
       SELECT mv.metric_id, mv.uuid, mv.value,
              ROW_NUMBER() OVER (PARTITION BY mv.metric_id ORDER BY mv.value DESC, mv.uuid ASC) AS rn
       FROM v_metric_value mv
       JOIN metric_def md ON md.id = mv.metric_id AND md.enabled = 1
     ) t
     WHERE rn <= ?
     ORDER BY metric_id ASC, rn ASC`,
    [limitPlus],
  );

  const boards: Record<string, Array<{ uuid: string; value: number }>> = {};
  const cursors: Record<string, string | null> = {};
  const needNamesHex: string[] = [];
  const lastIncluded: Record<string, { raw: number; uuidHex: string }> = {};

  for (const row of rows) {
    const metricId = asNonEmptyString(row.metric_id);
    const uuidHex = asNonEmptyString(row.uuid_hex);
    if (!metricId || !uuidHex || !defs[metricId]) continue;

    const rn = parseInteger(row.rn, 0);
    const rawValue = parseInteger(row.value, 0);
    const uuidDash = uuidHexToDashed(uuidHex);

    if (rn <= limit) {
      boards[metricId] ??= [];
      boards[metricId].push({
        uuid: uuidDash,
        value: applyDivisor(rawValue, defs[metricId].divisor),
      });
      needNamesHex.push(uuidHex);
      if (rn === limit) {
        lastIncluded[metricId] = { raw: rawValue, uuidHex };
      }
    } else {
      cursors[metricId] = '...';
    }
  }

  for (const metricId of Object.keys(defs)) {
    if (cursors[metricId] && lastIncluded[metricId]) {
      const cursorRow = lastIncluded[metricId];
      cursors[metricId] = encodeCursor(cursorRow.raw, cursorRow.uuidHex);
    } else {
      cursors[metricId] = null;
    }
    boards[metricId] ??= [];
  }

  const players = await fetchPlayersByHex(route.db, needNamesHex);
  const headers = etagHeaders(
    'leaderboards',
    `boards:${route.active.runId}:${limit}`,
    route.active.generatedAt,
  );
  return jsonResponse(
    withGenerated(
      {
        __players: players,
        boards,
        cursors,
      },
      route.active,
    ),
    { headers },
  );
}

async function handleLeaderboardEndpoint(route: DataRouteContext): Promise<Response> {
  const metric = (route.requestUrl.searchParams.get('metric') ?? '').trim();
  if (!metric) return jsonError(400, 'metric required');

  const limit = clampLimit(parseInteger(route.requestUrl.searchParams.get('limit'), 200));
  const limitPlus = Math.min(limit + 1, API_MAX_LIMIT + 1);
  const cursorRaw = (route.requestUrl.searchParams.get('cursor') ?? '').trim();
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) return jsonError(400, 'invalid cursor');

  const defs = await loadMetricDefs(route);
  if (!Object.hasOwn(defs, metric)) return jsonError(400, 'unknown metric');

  const sqlParts = [
    `SELECT LOWER(HEX(uuid)) AS uuid_hex, value
     FROM v_metric_value
     WHERE metric_id = ?`,
  ];
  const params: unknown[] = [metric];

  if (cursor) {
    sqlParts.push('AND (value < ? OR (value = ? AND uuid > UNHEX(?)))');
    params.push(cursor.value, cursor.value, cursor.uuidHex);
  }

  sqlParts.push('ORDER BY value DESC, uuid ASC LIMIT ?');
  params.push(limitPlus);

  const rows = await queryRows<RowDataPacket>(route.db, sqlParts.join(' '), params);
  const board: Array<{ uuid: string; value: number }> = [];
  const needNamesHex: string[] = [];
  let hasMore = false;
  let lastRaw: number | null = null;
  let lastUuidHex: string | null = null;

  for (const row of rows) {
    const uuidHex = asNonEmptyString(row.uuid_hex);
    if (!uuidHex) continue;

    const rawValue = parseInteger(row.value, 0);
    if (board.length < limit) {
      board.push({
        uuid: uuidHexToDashed(uuidHex),
        value: applyDivisor(rawValue, defs[metric].divisor),
      });
      needNamesHex.push(uuidHex);
      lastRaw = rawValue;
      lastUuidHex = uuidHex;
      continue;
    }

    hasMore = true;
    break;
  }

  const nextCursor =
    hasMore && lastRaw !== null && lastUuidHex !== null ? encodeCursor(lastRaw, lastUuidHex) : null;

  const players = await fetchPlayersByHex(route.db, needNamesHex);
  const etag = `board:${route.active.runId}:${metric}:${limit}:${cursorRaw}`;
  const headers = etagHeaders('leaderboard', etag, route.active.generatedAt);

  return jsonResponse(
    withGenerated(
      {
        __players: players,
        boards: { [metric]: board },
        cursors: { [metric]: nextCursor },
      },
      route.active,
    ),
    { headers },
  );
}

async function handlePlayersEndpoint(route: DataRouteContext): Promise<Response> {
  const qRaw = (route.requestUrl.searchParams.get('q') ?? '').trim().toLowerCase();
  if (qRaw.length < 2) {
    const headers = etagHeaders(
      'players',
      `players:${route.active.runId}:${qRaw}:0`,
      route.active.generatedAt,
    );
    return jsonResponse(withGenerated({ items: [] }, route.active), { headers });
  }

  const requestedLimit = parseInteger(route.requestUrl.searchParams.get('limit'), 8);
  const limit = clampLimit(Math.min(requestedLimit, API_MAX_SEARCH));
  const escaped = escapeLikeInput(qRaw);

  const sql = `SELECT LOWER(HEX(uuid)) AS uuid_hex, name
     FROM v_player_profile
     WHERE name_lc LIKE CONCAT('%', ?, '%') ESCAPE '\\\\'
     ORDER BY
       CASE WHEN name_lc LIKE CONCAT(?, '%') ESCAPE '\\\\' THEN 0 ELSE 1 END,
       LOCATE(?, name_lc) ASC,
       name_lc ASC,
       uuid ASC
     LIMIT ?`;
  const sqlParams: unknown[] = [escaped, escaped, qRaw, limit];

  let rows: RowDataPacket[];
  try {
    rows = await queryRows<RowDataPacket>(route.db, sql, sqlParams);
  } catch (error) {
    console.warn('[stats-api] players query failed, retrying once', {
      endpoint: route.endpoint,
      ...summarizeError(error),
    });
    await closeDbConnection(route.db);
    try {
      route.db = await createDbConnection(asRuntimeEnv());
      rows = await queryRows<RowDataPacket>(route.db, sql, sqlParams);
    } catch (retryError) {
      console.error('[stats-api] players query failed after retry', {
        endpoint: route.endpoint,
        ...summarizeError(retryError),
      });
      return jsonError(503, 'player search unavailable');
    }
  }

  const items = rows
    .map((row) => {
      const uuidHex = asNonEmptyString(row.uuid_hex);
      if (!uuidHex) return null;
      return {
        uuid: uuidHexToDashed(uuidHex),
        name: String(row.name ?? ''),
      };
    })
    .filter((item): item is { uuid: string; name: string } => item !== null);

  const headers = etagHeaders(
    'players',
    `players:${route.active.runId}:${qRaw}:${limit}`,
    route.active.generatedAt,
  );
  return jsonResponse(withGenerated({ items }, route.active), { headers });
}

async function handlePlayerEndpoint(route: DataRouteContext): Promise<Response> {
  const { rawUuid, uuidHex } = readEndpointUuidParams(route.requestUrl, 'uuid', 'player');
  if (!uuidHex) return jsonError(400, 'invalid uuid');

  const rows = await queryRows<RowDataPacket>(
    route.db,
    `SELECT LOWER(HEX(p.uuid)) AS uuid_hex, p.name, ps.stats_gzip, ps.stats_sha1
     FROM v_player_profile p
     LEFT JOIN v_player_stats ps ON ps.uuid = p.uuid
     WHERE p.uuid = UNHEX(?)
     LIMIT 1`,
    [uuidHex],
  );

  const row = rows[0];
  const etagBase = `player:${route.active.runId}:${uuidHex}`;

  if (!row) {
    const headers = etagHeaders('player', `${etagBase}:nf`, route.active.generatedAt);
    return jsonResponse(
      withGenerated(
        {
          found: false,
          uuid: rawUuid,
          name: null,
          player: null,
        },
        route.active,
      ),
      { headers },
    );
  }

  const resolvedHex = asNonEmptyString(row.uuid_hex) ?? uuidHex;
  const resolvedUuid = uuidHexToDashed(resolvedHex);
  const statsSha1 = Buffer.isBuffer(row.stats_sha1) ? row.stats_sha1.toString('hex') : '';
  const headers = etagHeaders('player', `${etagBase}:${statsSha1}`, route.active.generatedAt);
  const stats = decodeStatsPayload(row.stats_gzip);

  return jsonResponse(
    withGenerated(
      {
        found: true,
        uuid: resolvedUuid,
        name: String(row.name ?? resolvedUuid),
        player: stats,
      },
      route.active,
    ),
    { headers },
  );
}

function readBanStatusQuery(requestUrl: URL): BanStatusQuery | Response {
  const raw = (
    requestUrl.searchParams.get('query') ??
    requestUrl.searchParams.get('q') ??
    ''
  ).trim();

  if (!raw) return jsonError(400, 'query required');
  if (raw.length > 64) return jsonError(400, 'query too long');

  return {
    raw,
    nameLc: raw.toLowerCase(),
    uuidHex: sanitizeUuidHex(raw),
  };
}

async function fetchBanStatusRow(
  route: DataRouteContext,
  query: BanStatusQuery,
): Promise<RowDataPacket | undefined> {
  const rows = await queryRows<RowDataPacket>(
    route.db,
    `SELECT LOWER(HEX(k.uuid)) AS uuid_hex,
            k.name,
            k.name_source,
            k.first_seen,
            k.last_seen,
            k.seen_in_stats,
            k.seen_in_usercache,
            k.seen_in_bans,
            b.name AS ban_name,
            b.reason,
            b.banned_by,
            b.banned_at,
            b.expires_at,
            b.is_permanent
     FROM v_player_known k
     LEFT JOIN v_player_ban b ON b.uuid = k.uuid
     WHERE k.name_lc = ?
        OR LOWER(b.name) = ?
        OR (? IS NOT NULL AND k.uuid = UNHEX(?))
     ORDER BY k.last_seen DESC
     LIMIT 1`,
    [query.nameLc, query.nameLc, query.uuidHex, query.uuidHex],
  );

  return rows[0];
}

function hasBanDetails(ban: BanStatusBan): boolean {
  return (
    ban.nameAtBan !== null ||
    ban.bannedAt !== null ||
    ban.expiresAt !== null ||
    ban.reason !== null ||
    ban.bannedBy !== null ||
    ban.isPermanent
  );
}

function buildBanStatusKnownPlayer(row: RowDataPacket): BanStatusKnownPlayer {
  const uuidHex = asNonEmptyString(row.uuid_hex);

  return {
    uuid: uuidHex ? uuidHexToDashed(uuidHex) : null,
    name: String(row.name ?? ''),
    nameSource: asNonEmptyString(row.name_source),
    firstSeen: toUtcIsoOrNull(row.first_seen),
    lastSeen: toUtcIsoOrNull(row.last_seen),
    seenInStats: parseBoolean(row.seen_in_stats, false),
    seenInUsercache: parseBoolean(row.seen_in_usercache, false),
    seenInBans: parseBoolean(row.seen_in_bans, false),
  };
}

function buildBanStatusBan(row: RowDataPacket): BanStatusBan {
  return {
    nameAtBan: asNonEmptyString(row.ban_name),
    reason: asNonEmptyString(row.reason),
    bannedBy: asNonEmptyString(row.banned_by),
    bannedAt: toUtcIsoOrNull(row.banned_at),
    expiresAt: toUtcIsoOrNull(row.expires_at),
    isPermanent: parseBoolean(row.is_permanent, false),
  };
}

function buildBanStatusKnownResult(row: RowDataPacket): BanStatusKnownResult {
  const player = buildBanStatusKnownPlayer(row);
  const ban = buildBanStatusBan(row);
  const status = hasBanDetails(ban) ? 'banned' : 'not_banned';

  return {
    status,
    player,
    ban: status === 'banned' ? ban : null,
  };
}

function unknownBanStatusResponse(route: DataRouteContext, query: BanStatusQuery): Response {
  const headers = etagHeaders(
    'ban-status',
    `ban-status:${route.active.runId}:${query.nameLc}:unknown`,
    route.active.generatedAt,
  );

  return jsonResponse(
    withGenerated(
      {
        query: query.raw,
        status: 'unknown_player',
        player: null,
        ban: null,
      },
      route.active,
    ),
    { headers },
  );
}

function banStatusHeaders(
  route: DataRouteContext,
  query: BanStatusQuery,
  result: BanStatusKnownResult,
): Headers {
  const etagParts = [
    route.active.runId,
    query.nameLc,
    result.player.uuid ?? 'no-uuid',
    result.player.name,
    result.player.lastSeen ?? 'no-last-seen',
    result.status,
    result.ban?.nameAtBan ?? 'no-name-at-ban',
    result.ban?.bannedAt ?? 'no-ban-at',
    result.ban?.expiresAt ?? 'no-expires-at',
    String(result.ban?.isPermanent ?? false),
    result.ban?.bannedBy ?? 'no-banned-by',
    result.ban?.reason ?? 'no-reason',
  ];

  return etagHeaders('ban-status', `ban-status:${etagParts.join(':')}`, route.active.generatedAt);
}

async function handleBanStatusEndpoint(route: DataRouteContext): Promise<Response> {
  const query = readBanStatusQuery(route.requestUrl);
  if (query instanceof Response) return query;

  const row = await fetchBanStatusRow(route, query);
  if (!row) {
    return unknownBanStatusResponse(route, query);
  }

  const result = buildBanStatusKnownResult(row);
  const headers = banStatusHeaders(route, query, result);

  return jsonResponse(
    withGenerated(
      {
        query: query.raw,
        status: result.status,
        player: result.player,
        ban: result.ban,
      },
      route.active,
    ),
    { headers },
  );
}

function normalizeApiUrl(endpoint: string, source: URL): URL | Response {
  const url = new URL(source);
  url.pathname = `/api/${endpoint}/`;
  url.search = '';
  const params = source.searchParams;

  switch (endpoint) {
    case 'player':
    case 'profile':
    case 'cape': {
      const { uuidHex } = readEndpointUuidParams(source, 'uuid', endpoint);
      if (!uuidHex) return jsonError(400, 'invalid uuid');
      url.searchParams.set('uuid', uuidHexToDashed(uuidHex));
      break;
    }
    case 'summary': {
      const metrics = parseRequestedMetrics(params.get('metrics') ?? '').sort();
      if (!metrics.length) return jsonError(400, 'metrics required');
      if (metrics.length > 12) return jsonError(400, 'too many metrics');
      if (metrics.some((metric) => metric.length > 128)) return jsonError(400, 'invalid metric');
      url.searchParams.set('metrics', metrics.join(','));
      break;
    }
    case 'leaderboard': {
      const metric = (params.get('metric') ?? '').trim();
      if (!metric) return jsonError(400, 'metric required');
      if (metric.length > 128) return jsonError(400, 'invalid metric');
      url.searchParams.set('metric', metric);
      const cursor = (params.get('cursor') ?? '').trim();
      if (cursor) {
        if (cursor.length > 256 || !decodeCursor(cursor)) return jsonError(400, 'invalid cursor');
        url.searchParams.set('cursor', cursor);
      }
      url.searchParams.set('limit', String(clampLimit(parseInteger(params.get('limit'), 200))));
      break;
    }
    case 'leaderboards':
      url.searchParams.set('limit', String(clampLimit(parseInteger(params.get('limit'), 50))));
      break;
    case 'players': {
      const q = (params.get('q') ?? '').trim().toLowerCase();
      if (q.length > 64) return jsonError(400, 'query too long');
      if (q.length < 2) {
        return jsonResponse(withGenerated({ items: [] }, emptyActiveRun()), {
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      url.searchParams.set('q', q);
      url.searchParams.set(
        'limit',
        String(clampLimit(Math.min(parseInteger(params.get('limit'), 8), API_MAX_SEARCH))),
      );
      break;
    }
    case 'ban-status': {
      const query = readBanStatusQuery(source);
      if (query instanceof Response) return query;
      url.searchParams.set('query', query.raw);
      break;
    }
  }
  url.searchParams.sort();
  return url;
}

async function routeRequest(
  context: APIContext,
  endpoint: string,
  requestUrl: URL,
): Promise<Response> {
  switch (endpoint) {
    case 'cape':
      return handleCapeEndpoint(context, requestUrl);
    case 'profile':
      return handleProfileEndpoint(context, requestUrl);
    default:
      break;
  }

  const route = await buildDataRouteContext(endpoint, requestUrl);
  try {
    switch (endpoint) {
      case 'metrics':
        return await handleMetricsEndpoint(route);
      case 'summary':
        return await handleSummaryEndpoint(route);
      case 'leaderboards':
        return await handleLeaderboardsEndpoint(route);
      case 'world-state':
        return await handleWorldStateEndpoint(route);
      case 'leaderboard':
        return await handleLeaderboardEndpoint(route);
      case 'players':
        return await handlePlayersEndpoint(route);
      case 'player':
        return await handlePlayerEndpoint(route);
      case 'ban-status':
        return await handleBanStatusEndpoint(route);
      default:
        return jsonError(404, 'Unbekannter API-Endpunkt.');
    }
  } finally {
    await closeDbConnection(route.db);
  }
}

function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: 'GET, HEAD, OPTIONS',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function methodNotAllowedResponse(): Response {
  return new Response(null, {
    status: 405,
    headers: {
      Allow: 'GET, HEAD, OPTIONS',
      'Cache-Control': 'no-store',
    },
  });
}

function validateMethod(method: string): Response | null {
  if (method === 'OPTIONS') return optionsResponse();
  if (method !== 'GET' && method !== 'HEAD') return methodNotAllowedResponse();
  return null;
}

function resolveEndpointFromContext(context: APIContext): string | null {
  const endpointPath = (context.params.path ?? '').replace(/^\/+|\/+$/g, '');
  if (!endpointPath || endpointPath.includes('/')) return null;

  const endpoint = endpointPath.toLowerCase();
  return ALLOWED_ENDPOINTS.has(endpoint) ? endpoint : null;
}

async function readCachedApiResponse(
  endpoint: string,
  edgeCache: Cache | null,
  cacheKey: Request,
): Promise<{ response: Response; staleForSeconds: number } | null> {
  if (!edgeCache) return null;

  try {
    const cached = await edgeCache.match(cacheKey);
    if (!cached) return null;

    const headers = new Headers(cached.headers);
    const freshUntil = Number(headers.get('X-Stats-Cache-Fresh-Until'));
    const storedAt = Number(headers.get('X-Stats-Cache-Stored-At'));
    const staleForSeconds = freshUntil ? Math.max(0, (Date.now() - freshUntil) / 1000) : 0;
    const profile = resolveCacheProfile(endpoint);
    if (
      staleForSeconds > Math.max(profile.staleIfErrorSeconds, profile.staleWhileRevalidateSeconds)
    )
      return null;
    const cacheControl = headers.get('X-Stats-Cache-Control');
    if (cacheControl) headers.set('Cache-Control', cacheControl);
    if (storedAt)
      headers.set('Age', String(Math.max(0, Math.floor((Date.now() - storedAt) / 1000))));
    headers.delete('X-Stats-Cache-Fresh-Until');
    headers.delete('X-Stats-Cache-Stored-At');
    headers.delete('X-Stats-Cache-Control');
    return {
      response: new Response(cached.body, { status: cached.status, headers }),
      staleForSeconds,
    };
  } catch (error) {
    console.warn('[stats-api] edge cache read failed', {
      endpoint,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function executeRouteRequest(
  context: APIContext,
  endpoint: string,
  requestUrl: URL,
): Promise<Response> {
  try {
    return await routeRequest(context, endpoint, requestUrl);
  } catch (error) {
    const details = summarizeError(error);
    console.error('[stats-api] request failed', {
      endpoint,
      ...details,
    });

    // Unerwartete Fehler werden nicht ins JSON geleakt.
    if (error instanceof Error && error.message === 'DB not configured') {
      return jsonError(500, 'DB not configured');
    }
    return jsonError(500, 'server error');
  }
}

function isCacheableApiResponse(response: Response): boolean {
  return (
    response.status >= 200 &&
    response.status < 500 &&
    response.headers.get('Cache-Control') !== 'no-store'
  );
}

async function writeResponseToEdgeCache(
  context: APIContext,
  endpoint: string,
  edgeCache: Cache | null,
  cacheKey: Request,
  response: Response,
): Promise<void> {
  if (!edgeCache) return;

  try {
    const profile = resolveCacheProfile(endpoint);
    const headers = new Headers(response.headers);
    const cacheControl = headers.get('Cache-Control') ?? buildCacheControl(profile);
    const freshSeconds = Number(
      cacheControl.match(/(?:^|[ ,])max-age=(\d+)/)?.[1] ?? profile.maxAgeSeconds,
    );
    // Die Cache API setzt SWR/SIE nicht um. Frische und Aufbewahrung sind deshalb getrennt.
    headers.set('X-Stats-Cache-Control', cacheControl);
    headers.set('X-Stats-Cache-Stored-At', String(Date.now()));
    headers.set('X-Stats-Cache-Fresh-Until', String(Date.now() + freshSeconds * 1000));
    headers.set(
      'Cache-Control',
      `public, max-age=${freshSeconds + Math.max(profile.staleWhileRevalidateSeconds, profile.staleIfErrorSeconds)}`,
    );
    const cachedResponse = new Response(response.clone().body, {
      status: response.status,
      headers,
    });
    const putPromise = edgeCache.put(cacheKey, cachedResponse).catch((error: unknown) => {
      console.warn('[stats-api] edge cache write failed', { endpoint, message: String(error) });
    });
    const executionContext = asExecutionContext(context);
    if (executionContext?.waitUntil) executionContext.waitUntil(putPromise);
    else await putPromise;
  } catch (error) {
    console.warn('[stats-api] edge cache write failed', {
      endpoint,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function finalizeApiResponse(
  method: string,
  request: Request,
  responseForClient: Response,
): Response {
  const conditional = maybeNotModified(request, responseForClient);
  const finalResponse = conditional ?? responseForClient;
  return method === 'HEAD' ? withoutBody(finalResponse) : finalResponse;
}

export async function handleStatsApiProxy(context: APIContext): Promise<Response> {
  const method = context.request.method.toUpperCase();
  const invalidMethodResponse = validateMethod(method);
  if (invalidMethodResponse) return invalidMethodResponse;

  const endpoint = resolveEndpointFromContext(context);
  if (!endpoint) return jsonError(404, 'Unbekannter API-Endpunkt.');

  const rateLimitResponse = maybeRateLimitBanStatus(context, endpoint);
  if (rateLimitResponse) {
    return finalizeApiResponse(
      method,
      context.request,
      withApiHeaders(rateLimitResponse, { cacheStatus: 'BYPASS' }),
    );
  }

  const requestUrl = normalizeApiUrl(endpoint, new URL(context.request.url));
  if (requestUrl instanceof Response) {
    return finalizeApiResponse(
      method,
      context.request,
      withApiHeaders(requestUrl, { cacheStatus: 'BYPASS' }),
    );
  }
  const cacheUrl = new URL(requestUrl);
  cacheUrl.pathname = `/__cache/stats-api/v2/${endpoint}`;
  const cacheKey = new Request(cacheUrl, { method: 'GET' });
  const edgeCache = getEdgeCache();
  const cachedResponse = await readCachedApiResponse(endpoint, edgeCache, cacheKey);
  if (cachedResponse?.staleForSeconds === 0) {
    return finalizeApiResponse(
      method,
      context.request,
      withApiHeaders(cachedResponse.response, { cacheStatus: 'HIT' }),
    );
  }

  const refresh = async (): Promise<Response> => {
    const response = await executeRouteRequest(context, endpoint, requestUrl);
    const cacheable = isCacheableApiResponse(response);
    const responseForClient = withApiHeaders(response, {
      cacheStatus: cacheable ? 'MISS' : 'BYPASS',
    });
    if (cacheable)
      await writeResponseToEdgeCache(context, endpoint, edgeCache, cacheKey, responseForClient);
    return responseForClient;
  };

  const staleResponse = (): Response => {
    const response = withApiHeaders(cachedResponse!.response, { cacheStatus: 'STALE' });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Stats-Api-Stale', '1');
    return method === 'HEAD' ? withoutBody(response) : response;
  };
  const profile = resolveCacheProfile(endpoint);
  const executionContext = asExecutionContext(context);
  if (
    cachedResponse &&
    cachedResponse.staleForSeconds <= profile.staleWhileRevalidateSeconds &&
    executionContext?.waitUntil
  ) {
    executionContext.waitUntil(
      refresh()
        .then(() => undefined)
        .catch((error: unknown) => {
          console.warn('[stats-api] background refresh failed', {
            endpoint,
            message: String(error),
          });
        }),
    );
    return staleResponse();
  }

  const responseForClient = await refresh();
  if (
    responseForClient.status >= 500 &&
    cachedResponse &&
    cachedResponse.staleForSeconds <= profile.staleIfErrorSeconds
  )
    return staleResponse();
  return finalizeApiResponse(method, context.request, responseForClient);
}
