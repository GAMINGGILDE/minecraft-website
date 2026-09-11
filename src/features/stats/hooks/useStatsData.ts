import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getLeaderboard, getMetrics, getSummary, getWorldState } from '../api';
import { KPI_METRICS } from '../constants';
import { filterMetricIds, groupMetricIds, pickDefaultRankMetricId } from '../metric-utils';
import { normalizeUmlauts } from '../normalizeUmlauts';
import type { MetricDef, SummaryResponse, WorldState, WorldStateResponse } from '../types';
import type { LeaderboardState, TabKey } from '../types-ui';
import { usePlayerAutocomplete } from '../usePlayerAutocomplete';
import type { GroupedMetrics } from '../components/MetricPicker';
import { getLiveResource } from '../../../lib/live/cache';
import {
  LIVE_WIDGET_THRESHOLDS,
  type LiveDataErrorKind,
  type LiveDataState,
} from '../../../lib/live/types';
import { resolveLastUpdatedTimestamp } from '../../../lib/live/lastUpdated';
import { LIVE_COPY_DE, getLiveMessage } from '../../../lib/live/copy.de';

const API_ERROR_MESSAGE = LIVE_COPY_DE.error_generic;
const API_RATE_LIMIT_MESSAGE = LIVE_COPY_DE.rate_limit;
const RATE_LIMIT_FALLBACK_MS = 60_000;

function resolveHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;

  const withStatus = error as { status?: unknown; message?: unknown };
  if (typeof withStatus.status === 'number' && Number.isFinite(withStatus.status)) {
    return withStatus.status;
  }

  if (typeof withStatus.message === 'string') {
    const match = withStatus.message.match(/\bHTTP\s+(\d{3})\b/i);
    if (match) {
      const status = Number(match[1]);
      return Number.isFinite(status) ? status : null;
    }
  }

  return null;
}

function resolveRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;

  const withRetryAfter = error as { retryAfterMs?: unknown };
  if (
    typeof withRetryAfter.retryAfterMs === 'number' &&
    Number.isFinite(withRetryAfter.retryAfterMs) &&
    withRetryAfter.retryAfterMs >= 0
  ) {
    return Math.floor(withRetryAfter.retryAfterMs);
  }

  return null;
}

function resolveLeaderboardErrorKind(error: unknown): LiveDataErrorKind {
  const status = resolveHttpStatus(error);
  if (status === 429) return 'rate_limit';
  if (typeof status === 'number' && status >= 400 && status < 500) return 'invalid';
  if (typeof status === 'number' && status >= 500) return 'network';
  if (['AbortError', 'TimeoutError'].includes((error as Error | undefined)?.name ?? ''))
    return 'timeout';
  return 'unknown';
}

async function resolveStatsLiveData<T>(
  request: () => Promise<T>,
  onRateLimit: (retryAfterMs: number | null) => void,
): Promise<LiveDataState<T>> {
  try {
    const data = await request();
    const fetchedAt = Date.now();
    return {
      status: 'ok',
      data,
      updatedAt: fetchedAt,
      fetchedAt,
    };
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      return {
        status: 'error',
        fetchedAt: Date.now(),
        error: {
          kind: 'network',
          message: 'Anfrage wurde abgebrochen.',
        },
      };
    }

    const errorKind = resolveLeaderboardErrorKind(error);
    const retryAfterMs = resolveRetryAfterMs(error);
    if (errorKind === 'rate_limit') {
      onRateLimit(retryAfterMs);
    }

    return {
      status: 'error',
      fetchedAt: Date.now(),
      error: {
        kind: errorKind,
        message:
          getLiveMessage({ status: 'error', errorKind }) ??
          (errorKind === 'rate_limit' ? API_RATE_LIMIT_MESSAGE : API_ERROR_MESSAGE),
        retryAfterMs: retryAfterMs ?? undefined,
      },
    };
  }
}
const SUMMARY_CACHE_KEY = 'stats-kpi-summary';
const WORLD_STATE_CACHE_KEY = 'stats-world-state';
const SUMMARY_MIN_REVALIDATE_INTERVAL_MS = 15_000;

function makeEmptyLeaderboardState(): LeaderboardState {
  return {
    loaded: false,
    loading: false,
    liveStatus: 'ok',
    liveErrorKind: null,
    lastAttemptedPageSize: null,
    pages: [],
    currentPage: 0,
    nextCursor: null,
    hasMore: false,
    pageSize: null,
  };
}

