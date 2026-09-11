// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchPlayers } from './api';
import { usePlayerAutocomplete } from './usePlayerAutocomplete';
import type { PlayersSearchResponse } from './types';

vi.mock('./api', () => ({ searchPlayers: vi.fn() }));

describe('Spielersuche bei wechselnder Eingabe', () => {
  let root: Root;
  let container: HTMLDivElement;
  let state: ReturnType<typeof usePlayerAutocomplete>;
  const onError = vi.fn();

  function Harness() {
    state = usePlayerAutocomplete({ onError });
    return null;
  }

  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.mocked(searchPlayers).mockReset();
    onError.mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Harness)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['success', 'error'] as const)(
    'ignoriert ein altes %s bereits während des Debounce',
    async (outcome) => {
      let resolveOld!: (value: PlayersSearchResponse) => void;
      let rejectOld!: (error: Error) => void;
      vi.mocked(searchPlayers).mockReturnValueOnce(
        new Promise((resolve, reject) => {
          resolveOld = resolve;
          rejectOld = reject;
        }),
      );
      await act(async () => state.setValue('st'));
      await act(async () => vi.advanceTimersByTimeAsync(180));
      const oldSignal = vi.mocked(searchPlayers).mock.calls[0][2];
      await act(async () => state.setValue('al'));
      expect(oldSignal?.aborted).toBe(true);
      await act(async () => {
        if (outcome === 'error') rejectOld(new Error('offline'));
        else resolveOld({ items: [{ uuid: 'steve', name: 'Steve' }] });
      });
      expect(state!.value).toBe('al');
      expect(state!.items).toEqual([]);
      expect(state!.errorMessage).toBeNull();
      expect(onError).not.toHaveBeenCalled();

      vi.mocked(searchPlayers).mockResolvedValueOnce({ items: [{ uuid: 'alex', name: 'Alex' }] });
      await act(async () => vi.advanceTimersByTimeAsync(180));
      expect(state!.items.map((item) => item.name)).toEqual(['Alex']);
    },
  );
});
