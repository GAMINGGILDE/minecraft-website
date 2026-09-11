import { useEffect, useRef, useState } from 'react';

import { searchPlayers } from './api';
import { rankPlayersForQuery } from './player-search';
import type { PlayersSearchItem } from './types';
import { LIVE_COPY_DE } from '../../lib/live/copy.de';

export function usePlayerAutocomplete({
  onGeneratedIso,
  onError,
  initialValue = '',
}: {
  onGeneratedIso?: (iso: string) => void;
  onError?: (message: string | null) => void;
  initialValue?: string;
}) {
  const normalizedInitialValue = initialValue.trim();
  const [value, setValueState] = useState(normalizedInitialValue);
  const [items, setItems] = useState<PlayersSearchItem[]>([]);
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const suppressOpenForQueryRef = useRef<string | null>(
    normalizedInitialValue.length > 0 ? normalizedInitialValue.toLowerCase() : null,
  );
  const knownItemsRef = useRef<Map<string, PlayersSearchItem>>(new Map());

  function setValue(next: string) {
    if (next !== value) {
      abortRef.current?.abort();
      setItems([]);
      setSelectedIndex(-1);
    }
    suppressOpenForQueryRef.current = null;
    setErrorMessage(null);
    setValueState(next);
  }

  function setValueWithoutAutoOpen(next: string) {
    if (next !== value) abortRef.current?.abort();
    suppressOpenForQueryRef.current = next.trim().toLowerCase();
    setErrorMessage(null);
    setIsLoading(false);
    setValueState(next);
    setOpen(false);
    setSelectedIndex(-1);
  }

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      if (!el.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    const q = value.trim();
    if (q.length < 2) {
      abortRef.current?.abort();
      abortRef.current = null;
      suppressOpenForQueryRef.current = null;
      setIsLoading(false);
      setErrorMessage(null);
      setItems([]);
      setOpen(false);
      setSelectedIndex(-1);
      return;
    }

    const t = window.setTimeout(async () => {
      if (ac.signal.aborted) return;
      setIsLoading(true);
      setErrorMessage(null);

      try {
        const data = await searchPlayers(q, 6, ac.signal);
        if (ac.signal.aborted) return;
        if (typeof data.__generated === 'string') onGeneratedIso?.(data.__generated);
        const apiItems = Array.isArray(data.items) ? data.items : [];
        for (const item of apiItems) {
          if (!item?.uuid || !item?.name) continue;
          knownItemsRef.current.set(item.uuid, item);
        }

        const nextItems = rankPlayersForQuery(q, apiItems, knownItemsRef.current.values(), 6);
        const suppressOpen = suppressOpenForQueryRef.current === q.toLowerCase();
        setItems(nextItems);
        setOpen(!suppressOpen);
        if (suppressOpen) suppressOpenForQueryRef.current = null;
        setSelectedIndex(-1);
        setIsLoading(false);
        setErrorMessage(null);
        onError?.(null);
      } catch (e) {
        if (ac.signal.aborted || (e as Error)?.name === 'AbortError') return;
        console.warn('Autocomplete Fehler', e);
        setItems([]);
        setOpen(true);
        setSelectedIndex(-1);
        setIsLoading(false);
        setErrorMessage(LIVE_COPY_DE.error_generic);
        onError?.(LIVE_COPY_DE.error_generic);
      }
    }, 180);

    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [value, onGeneratedIso, onError]);

  return {
    value,
    setValue,
    setValueWithoutAutoOpen,
    items,
    setItems,
    open,
    setOpen,
    selectedIndex,
    setSelectedIndex,
    wrapRef,
    isLoading,
    errorMessage,
  };
}
