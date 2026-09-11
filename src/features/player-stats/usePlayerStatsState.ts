import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';

import { getPlayer, getTranslations } from '../stats-core/api';
import { logMissingTranslations } from '../stats-core/i18n';
import type { PlayerApiResponse, PlayerTranslations } from '../stats-core/types';
import {
  buildMcHeadsAvatarUrl,
  buildMcHeadsSkinUrl,
  buildCraftheadHelmUrl,
  buildCraftheadSkinUrl,
} from '../../lib/minecraft/playerTextures';
import { FetchJsonHttpError } from '../../lib/http/fetchJson';
import { parseFilter } from './format';
import {
  buildPlayerTables,
  filterPlayerTables,
  isTabKey,
  sortPlayerTables,
  type ItemsRow,
  type MobsRow,
  type SortState,
  type TabKey,
} from './table-model';

export type UsePlayerStatsState = {
  activeTab: TabKey;
  setActiveTab: (next: TabKey) => void;
  isGerman: boolean;
  setIsGerman: (next: boolean | ((current: boolean) => boolean)) => void;
  uuidParam: string;
  uuidFull: string;
  playerName: string;
  generatedIso: string | null;
  apiError: string | null;
  filterRaw: string;
  setFilterRaw: (next: string) => void;
  filterInputRef: RefObject<HTMLInputElement | null>;
  sortGeneral: SortState<'label' | 'value' | 'raw'>;
  setSortGeneral: Dispatch<SetStateAction<SortState<'label' | 'value' | 'raw'>>>;
  sortItems: SortState<keyof ItemsRow>;
  setSortItems: Dispatch<SetStateAction<SortState<keyof ItemsRow>>>;
  sortMobs: SortState<keyof MobsRow>;
  setSortMobs: Dispatch<SetStateAction<SortState<keyof MobsRow>>>;
  filtered: ReturnType<typeof filterPlayerTables>;
  stats: Record<string, unknown> | null;
  canRender: boolean;
  uuidCopied: boolean;
  setUuidCopied: Dispatch<SetStateAction<boolean>>;
  skinHeadUrl: string;
  skinHeadFallback: string;
  skinFullUrl: string;
  skinFullFallback: string;
};

function hasPlayerStatsPayload(
  player: PlayerApiResponse['player'],
): player is Record<string, unknown> {
  return !!player && typeof player === 'object' && Object.keys(player).length > 0;
}

function buildMissingStatsMessage(playerName: string): string {
  const label = playerName.trim() || 'dieser Spieler';
  return `F\u00fcr ${label} liegen noch keine Spielerstatistiken vor. Der Spieler ist bekannt oder gerade online, wurde aber noch nicht in den Statistikdaten erfasst.`;
}

function getPlayerLoadErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return '';
  }

  if (error instanceof FetchJsonHttpError) {
    if (error.status === 400) {
      return 'Der Spielerlink ist ung\u00fcltig. \u00d6ffne einen Spieler \u00fcber die Suche auf /statistiken oder pr\u00fcfe den Link.';
    }

    if (error.status === 429) {
      return 'Die Spielerstatistiken wurden zu oft angefragt. Bitte versuche es gleich erneut.';
    }
  }

  return 'Die Spielerstatistiken sind aktuell nicht erreichbar. Bitte versuche es sp\u00e4ter erneut.';
}