type LoadLeaderboardOptions = {
  openLoadedPage: boolean;
  forceRefresh: boolean;
  silent: boolean;
};

function normalizeLoadLeaderboardOptions(opts?: {
  openLoadedPage?: boolean;
  forceRefresh?: boolean;
  silent?: boolean;
}): LoadLeaderboardOptions {
  return {
    openLoadedPage: opts?.openLoadedPage ?? false,
    forceRefresh: opts?.forceRefresh ?? false,
    silent: opts?.silent ?? false,
  };
}

function resolveCurrentLeaderboardState({
  stateKey,
  kingState,
  boardStates,
}: {
  stateKey: string;
  kingState: LeaderboardState;
  boardStates: Record<string, LeaderboardState>;
}): LeaderboardState {
  if (stateKey === 'king') return kingState;
  return boardStates[stateKey] || makeEmptyLeaderboardState();
}

function resolveNextCurrentPage({
  previousState,
  pagesLength,
  usedCursor,
  openLoadedPage,
}: {
  previousState: LeaderboardState;
  pagesLength: number;
  usedCursor: boolean;
  openLoadedPage: boolean;
}): number {
  if (!usedCursor) return 0;
  if (openLoadedPage) return pagesLength - 1;
  return previousState.currentPage;
}

export function useStatsData({
  activeTab,
  pageSize,
  metricFilter,
  initialActiveMetricId,
  initialSearchQuery,
}: {
  activeTab: TabKey;
  pageSize: number;
  metricFilter: string;
  initialActiveMetricId?: string | null;
  initialSearchQuery?: string;
}) {
  const [generatedIso, setGeneratedIso] = useState<string | null>(null);
  const [playerCount, setPlayerCount] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<Record<string, MetricDef> | null>(null);
  const [totals, setTotals] = useState<Record<string, number> | null>(null);
  const [worldState, setWorldState] = useState<WorldState | null>(null);
  const [worldStateLoaded, setWorldStateLoaded] = useState(false);
  const [worldStateLoading, setWorldStateLoading] = useState(false);
  const [worldStateError, setWorldStateError] = useState<string | null>(null);
  const [summaryLoaded, setSummaryLoaded] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryLastUpdatedAt, setSummaryLastUpdatedAt] = useState<number | null>(null);
  const [summaryReloadTrigger, setSummaryReloadTrigger] = useState(0);
  const [worldStateReloadTrigger, setWorldStateReloadTrigger] = useState(0);
  const [apiError, setApiError] = useState<string | null>(null);
  const [apiErrorKind, setApiErrorKind] = useState<LiveDataErrorKind | null>(null);
  const [nextAllowedFetchAt, setNextAllowedFetchAt] = useState<number | null>(null);
  const [rateLimitNowMs, setRateLimitNowMs] = useState<number>(() => Date.now());
  const summaryLastUpdatedAtRef = useRef<number | null>(null);
  const summaryLoadingRef = useRef(false);
  const summaryVisibilityRevalidateAtRef = useRef(0);

  const [king, setKing] = useState<LeaderboardState>(makeEmptyLeaderboardState);
  const [boards, setBoards] = useState<Record<string, LeaderboardState>>({});
  const [activeMetricId, setActiveMetricId] = useState<string | null>(
    initialActiveMetricId || null,
  );

  const playerNamesRef = useRef<Record<string, string>>({});
  const metricsRef = useRef<Record<string, MetricDef> | null>(null);
  const metricsFetchPromiseRef = useRef<Promise<Record<string, MetricDef> | null> | null>(null);
  const kingRef = useRef(king);
  const boardsRef = useRef(boards);
  const pageSizeRef = useRef(pageSize);

  useEffect(() => {
    kingRef.current = king;
  }, [king]);

  useEffect(() => {
    boardsRef.current = boards;
  }, [boards]);

  useEffect(() => {
    metricsRef.current = metrics;
  }, [metrics]);

  useEffect(() => {
    pageSizeRef.current = pageSize;
  }, [pageSize]);

  useEffect(() => {
    summaryLastUpdatedAtRef.current = summaryLastUpdatedAt;
  }, [summaryLastUpdatedAt]);

  useEffect(() => {
    summaryLoadingRef.current = summaryLoading;
  }, [summaryLoading]);

  const setApiErrorWithKind = useCallback(
    (message: string | null, kind: LiveDataErrorKind | null) => {
      setApiError(message);
      setApiErrorKind(kind);
    },
    [],
  );

  const registerRateLimit = useCallback(
    (retryAfterMs: number | null | undefined) => {
      const normalizedRetryAfterMs =
        typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
          ? Math.floor(retryAfterMs)
          : RATE_LIMIT_FALLBACK_MS;
      const candidateNextAllowedFetchAt = Date.now() + normalizedRetryAfterMs;

      setNextAllowedFetchAt((prev) => {
        if (typeof prev === 'number' && prev > candidateNextAllowedFetchAt) return prev;
        return candidateNextAllowedFetchAt;
      });
      setApiErrorWithKind(API_RATE_LIMIT_MESSAGE, 'rate_limit');
    },
    [setApiErrorWithKind],
  );

  useEffect(() => {
    if (typeof nextAllowedFetchAt !== 'number') return;

    setRateLimitNowMs(Date.now());
    if (Date.now() >= nextAllowedFetchAt) return;

    const intervalId = window.setInterval(() => {
      setRateLimitNowMs(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [nextAllowedFetchAt]);

  const rateLimitRetryInSeconds = useMemo(() => {
    if (typeof nextAllowedFetchAt !== 'number') return 0;
    const remainingMs = nextAllowedFetchAt - rateLimitNowMs;
    if (remainingMs <= 0) return 0;
    return Math.ceil(remainingMs / 1_000);
  }, [nextAllowedFetchAt, rateLimitNowMs]);

  useEffect(() => {
    if (typeof nextAllowedFetchAt !== 'number') return;
    if (rateLimitRetryInSeconds > 0) return;
    setNextAllowedFetchAt(null);
  }, [nextAllowedFetchAt, rateLimitRetryInSeconds]);

  const isRateLimitBlocked = rateLimitRetryInSeconds > 0;

  const apiErrorMessage = useMemo(() => {
    if (!apiError) return null;
    if (apiErrorKind === 'rate_limit' && rateLimitRetryInSeconds > 0) {
      return `${apiError} ${LIVE_COPY_DE.retry_in(rateLimitRetryInSeconds)}`;
    }
    return apiError;
  }, [apiError, apiErrorKind, rateLimitRetryInSeconds]);
  const handleAutocompleteError = useCallback(
    (message: string | null) => {
      setApiErrorWithKind(message, message ? 'unknown' : null);
    },
    [setApiErrorWithKind],
  );

  const mainSearch = usePlayerAutocomplete({
    onGeneratedIso: setGeneratedIso,
    onError: handleAutocompleteError,
    initialValue: initialSearchQuery,
  });

  const mergePlayers = useCallback((players?: Record<string, string>) => {
    if (!players) return;
    for (const [uuid, name] of Object.entries(players)) {
      if (!playerNamesRef.current[uuid] && typeof name === 'string') {
        playerNamesRef.current[uuid] = name;
      }
    }
  }, []);

  const getPlayerName = useCallback((uuid: string) => playerNamesRef.current[uuid] || uuid, []);

  const setBoardState = useCallback(
    (stateKey: string, updater: (state: LeaderboardState) => LeaderboardState) => {
      if (stateKey === 'king') {
        setKing((prev) => updater(prev));
        return;
      }

      setBoards((prev) => {
        const current = prev[stateKey] || makeEmptyLeaderboardState();
        return {
          ...prev,
          [stateKey]: updater(current),
        };
      });
    },
    [],
  );

  const ensureMetricsLoaded = useCallback(
    ({
      signal,
      silent = false,
    }: {
      signal?: AbortSignal;
      silent?: boolean;
    } = {}): Promise<Record<string, MetricDef> | null> => {
      if (metricsRef.current) return Promise.resolve(metricsRef.current);
      if (metricsFetchPromiseRef.current) return metricsFetchPromiseRef.current;

      const request = (async () => {
        try {
          const data = await getMetrics(signal);
          if (typeof data.__generated === 'string') setGeneratedIso(data.__generated);

          const rawMetrics = (data.metrics || {}) as Record<string, MetricDef>;
          const normalized = Object.fromEntries(
            Object.entries(rawMetrics).map(([id, def]) => [
              id,
              {
                ...def,
                label: normalizeUmlauts(def?.label || id),
                category: normalizeUmlauts(def?.category || ''),
              },
            ]),
          ) as Record<string, MetricDef>;

          setMetrics(normalized);
          if (!silent) {
            setApiErrorWithKind(null, null);
          }

          return normalized;
        } catch (error) {
          if ((error as Error)?.name === 'AbortError') return null;

          if (!silent) {
            console.warn('Metrics Fehler', error);
            const errorKind = resolveLeaderboardErrorKind(error);
            setApiErrorWithKind(
              getLiveMessage({ status: 'error', errorKind }) ?? API_ERROR_MESSAGE,
              errorKind,
            );
          }
          return null;
        } finally {
          metricsFetchPromiseRef.current = null;
        }
      })();

      metricsFetchPromiseRef.current = request;
      return request;
    },
    [setApiErrorWithKind],
  );

  const handleLeaderboardError = useCallback(
    ({ error, stateKey, silent }: { error: unknown; stateKey: string; silent: boolean }) => {
      if (!silent) {
        console.warn('Leaderboard Fehler', error);
      }

      const liveErrorKind = resolveLeaderboardErrorKind(error);
      if (!silent && liveErrorKind === 'rate_limit') {
        registerRateLimit(resolveRetryAfterMs(error));
      } else if (!silent) {
        setApiErrorWithKind(
          getLiveMessage({ status: 'error', errorKind: liveErrorKind }) ?? API_ERROR_MESSAGE,
          liveErrorKind,
        );
      }

      if (silent) {
        setBoardState(stateKey, (state) => ({
          ...state,
          loading: false,
        }));
        return;
      }

      setBoardState(stateKey, (state) => ({
        ...state,
        loading: false,
        liveStatus: state.loaded ? 'stale' : 'error',
        liveErrorKind,
      }));
    },
    [registerRateLimit, setApiErrorWithKind, setBoardState],
  );

  const loadLeaderboard = useCallback(
    async (
      metricId: string,
      stateKey: string,
      opts?: { openLoadedPage?: boolean; forceRefresh?: boolean; silent?: boolean },
    ) => {
      if (isRateLimitBlocked) return;

      const { openLoadedPage, forceRefresh, silent } = normalizeLoadLeaderboardOptions(opts);
      if (!silent) {
        setApiErrorWithKind(null, null);
      }
      const currentState = resolveCurrentLeaderboardState({
        stateKey,
        kingState: kingRef.current,
        boardStates: boardsRef.current,
      });

      if (currentState.loading) return;

      const requestedPageSize = pageSizeRef.current;
      setBoardState(stateKey, (state) => ({
        ...state,
        loading: true,
        lastAttemptedPageSize: silent ? state.lastAttemptedPageSize : requestedPageSize,
      }));

      try {
        const isSamePageSize = currentState.pageSize === requestedPageSize;
        const cursor =
          !forceRefresh && currentState.loaded && isSamePageSize ? currentState.nextCursor : null;
        const data = await getLeaderboard(metricId, requestedPageSize, cursor);

        if (typeof data.__generated === 'string') {
          setGeneratedIso(data.__generated);
        }

        mergePlayers(data.__players);

        const list = data.boards?.[metricId] || [];
        const nextCursor = data.cursors?.[metricId] || null;

        setBoardState(stateKey, (state) => {
          const pages = cursor ? [...state.pages, list] : [list];
          const nextCurrentPage = resolveNextCurrentPage({
            previousState: state,
            pagesLength: pages.length,
            usedCursor: Boolean(cursor),
            openLoadedPage,
          });

          return {
            loaded: true,
            loading: false,
            liveStatus: 'ok',
            liveErrorKind: null,
            lastAttemptedPageSize: requestedPageSize,
            pages,
            currentPage: nextCurrentPage,
            nextCursor,
            hasMore: !!nextCursor,
            pageSize: requestedPageSize,
          };
        });
      } catch (error) {
        handleLeaderboardError({ error, stateKey, silent });
      }
    },
    [handleLeaderboardError, isRateLimitBlocked, mergePlayers, setApiErrorWithKind, setBoardState],
  );

  const retrySummary = useCallback(() => {
    if (isRateLimitBlocked) return;
    setSummaryReloadTrigger((prev) => prev + 1);
    setWorldStateReloadTrigger((prev) => prev + 1);
  }, [isRateLimitBlocked]);

  const goToPlayer = useCallback((uuid: string) => {
    window.location.href = `/statistiken/spieler/?uuid=${encodeURIComponent(uuid)}`;
  }, []);

  const setKingCurrentPage = useCallback((pageIndex: number) => {
    setKing((state) => ({ ...state, currentPage: pageIndex }));
  }, []);

  const setActiveMetricCurrentPage = useCallback(
    (pageIndex: number) => {
      if (!activeMetricId) return;
      setBoards((prev) => {
        const current = prev[activeMetricId] || makeEmptyLeaderboardState();
        return {
          ...prev,
          [activeMetricId]: {
            ...current,
            currentPage: pageIndex,
          },
        };
      });
    },
    [activeMetricId],
  );

  useEffect(() => {
    if (activeTab !== 'uebersicht') return;

    const ac = new AbortController();
    const thresholds = LIVE_WIDGET_THRESHOLDS['stats-kpi'];

    const applySummaryPayload = (data: SummaryResponse): void => {
      if (typeof data.__generated === 'string') setGeneratedIso(data.__generated);
      if (typeof data.player_count === 'number') setPlayerCount(data.player_count);
      if (data.totals && typeof data.totals === 'object') {
        setTotals(data.totals as Record<string, number>);
      }
    };

    const applySummaryState = (
      state: LiveDataState<SummaryResponse>,
      options: { initial: boolean; hasRevalidate: boolean },
    ): void => {
      if (ac.signal.aborted) return;

      if (state.data) {
        applySummaryPayload(state.data);
      }
      const timestamp = resolveLastUpdatedTimestamp(state);
      if (timestamp != null) {
        setSummaryLastUpdatedAt(timestamp);
      }

      if (state.status === 'loading') {
        setSummaryLoading(true);
        setSummaryError(null);
        return;
      }

      const shouldTreatInitialStateAsLoading =
        options.initial &&
        options.hasRevalidate &&
        (state.status === 'stale' || state.status === 'error');

      if (shouldTreatInitialStateAsLoading) {
        if (state.status === 'stale') {
          setSummaryLoaded(true);
        }
        setSummaryLoading(true);
        setSummaryError(null);
        setApiErrorWithKind(null, null);
        return;
      }

      setSummaryLoaded(true);
      setSummaryLoading(false);

      if (state.status === 'error' || state.status === 'stale') {
        const errorKind = state.error?.kind === 'rate_limit' ? 'rate_limit' : 'unknown';
        const message =
          getLiveMessage({ status: 'error', errorKind }) ??
          (errorKind === 'rate_limit' ? API_RATE_LIMIT_MESSAGE : API_ERROR_MESSAGE);
        setSummaryError(message);
        setApiErrorWithKind(message, errorKind);
        return;
      }

      setSummaryError(null);
      setApiErrorWithKind(null, null);
    };

    (async () => {
      const resource = getLiveResource(
        SUMMARY_CACHE_KEY,
        () => resolveStatsLiveData(() => getSummary(KPI_METRICS, ac.signal), registerRateLimit),
        {
          staleAfterMs: thresholds.staleAfterMs,
          maxCacheAgeMs: thresholds.maxCacheAgeMs,
          persist: true,
          minRevalidateIntervalMs: SUMMARY_MIN_REVALIDATE_INTERVAL_MS,
        },
      );

      applySummaryState(resource.state, {
        initial: true,
        hasRevalidate: resource.revalidate != null,
      });

      if (!resource.revalidate) return;

      const latest = await resource.revalidate;
      applySummaryState(latest, {
        initial: false,
        hasRevalidate: true,
      });

      if (
        !ac.signal.aborted &&
        (latest.status === 'error' || (latest.status === 'stale' && latest.error))
      ) {
        console.warn('Summary Fehler', latest.error ?? latest);
      }
    })();

    return () => {
      ac.abort();
      setSummaryLoading(false);
    };
  }, [activeTab, registerRateLimit, setApiErrorWithKind, summaryReloadTrigger]);

  useEffect(() => {
    if (activeTab !== 'uebersicht') return;

    const ac = new AbortController();
    const thresholds = LIVE_WIDGET_THRESHOLDS['stats-kpi'];

    const applyWorldStatePayload = (data: WorldStateResponse): void => {
      if (typeof data.__generated === 'string') setGeneratedIso(data.__generated);
      if ('world' in data) {
        setWorldState(data.world ?? null);
      }
    };

    const applyWorldState = (
      state: LiveDataState<WorldStateResponse>,
      options: { initial: boolean; hasRevalidate: boolean },
    ): void => {
      if (ac.signal.aborted) return;

      if (state.data) {
        applyWorldStatePayload(state.data);
      }

      if (state.status === 'loading') {
        setWorldStateLoading(true);
        setWorldStateError(null);
        return;
      }

      const shouldTreatInitialStateAsLoading =
        options.initial &&
        options.hasRevalidate &&
        (state.status === 'stale' || state.status === 'error');

      if (shouldTreatInitialStateAsLoading) {
        if (state.status === 'stale') {
          setWorldStateLoaded(true);
        }
        setWorldStateLoading(true);
        setWorldStateError(null);
        return;
      }

      setWorldStateLoaded(true);
      setWorldStateLoading(false);

      if (state.status === 'error' || state.status === 'stale') {
        const errorKind = state.error?.kind === 'rate_limit' ? 'rate_limit' : 'unknown';
        const message =
          getLiveMessage({ status: 'error', errorKind }) ??
          (errorKind === 'rate_limit' ? API_RATE_LIMIT_MESSAGE : API_ERROR_MESSAGE);
        setWorldStateError(message);
        return;
      }

      setWorldStateError(null);
    };

    (async () => {
      const resource = getLiveResource(
        WORLD_STATE_CACHE_KEY,
        () => resolveStatsLiveData(() => getWorldState(ac.signal), registerRateLimit),
        {
          staleAfterMs: thresholds.staleAfterMs,
          maxCacheAgeMs: thresholds.maxCacheAgeMs,
          persist: true,
          minRevalidateIntervalMs: SUMMARY_MIN_REVALIDATE_INTERVAL_MS,
        },
      );

      applyWorldState(resource.state, {
        initial: true,
        hasRevalidate: resource.revalidate != null,
      });

      if (!resource.revalidate) return;

      const latest = await resource.revalidate;
      applyWorldState(latest, {
        initial: false,
        hasRevalidate: true,
      });

      if (
        !ac.signal.aborted &&
        (latest.status === 'error' || (latest.status === 'stale' && latest.error))
      ) {
        console.warn('Weltzustand Fehler', latest.error ?? latest);
      }
    })();

    return () => {
      ac.abort();
      setWorldStateLoading(false);
    };
  }, [activeTab, registerRateLimit, worldStateReloadTrigger]);

  useEffect(() => {
    if (activeTab !== 'uebersicht') return;

    const staleAfterMs = LIVE_WIDGET_THRESHOLDS['stats-kpi'].staleAfterMs;

    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (summaryLoadingRef.current) return;
      if (isRateLimitBlocked) return;

      const now = Date.now();
      if (now - summaryVisibilityRevalidateAtRef.current < SUMMARY_MIN_REVALIDATE_INTERVAL_MS) {
        return;
      }

      const lastUpdatedAt = summaryLastUpdatedAtRef.current;
      if (typeof lastUpdatedAt === 'number' && now - lastUpdatedAt <= staleAfterMs) return;

      summaryVisibilityRevalidateAtRef.current = now;
      setSummaryReloadTrigger((prev) => prev + 1);
      setWorldStateReloadTrigger((prev) => prev + 1);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [activeTab, isRateLimitBlocked]);

  useEffect(() => {
    if (activeTab !== 'ranglisten') return;

    const ac = new AbortController();
    void ensureMetricsLoaded({ signal: ac.signal });

    return () => ac.abort();
  }, [activeTab, ensureMetricsLoaded]);

  const filteredMetricIds = useMemo(
    () => filterMetricIds(metrics, metricFilter),
    [metrics, metricFilter],
  );

  const groupedMetrics: GroupedMetrics = useMemo(
    () => groupMetricIds(metrics, filteredMetricIds),
    [metrics, filteredMetricIds],
  );

  useEffect(() => {
    if (activeTab !== 'ranglisten' || !metrics) return;
    if (activeMetricId && filteredMetricIds.includes(activeMetricId)) return;

    setActiveMetricId(pickDefaultRankMetricId(filteredMetricIds, metrics));
  }, [activeTab, metrics, filteredMetricIds, activeMetricId]);

  const activeMetricBoard = activeMetricId ? boards[activeMetricId] : null;
  const activeMetricState = activeMetricBoard || makeEmptyLeaderboardState();
  const activeMetricLoaded = activeMetricBoard?.loaded ?? false;
  const activeMetricLoading = activeMetricBoard?.loading ?? false;
  const activeMetricBoardPageSize = activeMetricBoard?.pageSize ?? null;

  useEffect(() => {
    if (activeTab !== 'king') return;
    if (isRateLimitBlocked) return;

    const kingNeedsRefresh =
      (!king.loaded || king.pageSize !== pageSize) && king.lastAttemptedPageSize !== pageSize;
    if (kingNeedsRefresh && !king.loading) {
      void loadLeaderboard('king', 'king');
    }
  }, [
    activeTab,
    isRateLimitBlocked,
    king.lastAttemptedPageSize,
    king.loaded,
    king.loading,
    king.pageSize,
    pageSize,
    loadLeaderboard,
  ]);

  useEffect(() => {
    if (activeTab !== 'ranglisten' || !activeMetricId) return;
    if (isRateLimitBlocked) return;

    const metricNeedsRefresh =
      (!activeMetricLoaded || activeMetricBoardPageSize !== pageSize) &&
      activeMetricState.lastAttemptedPageSize !== pageSize;
    if (metricNeedsRefresh && !activeMetricLoading) {
      void loadLeaderboard(activeMetricId, activeMetricId);
    }
  }, [
    activeTab,
    activeMetricId,
    activeMetricLoaded,
    activeMetricLoading,
    activeMetricBoardPageSize,
    activeMetricState.lastAttemptedPageSize,
    isRateLimitBlocked,
    pageSize,
    loadLeaderboard,
  ]);

  const hasNoRanklistResults = !!metrics && filteredMetricIds.length === 0;
  const prefetchRankings = useCallback(async () => {
    if (activeTab === 'ranglisten') return;
    if (isRateLimitBlocked) return;

    const resolvedMetrics = await ensureMetricsLoaded({ silent: true });
    if (!resolvedMetrics) return;

    const candidates = filterMetricIds(resolvedMetrics, '');
    const metricId =
      (activeMetricId && resolvedMetrics[activeMetricId] ? activeMetricId : null) ||
      pickDefaultRankMetricId(candidates, resolvedMetrics);

    if (!metricId) return;

    const board = boardsRef.current[metricId];
    const boardIsFresh = Boolean(board?.loaded) && board?.pageSize === pageSizeRef.current;
    if (boardIsFresh) return;

    await loadLeaderboard(metricId, metricId, { silent: true });
  }, [activeMetricId, activeTab, ensureMetricsLoaded, isRateLimitBlocked, loadLeaderboard]);
  const setApiErrorMessage = useCallback(
    (message: string | null) => {
      setApiErrorWithKind(message, message ? 'unknown' : null);
    },
    [setApiErrorWithKind],
  );

  return {
    generatedIso,
    setGeneratedIso,
    playerCount,
    totals,
    worldState,
    worldStateLoaded,
    worldStateLoading,
    worldStateError,
    summaryLoaded,
    summaryLoading,
    summaryError,
    summaryLastUpdatedAt,
    prefetchRankings,
    retrySummary,
    summaryRetryDisabled: isRateLimitBlocked,
    summaryRetryInSeconds: rateLimitRetryInSeconds,
    apiError: apiErrorMessage,
    setApiError: setApiErrorMessage,
    mainSearch,
    metrics,
    groupedMetrics,
    filteredMetricIds,
    hasNoRanklistResults,
    king,
    setKingCurrentPage,
    loadMoreKing: () => loadLeaderboard('king', 'king', { openLoadedPage: true }),
    reloadKing: () => loadLeaderboard('king', 'king', { forceRefresh: true }),
    boards,
    activeMetricId,
    setActiveMetricId,
    activeMetricState,
    setActiveMetricCurrentPage,
    loadMoreActiveMetric: () => {
      if (!activeMetricId) return Promise.resolve();
      return loadLeaderboard(activeMetricId, activeMetricId, { openLoadedPage: true });
    },
    reloadActiveMetric: () => {
      if (!activeMetricId) return Promise.resolve();
      return loadLeaderboard(activeMetricId, activeMetricId, { forceRefresh: true });
    },
    getPlayerName,
    goToPlayer,
  };
}
