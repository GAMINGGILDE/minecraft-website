// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLiveCounters } from './live-counters';

const now = new Date('2026-09-08T12:00:00Z').getTime();
const response = (count = 2, names: string[] | null = ['Steve', 'Alex'], extra = {}) =>
  Response.json({
    data: {
      online: true,
      players: { online: count, list: names?.map((name) => ({ name })) ?? null },
      updatedAt: Date.now(),
      expiresAt: Date.now() + 300_000,
    },
    stale: false,
    ...extra,
  });
let cleanup: (() => void) | undefined;
const counter = () => document.querySelector<HTMLElement>('[data-mc-online]')!;
const list = () => document.querySelector<HTMLElement>('#player-list')!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  window.localStorage.clear();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  document.body.innerHTML = `<span data-mc-online>0</span>
    <div data-live-tile="mc-online"><p data-live-note-for="mc-online"></p>
    <div data-live-actions-for="mc-online"><button data-live-retry="mc-online">Neu laden</button></div>
    <i data-live-indicator="mc-online"></i></div><div id="player-list">Lade Spieler...</div>`;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function start() {
  cleanup = initLiveCounters({
    config: { serverIp: 'minecraft-gilde.de' },
    qsa: (selector) => Array.from(document.querySelectorAll(selector)),
  });
  window.dispatchEvent(new Event('pointerdown'));
  await vi.advanceTimersByTimeAsync(0);
}

describe('Gemeinsame Minecraft-Anzeige', () => {
  it('zaehlt eine Rate-Limit-Pause herunter und holt danach neue Daten', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response(null, { status: 429, headers: { 'Retry-After': '120' } }),
      )
      .mockImplementation(async () => response());
    vi.stubGlobal('fetch', fetcher);
    await start();
    const note = document.querySelector<HTMLElement>('[data-live-note-for]')!;
    expect(note.textContent).toContain('120');
    expect(document.querySelector<HTMLButtonElement>('[data-live-retry]')!.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(note.textContent).toContain('60');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(counter().textContent).toBe('2');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('entfernt zu alte Daten auch waehrend einer langen Retry-After-Pause', async () => {
    const fetcher = vi.fn(async () =>
      response(2, ['Steve', 'Alex'], {
        data: {
          online: true,
          players: { online: 2, list: [{ name: 'Steve' }] },
          updatedAt: now - 600_000,
          expiresAt: now - 300_000,
        },
        stale: true,
        retryAfterMs: 7_200_000,
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    await start();
    expect(counter().textContent).toBe('2');
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(counter().dataset.liveState).toBe('error');
    expect(list().textContent).not.toContain('Steve');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('kennzeichnet den Worker-Fallback als veraltet und respektiert dessen Retry-Pause', async () => {
    const fetcher = vi.fn(async () =>
      response(2, ['Steve', 'Alex'], {
        data: {
          online: true,
          players: { online: 2, list: [{ name: 'Steve' }, { name: 'Alex' }] },
          updatedAt: now - 600_000,
          expiresAt: now - 300_000,
        },
        stale: true,
        retryAfterMs: 120_000,
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    await start();
    expect(counter().dataset.liveState).toBe('stale');
    expect(counter().textContent).toBe('2');
    expect(list().textContent).toContain('vor 10 Min');
    await vi.advanceTimersByTimeAsync(119_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('nutzt beim erneuten Seitenaufruf einen gemeinsamen gespeicherten Stand fuer Zahl und Namen', async () => {
    const fetcher = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetcher);
    await start();
    cleanup?.();
    await start();
    expect(counter().textContent).toBe('2');
    expect(list().textContent).toContain('Alex');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bleibt nach Netzwerkfehlern bedienbar und versucht tatsaechlich erneut zu laden', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Netzwerk'))
      .mockImplementation(async () => response());
    vi.stubGlobal('fetch', fetcher);
    await start();
    expect(counter().dataset.liveState).toBe('error');
    document.querySelector<HTMLButtonElement>('[data-live-retry]')!.click();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(counter().dataset.liveState).toBe('error');
    expect(document.querySelector<HTMLElement>('[data-live-actions-for]')!.dataset.visible).toBe(
      'true',
    );
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(counter().textContent).toBe('2');
    expect(list().textContent).toContain('Steve');
  });

  it('beendet einen Timeout und plant danach einen echten Retry', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        (_url, { signal }) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason)),
          ),
      )
      .mockImplementation(async () => response());
    vi.stubGlobal('fetch', fetcher);
    await start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(counter().dataset.liveState).toBe('error');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(counter().textContent).toBe('2');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('aktualisiert Zahl und Namen gemeinsam erst nach Ablauf der Quelldaten', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async () => response())
      .mockImplementation(async () => response(4, ['Steve', 'Alex', 'Chris', 'Bob']));
    vi.stubGlobal('fetch', fetcher);
    await start();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/minecraft-status/');
    await vi.advanceTimersByTimeAsync(299_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(counter().textContent).toBe('4');
    expect(list().textContent).toContain('Chris');
  });

  it('behaelt bei Fehlern Zahl und Namen mit Hinweis, verwirft sie aber nach 30 Minuten', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(async () => response())
        .mockRejectedValue(new TypeError('Netzwerk')),
    );
    await start();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(counter().textContent).toBe('2');
    expect(counter().dataset.liveState).toBe('stale');
    expect(list().textContent).toContain('Steve');
    expect(list().textContent).toContain('Letzter bekannter Stand');
    await vi.advanceTimersByTimeAsync(1_500_000);
    expect(counter().dataset.liveState).toBe('error');
    expect(list().textContent).not.toContain('Steve');
  });

  it('unterscheidet fehlende Namen, Teilmengen, null Spieler und Offline-Status', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async () => response(4, null))
      .mockImplementationOnce(async () => response(4, ['Alex']))
      .mockImplementationOnce(async () => response(0, []))
      .mockImplementationOnce(async () =>
        response(0, [], {
          data: {
            online: false,
            players: { online: 0, list: [] },
            updatedAt: Date.now(),
            expiresAt: Date.now() + 300_000,
          },
        }),
      );
    vi.stubGlobal('fetch', fetcher);
    await start();
    expect(counter().textContent).toBe('4');
    expect(list().textContent).toContain('Spielernamen derzeit nicht verfügbar');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(list().textContent).toContain('1 von 4 Namen');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(list().textContent).toBe('Keine Spieler online.');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(list().textContent).toBe('Server derzeit offline.');
    expect(counter().dataset.liveState).toBe('error');
  });

  it('pausiert im Hintergrund, laedt bei Rueckkehr und entsorgt laufende Anfragen sauber', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async () => response())
      .mockImplementation(
        (_url, { signal }) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason)),
          ),
      );
    vi.stubGlobal('fetch', fetcher);
    await start();
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const previous = document.body.innerHTML;
    cleanup?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(document.body.innerHTML).toBe(previous);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
