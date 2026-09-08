export const MINECRAFT_STATUS_FRESH_MS = 5 * 60_000;
export const MINECRAFT_STATUS_MAX_AGE_MS = 30 * 60_000;
export const MINECRAFT_STATUS_RETRY_MS = 30_000;

export interface MinecraftPlayer {
  name: string;
  uuid?: string;
}

export interface MinecraftStatusSnapshot {
  online: boolean;
  players: { online: number; list: MinecraftPlayer[] | null };
  updatedAt: number;
  expiresAt: number;
}

export interface MinecraftStatusResponse {
  data: MinecraftStatusSnapshot;
  stale: boolean;
  retryAfterMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isPlayer = (value: unknown): value is MinecraftPlayer =>
  isRecord(value) &&
  typeof value.name === 'string' &&
  /^[a-zA-Z0-9_]{1,16}$/.test(value.name) &&
  (value.uuid === undefined ||
    (typeof value.uuid === 'string' &&
      /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value.uuid)));

export const isMinecraftStatusSnapshot = (value: unknown): value is MinecraftStatusSnapshot =>
  isRecord(value) &&
  typeof value.online === 'boolean' &&
  isRecord(value.players) &&
  isCount(value.players.online) &&
  (value.online || value.players.online === 0) &&
  (value.players.list === null ||
    (Array.isArray(value.players.list) && value.players.list.every(isPlayer))) &&
  isCount(value.updatedAt) &&
  isCount(value.expiresAt) &&
  value.expiresAt >= value.updatedAt &&
  value.expiresAt <= value.updatedAt + MINECRAFT_STATUS_FRESH_MS;

export const isMinecraftStatusResponse = (value: unknown): value is MinecraftStatusResponse =>
  isRecord(value) &&
  isMinecraftStatusSnapshot(value.data) &&
  typeof value.stale === 'boolean' &&
  (value.retryAfterMs === undefined || isCount(value.retryAfterMs));

export const isUsableMinecraftStatus = (data: MinecraftStatusSnapshot, now = Date.now()): boolean =>
  data.updatedAt <= now && now - data.updatedAt < MINECRAFT_STATUS_MAX_AGE_MS;

export function parseMinecraftStatus(
  value: unknown,
  now = Date.now(),
): MinecraftStatusSnapshot | null {
  if (!isRecord(value) || typeof value.online !== 'boolean') return null;
  if (value.online && (!isRecord(value.players) || !isCount(value.players.online))) return null;

  const debug = isRecord(value.debug) ? value.debug : {};
  const updatedAt = isCount(debug.cachetime) ? Math.min(now, debug.cachetime * 1_000) : now;
  const expiresAt = isCount(debug.cacheexpire)
    ? Math.max(
        updatedAt,
        Math.min(debug.cacheexpire * 1_000, updatedAt + MINECRAFT_STATUS_FRESH_MS),
      )
    : updatedAt + MINECRAFT_STATUS_FRESH_MS;
  const players = isRecord(value.players) ? value.players : {};
  const list = Array.isArray(players.list)
    ? players.list.filter(isPlayer).map(({ name, uuid }) => ({ name, ...(uuid ? { uuid } : {}) }))
    : null;

  const data: MinecraftStatusSnapshot = {
    online: value.online,
    players: {
      online: value.online && isCount(players.online) ? players.online : 0,
      list: value.online ? list : [],
    },
    updatedAt,
    expiresAt,
  };
  return isUsableMinecraftStatus(data, now) ? data : null;
}
