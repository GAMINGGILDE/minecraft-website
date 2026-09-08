import { LIVE_COPY_DE } from './copy.de';
import { parseRetryAfterMs } from '../http/retryAfter';

export type FetchJsonErrorKind = 'timeout' | 'network' | 'invalid' | 'rate_limit';

export interface FetchJsonError {
  kind: FetchJsonErrorKind;
  message: string;
  status?: number;
  retryAfterMs?: number;
}

export type FetchJsonResult<T> =
  | {
      ok: true;
      data: T;
      status: number;
      fetchedAt: number;
    }
  | {
      ok: false;
      error: FetchJsonError;
      status?: number;
      fetchedAt: number;
    };

export interface FetchJsonOptions<T> {
  signal?: AbortSignal;
  timeoutMs?: number;
  cache?: RequestCache;
  headers?: HeadersInit;
  requiredKeys?: string[];
  validate?: (value: unknown) => value is T;
}

const DEFAULT_TIMEOUT_MS = 6_500;

const isObjectLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasRequiredKeys = (value: unknown, requiredKeys: string[]): boolean => {
  if (requiredKeys.length === 0) return true;
  if (!isObjectLike(value)) return false;
  return requiredKeys.every((key) => key in value);
};

const toNetworkMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return LIVE_COPY_DE.error_network;
};

const createErrorResult = <T>(
  fetchedAt: number,
  error: FetchJsonError,
  status?: number,
): FetchJsonResult<T> => ({
  ok: false,
  fetchedAt,
  status,
  error,
});

const toHttpErrorResult = <T>(response: Response, fetchedAt: number): FetchJsonResult<T> | null => {
  if (response.ok) return null;

  if (response.status === 429) {
    return createErrorResult(
      fetchedAt,
      {
        kind: 'rate_limit',
        message: LIVE_COPY_DE.rate_limit,
        status: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
      },
      response.status,
    );
  }

  if (response.status >= 400 && response.status < 500) {
    return createErrorResult(
      fetchedAt,
      {
        kind: 'invalid',
        message: `Ungueltige Antwort (HTTP ${response.status}).`,
        status: response.status,
      },
      response.status,
    );
  }

  return createErrorResult(
    fetchedAt,
    {
      kind: 'network',
      message: `${LIVE_COPY_DE.error_network} (HTTP ${response.status}).`,
      status: response.status,
      retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
    },
    response.status,
  );
};

const validatePayload = <T>(
  payload: unknown,
  responseStatus: number,
  requiredKeys: string[],
  validate?: (value: unknown) => value is T,
): FetchJsonError | null => {
  if (!hasRequiredKeys(payload, requiredKeys)) {
    return {
      kind: 'invalid',
      message: `Antwort enthaelt nicht alle erwarteten Keys: ${requiredKeys.join(', ')}.`,
      status: responseStatus,
    };
  }

  if (!validate) return null;

  let isValid: boolean;
  try {
    isValid = validate(payload);
  } catch {
    isValid = false;
  }

  if (isValid) return null;

  return {
    kind: 'invalid',
    message: 'Antwort hat nicht das erwartete Format.',
    status: responseStatus,
  };
};

export const fetchLiveJson = async <T>(
  url: string,
  options: FetchJsonOptions<T> = {},
): Promise<FetchJsonResult<T>> => {
  const {
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cache,
    headers,
    requiredKeys = [],
    validate,
  } = options;

  const fetchedAt = Date.now();
  const controller = new AbortController();
  let didTimeout = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const onExternalAbort = (): void => {
    controller.abort(signal?.reason);
  };

  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort(new DOMException('Timeout', 'AbortError'));
    }, timeoutMs);
  }

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache,
      headers: {
        Accept: 'application/json',
        ...headers,
      },
    });

    const httpErrorResult = toHttpErrorResult<T>(response, fetchedAt);
    if (httpErrorResult) return httpErrorResult;

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return createErrorResult(
        fetchedAt,
        {
          kind: 'invalid',
          message: 'Antwort war kein gueltiges JSON.',
          status: response.status,
        },
        response.status,
      );
    }

    const payloadError = validatePayload(payload, response.status, requiredKeys, validate);
    if (payloadError) return createErrorResult(fetchedAt, payloadError, response.status);

    return {
      ok: true,
      data: payload as T,
      status: response.status,
      fetchedAt,
    };
  } catch (error) {
    if (didTimeout) {
      return createErrorResult(fetchedAt, {
        kind: 'timeout',
        message: LIVE_COPY_DE.error_timeout,
      });
    }

    return createErrorResult(fetchedAt, {
      kind: 'network',
      message: toNetworkMessage(error),
    });
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onExternalAbort);
  }
};
