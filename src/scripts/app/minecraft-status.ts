import { fetchLiveJson } from '../../lib/live/fetchJson';
import type { LiveDataError, LiveDataState } from '../../lib/live/types';
import {
  getMinecraftStatusRetryMs,
  isMinecraftStatusResponse,
  isMinecraftStatusSnapshot,
  isUsableMinecraftStatus,
  MINECRAFT_STATUS_MAX_AGE_MS,
  type MinecraftStatusSnapshot,
} from '../../lib/minecraft/status';

type StatusState = LiveDataState<MinecraftStatusSnapshot>;
const STORAGE_KEY = 'mg:minecraft-status:v1';

export function createMinecraftStatusController(options: {
  onState: (state: StatusState) => void;
  onBusy: (busy: boolean) => void;
}): { refresh: () => void; dispose: () => void } {
  let snapshot: MinecraftStatusSnapshot | undefined;
  let error: LiveDataError | undefined;
  let fetchedAt: number | undefined;
  let nextFetchAt = 0;
  let failures = 0;
  let timer: number | undefined;
  let active: AbortController | undefined;
  let disposed = false;

  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (isMinecraftStatusSnapshot(stored) && isUsableMinecraftStatus(stored)) {
      snapshot = stored;
      nextFetchAt = stored.expiresAt;
    }
  } catch {
    // Die Anzeige funktioniert auch bei gesperrtem localStorage.
  }

  const emit = (): void => {
    if (disposed) return;
    if (snapshot && !isUsableMinecraftStatus(snapshot)) snapshot = undefined;
    const stale = Boolean(error) || Boolean(snapshot && Date.now() >= snapshot.expiresAt);
    options.onState({
      status: snapshot
        ? stale
          ? 'stale'
          : snapshot.players.online > 0
            ? 'ok'
            : 'empty'
        : active
          ? 'loading'
          : 'error',
      data: snapshot,
      error,
      updatedAt: snapshot?.updatedAt,
      fetchedAt,
    });
  };

  const clearTimer = (): void => {
    window.clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (): void => {
    clearTimer();
    if (disposed || document.visibilityState !== 'visible') return;
    const nextChangeAt = snapshot
      ? Math.min(nextFetchAt, snapshot.updatedAt + MINECRAFT_STATUS_MAX_AGE_MS)
      : nextFetchAt;
    timer = window.setTimeout(
      () => {
        void refresh();
      },
      Math.max(1, Math.min(nextChangeAt - Date.now(), 24 * 60 * 60_000)),
    );
  };

  const refresh = async (): Promise<void> => {
    if (disposed || active || document.visibilityState !== 'visible') return;
    if (Date.now() < nextFetchAt) {
      emit();
      schedule();
      return;
    }
    clearTimer();
    active = new AbortController();
    options.onBusy(true);
    emit();

    try {
      const result = await fetchLiveJson('/api/minecraft-status/', {
        signal: active.signal,
        timeoutMs: 10_000,
        cache: 'no-store',
        validate: isMinecraftStatusResponse,
      });
      if (disposed) return;
      const now = Date.now();
      fetchedAt = now;
      if (result.ok && isUsableMinecraftStatus(result.data.data, now)) {
        snapshot = result.data.data;
        const stale = result.data.stale || snapshot.expiresAt <= now;
        error = stale ? { kind: 'network' } : undefined;
        failures = stale ? Math.min(3, failures + 1) : 0;
        nextFetchAt = stale
          ? now + Math.max(getMinecraftStatusRetryMs(failures), result.data.retryAfterMs ?? 0)
          : snapshot.expiresAt;
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
        } catch {
          // Der Edge-Cache bleibt auch ohne Browser-Speicher verfuegbar.
        }
      } else {
        error = result.ok ? { kind: 'invalid' } : result.error;
        failures = Math.min(3, failures + 1);
        nextFetchAt = now + Math.max(getMinecraftStatusRetryMs(failures), error.retryAfterMs ?? 0);
      }
    } finally {
      active = undefined;
      if (!disposed) {
        emit();
        options.onBusy(false);
        schedule();
      }
    }
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      void refresh();
    } else {
      clearTimer();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  if (snapshot) emit();
  else options.onState({ status: 'loading' });

  return {
    refresh: () => {
      void refresh();
    },
    dispose: () => {
      disposed = true;
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      active?.abort();
    },
  };
}