export function usePlayerStatsState(): UsePlayerStatsState {
  const [activeTab, setActiveTab] = useState<TabKey>('allgemein');
  const [isGerman, setIsGerman] = useState(true);
  const [forceTranslationCheck, setForceTranslationCheck] = useState(false);

  const [uuidParam, setUuidParam] = useState<string>('');
  const [uuidFull, setUuidFull] = useState<string>('');
  const [playerName, setPlayerName] = useState<string>('');
  const [generatedIso, setGeneratedIso] = useState<string | null>(null);
  const [queryReady, setQueryReady] = useState(false);

  const [translations, setTranslations] = useState<PlayerTranslations | null>(null);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);

  const [apiError, setApiError] = useState<string | null>(null);

  const [filterRaw, setFilterRaw] = useState('');
  const filterDeferred = useDeferredValue(filterRaw);
  const parsedQueries = useMemo(() => parseFilter(filterDeferred), [filterDeferred]);
  const filterInputRef = useRef<HTMLInputElement | null>(null);

  const [sortGeneral, setSortGeneral] = useState<SortState<'label' | 'value' | 'raw'>>({
    key: 'label',
    dir: 'none',
  });
  const [sortItems, setSortItems] = useState<SortState<keyof ItemsRow>>({
    key: 'label',
    dir: 'none',
  });
  const [sortMobs, setSortMobs] = useState<SortState<keyof MobsRow>>({ key: 'label', dir: 'none' });

  const [uuidCopied, setUuidCopied] = useState(false);

  useEffect(() => {
    const qp = new URLSearchParams(window.location.search);
    const uuid = (qp.get('uuid') || '').trim();
    const tab = qp.get('tab');
    const filter = qp.get('filter') || '';
    const i18nCheck = (qp.get('i18ncheck') || '').trim().toLowerCase();
    setUuidParam(uuid);
    if (isTabKey(tab)) setActiveTab(tab);
    if (filter) setFilterRaw(filter);
    if (i18nCheck === '1' || i18nCheck === 'true' || i18nCheck === 'yes') {
      setForceTranslationCheck(true);
    }
    setQueryReady(true);
  }, []);

  useEffect(() => {
    if (!queryReady) return;

    const qp = new URLSearchParams(window.location.search);
    if (uuidParam) qp.set('uuid', uuidParam);
    else qp.delete('uuid');
    qp.set('tab', activeTab);
    if (filterRaw.trim()) qp.set('filter', filterRaw);
    else qp.delete('filter');

    const qs = qp.toString();
    const nextUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    // URL-Parameter synchron halten, ohne einen neuen Verlaufseintrag zu erzeugen.
    if (nextUrl !== currentUrl) {
      window.history.replaceState({}, '', nextUrl);
    }
  }, [queryReady, uuidParam, activeTab, filterRaw]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isFormField =
        !!target &&
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target.isContentEditable);

      if (e.key === '/' && !isFormField) {
        e.preventDefault();
        const input = filterInputRef.current;
        if (!input) return;
        input.focus();
        input.select();
      }

      if (e.key === 'Escape' && document.activeElement === filterInputRef.current && filterRaw) {
        setFilterRaw('');
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filterRaw]);

  useEffect(() => {
    if (!queryReady) return;

    const uuid = uuidParam.trim();
    if (!uuid) {
      setApiError(
        'Es wurde keine UUID \u00fcbergeben. \u00d6ffne einen Spieler \u00fcber die Suche auf /statistiken.',
      );
      setPlayerName('');
      setUuidFull('');
      setStats(null);
      setGeneratedIso(null);
      return;
    }

    const ac = new AbortController();

    const applyPlayerResponse = (
      data: PlayerApiResponse,
      fallbackUuid: string,
      nextTranslations: PlayerTranslations | null,
    ) => {
      const found = data.found === true || hasPlayerStatsPayload(data.player);

      if (!found) {
        setApiError(
          'Die \u00fcbergebene UUID ist unbekannt. Nutze die Spielersuche auf /statistiken oder pr\u00fcfe den Link.',
        );
        setPlayerName('');
        setUuidFull(fallbackUuid);
        setStats(null);
        setGeneratedIso(null);
        return;
      }

      const uuidResolved = (data.uuid || fallbackUuid).trim();
      const nameResolved = (data.name || uuidResolved).trim();
      const playerStats = data.player;

      setUuidFull(uuidResolved);
      setPlayerName(nameResolved);
      setGeneratedIso(typeof data.__generated === 'string' ? data.__generated : null);

      if (!hasPlayerStatsPayload(playerStats)) {
        setApiError(buildMissingStatsMessage(nameResolved));
        setStats(null);
        return;
      }

      setStats(playerStats);

      try {
        if (playerStats && typeof playerStats === 'object') {
          logMissingTranslations(playerStats, nextTranslations, {
            enabled: import.meta.env.DEV || forceTranslationCheck,
          });
        }
      } catch {
        // Unkritisch: Debug-Logging darf fehlschlagen.
      }
    };

    (async () => {
      try {
        const [nextTranslations, playerData] = await Promise.all([
          getTranslations(ac.signal).catch(() => null),
          getPlayer(uuid, ac.signal),
        ]);

        setTranslations(nextTranslations);
        applyPlayerResponse(playerData, uuid, nextTranslations);
        if (hasPlayerStatsPayload(playerData.player)) setApiError(null);
      } catch (e) {
        const errorMessage = getPlayerLoadErrorMessage(e);
        if (!errorMessage) return;

        console.warn('Spielerstatistiken konnten nicht geladen werden:', e);
        setApiError(errorMessage);
        setPlayerName('');
        setUuidFull(uuid);
        setStats(null);
        setGeneratedIso(null);
      }
    })();

    return () => ac.abort();
  }, [forceTranslationCheck, queryReady, uuidParam]);

  useEffect(() => {
    if (!playerName) return;
    document.title = `Minecraft Gilde - Spielerstatistik von ${playerName}`;
  }, [playerName]);

  const skinHeadUrl = useMemo(
    () => buildCraftheadHelmUrl(uuidFull, playerName, 512),
    [playerName, uuidFull],
  );
  const skinHeadFallback = useMemo(
    () => buildMcHeadsAvatarUrl(uuidFull, playerName, 512),
    [playerName, uuidFull],
  );
  const skinFullUrl = useMemo(
    () => buildCraftheadSkinUrl(uuidFull, playerName),
    [playerName, uuidFull],
  );
  const skinFullFallback = useMemo(
    () => buildMcHeadsSkinUrl(uuidFull, playerName),
    [playerName, uuidFull],
  );

  const tables = useMemo(
    () => buildPlayerTables(stats, isGerman, translations),
    [stats, isGerman, translations],
  );
  const sorted = useMemo(
    () => sortPlayerTables(tables, sortGeneral, sortItems, sortMobs),
    [tables, sortGeneral, sortItems, sortMobs],
  );
  const filtered = useMemo(
    () => filterPlayerTables(sorted, parsedQueries),
    [sorted, parsedQueries],
  );

  return {
    activeTab,
    setActiveTab,
    isGerman,
    setIsGerman,
    uuidParam,
    uuidFull,
    playerName,
    generatedIso,
    apiError,
    filterRaw,
    setFilterRaw,
    filterInputRef,
    sortGeneral,
    setSortGeneral,
    sortItems,
    setSortItems,
    sortMobs,
    setSortMobs,
    filtered,
    stats,
    canRender: !!uuidParam,
    uuidCopied,
    setUuidCopied,
    skinHeadUrl,
    skinHeadFallback,
    skinFullUrl,
    skinFullFallback,
  };
}
