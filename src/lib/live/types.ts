export type LiveDataStatus = 'loading' | 'ok' | 'empty' | 'error' | 'stale';

export type LiveDataErrorKind =
  'network' | 'timeout' | 'rate_limit' | 'invalid' | 'offline' | 'unknown';

export type LiveIndicatorState = 'ok' | 'loading' | 'error';

export interface LiveDataError {
  kind: LiveDataErrorKind;
  message?: string;
  retryAfterMs?: number;
}

export interface LiveDataState<T> {
  status: LiveDataStatus;
  data?: T;
  error?: LiveDataError;
  updatedAt?: number;
  fetchedAt?: number;
}

export interface LiveDataThresholds {
  staleAfterMs: number;
  maxCacheAgeMs: number;
}

export type LiveWidgetThresholdKey = 'discord-online' | 'discord-members' | 'stats-kpi';

export const LIVE_WIDGET_THRESHOLDS: Record<LiveWidgetThresholdKey, LiveDataThresholds> = {
  'discord-online': {
    staleAfterMs: 60_000,
    maxCacheAgeMs: 30 * 60_000,
  },
  'discord-members': {
    staleAfterMs: 5 * 60_000,
    maxCacheAgeMs: 60 * 60_000,
  },
  'stats-kpi': {
    staleAfterMs: 5 * 60_000,
    maxCacheAgeMs: 60 * 60_000,
  },
};

export const resolveLiveDataStatus = (opts: {
  loading: boolean;
  loaded: boolean;
  hasData: boolean;
  hasSnapshot: boolean;
  error?: LiveDataError | null;
}): LiveDataStatus => {
  const { loading, loaded, hasData, hasSnapshot, error } = opts;
  const hasError = Boolean(error);

  if (loading && !hasData && !hasSnapshot) return 'loading';
  if (hasError && !hasData && !hasSnapshot) return 'error';
  if ((loading || hasError) && hasData) return 'stale';
  if (!hasData) return loaded ? 'empty' : 'loading';

  return 'ok';
};

export const isLiveOfflineError = (error?: LiveDataError | null): boolean =>
  error?.kind === 'offline';

export const resolveLiveIndicatorState = <T>(
  state: Pick<LiveDataState<T>, 'status' | 'error'>,
): LiveIndicatorState => {
  if (isLiveOfflineError(state.error)) return 'error';
  if (state.status === 'error') return 'error';
  if (state.status === 'loading' || state.status === 'stale') return 'loading';
  return 'ok';
};
