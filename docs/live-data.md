# Live-Daten Architektur und Zustände

Diese Mini-Doku erklärt in 2-3 Minuten, wie Live-Daten im Projekt funktionieren.

## 1) Schnellüberblick

Es gibt drei relevante Live-Daten-Pfade:

1. Minecraft-Status (`src/scripts/app/minecraft-status.ts`)
2. Discord Live Counter (`src/scripts/app/live-counters.ts`)
3. Statistik-KPI Summary (`src/features/stats/hooks/useStatsData.ts`)

Discord und Statistik nutzen das Cache-Modul `src/lib/live/cache.ts`. Alle drei nutzen die Live-States aus `src/lib/live/types.ts`.

### Minecraft-Status für alle Besucher

`GET /api/minecraft-status/` (auch `HEAD`) läuft im vorhandenen Cloudflare-Worker,
unabhängig von der Statistik-Datenbank. Der feste Minecraft-Server kommt aus
`minecraftGilde.serverIp`; URL-Parameter ändern das Abfrageziel nicht.

- Quelle: `https://api.mcsrvstat.us/3/<serverIp>`, Timeout 6,5 Sekunden,
  maximal 256 KiB Antwort, identifizierender User-Agent.
- Antwort: `{ data: { online, players: { online, list }, updatedAt, expiresAt }, stale, retryAfterMs? }`.
  Zeitstempel sind Millisekunden seit Unix-Epoch. `list: null` bedeutet, dass Namen fehlen.
- `updatedAt` und `expiresAt` übernehmen `debug.cachetime` und `debug.cacheexpire`
  der Quelle. Die Frische beträgt höchstens fünf Minuten; zusätzliche volle fünf Minuten
  werden nicht auf einen bereits alten Quellstand aufgeschlagen.
- `caches.default` speichert den letzten Stand bis zu 30 Minuten ab `updatedAt`.
  Besucher desselben Cloudflare-Rechenzentrums teilen diesen Cache. Er ist kein
  dauerhaft gespeicherter, weltweit synchroner Datenbestand.
- Bei Fehlern wird ein noch nutzbarer Stand mit `stale: true` und unverändertem
  Zeitstempel ausgeliefert. Ohne nutzbare Daten antwortet der Endpunkt mit 502,
  bei Timeout mit 504, bei Rate-Limit mit 429.
- Aufeinanderfolgende Fehler verlängern die gemeinsam gespeicherte Pause von 30 auf
  60 und höchstens 120 Sekunden. Ein erfolgreicher Abruf setzt die Fehlerstufe zurück;
  Cache-Treffer erhöhen sie nicht. Die Fehlerstufe bleibt bis 30 Minuten nach Ende der
  Pause im Cache, auch ohne nutzbare Daten. Ein längeres `Retry-After` der Quelle wird
  respektiert. Bestätigtes `online: false`
  ersetzt einen früheren Online-Stand und ist kein Transportfehler.
- Der interne Cache hält Daten länger als ihre Frischefrist. Fallback und Alterung
  werden ausdrücklich im Worker geprüft; die Browser-Antwort hat `Cache-Control: no-store`.
- `X-Minecraft-Cache` zeigt `HIT`, `MISS` oder `FALLBACK`. Strukturierte Warnungen
  protokollieren Quell- und Cache-Fehler ohne Spielernamen oder vollständige Antworten.

Im Browser steuert ein gemeinsamer Controller Zahl, Status und Namensliste.
Er lädt nach Ablauf der Quelldaten erneut, pausiert im unsichtbaren Tab und speichert
den letzten Stand optional unter `mg:minecraft-status:v1` in `localStorage`.
Bei Fehlern bleiben Zahl und Namen mit einem Hinweis erhalten, höchstens 30 Minuten.
Bei anhaltenden Fehlern oder veralteten Antworten wartet auch der Browser zunächst
30, dann 60 und danach höchstens 120 Sekunden zwischen Wiederholungsversuchen.
Frische Daten setzen seine Fehlerstufe zurück. Längere Wartezeiten des Workers gelten
zusätzlich, auch bei HTTP 5xx. Ein Klick während der Pause umgeht die Wartezeit nicht
und setzt die Anzeige nicht auf einen falschen Ladezustand.
Der Browser-Timeout beträgt zehn Sekunden und gibt dem Worker Zeit für seinen Fallback.
Teilweise oder fehlende Namen, null Spieler und ein Offline-Server werden getrennt angezeigt.

Implementierung: `src/pages/api/minecraft-status.ts`,
`src/lib/http/server/minecraftStatus.ts`, `src/lib/minecraft/status.ts`,
`src/scripts/app/minecraft-status.ts` und `src/scripts/home/players.ts`.

## 2) State Model

Zentrale States (`LiveDataStatus` in `src/lib/live/types.ts`):

- `loading`: Noch keine verwertbaren Daten verfügbar.
- `ok`: Erfolgreiche Antwort mit Daten.
- `empty`: Erfolgreiche Antwort, aber "0/leer" als fachlich gültiges Ergebnis.
- `stale`: Es gibt noch alte Daten, aber Revalidierung läuft oder ist fehlgeschlagen.
- `error`: Kein nutzbarer Stand verfügbar.

Fehlerarten (`LiveDataErrorKind`):

- `network`
- `timeout`
- `rate_limit`
- `invalid`
- `unknown`

Wichtig: `stale` bedeutet bewusst "alte Daten zeigen statt hart auszufallen".

## 3) Cache-Strategie

Implementierung in `src/lib/live/cache.ts`:

- Zweistufiger Cache:
  - In-Memory Map (schnell innerhalb der Session)
  - Optional `localStorage` (`persist: true`)
- Nur `ok` und `empty` werden persistiert.
- Deduplizierung paralleler Requests über `inFlightRequests` pro Cache-Key.

Alterung:

- `staleAfterMs`: Danach wird ein Cache-Eintrag als `stale` markiert.
- `maxCacheAgeMs`: Danach wird der Eintrag verworfen.

Standardwerte pro Widget (`LIVE_WIDGET_THRESHOLDS` in `src/lib/live/types.ts`):

- `discord-online`: stale nach 60s, max 30min
- `discord-members`: stale nach 5min, max 60min
- `stats-kpi`: stale nach 5min, max 60min

Fallback-Verhalten:

- Wenn Revalidierung fehlschlägt, aber Cache noch nicht zu alt ist:
  - Rückgabe als `stale` inkl. Fehlerinfo.
- Wenn Cache zu alt und Fetch fehlschlägt:
  - Rückgabe `error`.

## 4) Retry- und Rate-Limit-Handling

### Discord Live Counter (`src/scripts/app/live-counters.ts`)

- Timeout je Request: `6_500ms` (via `src/lib/live/fetchJson.ts`).
- Automatischer Retry bei `network`/`timeout`:
  - Basis: 1s
  - maximal 1 Wiederholungsversuch
- `429` wird als `rate_limit` klassifiziert.
- `Retry-After` Header wird ausgewertet (Sekunden oder HTTP-Datum).
- Für Live-Tiles mit Retry-Button:
  - Manuelles Revalidate ist während Cooldown/Busy gesperrt.
  - Debounce für manuelle Revalidierung: 2s.

### Statistik-KPI Summary (`src/features/stats/hooks/useStatsData.ts`)

- Nutzt `getLiveResource(...)` für Cache + Revalidierung.
- Kein separates Auto-Retry-Backoff wie bei Home-Countern.
- User-Flow "Erneut laden" triggert neue Revalidierung über `retrySummary`.

## 5) Wo Endpoints konfiguriert werden

### A) Home Live Counter Quellen

Quellwerte kommen aus `src/config/minecraftGilde.ts` (Export `browserAppConfig`) und werden in `src/layouts/BaseLayout.astro` als `data-*` Attribute am `<html>` gesetzt.

Gelesen werden sie in `src/scripts/app-config.ts`.

Relevante Felder:

- `serverIp` -> Minecraft Status API (serverseitig, siehe oben)
- `discordGuildId` -> Discord Widget API
- `discordInviteCode` -> Discord Invite API

### B) Statistik-Endpunkte

Frontend ruft relative Endpunkte auf:

- `src/features/stats/api.ts` (`/api/summary`, `/api/metrics`, `/api/leaderboard`, `/api/players`)
- `src/features/stats-core/api.ts` (`/api/player`)

Die API-Runtime liegt in `src/pages/api/[...path].ts` und implementiert die
Statistik-API direkt im Worker (`src/lib/http/server/statsApiProxy.ts`).
Die Daten kommen direkt aus MariaDB bzw. für Skin/Cape aus Mojang.

Siehe auch `docs/stats-api.md` für Endpunkte, Caching und lokales Setup.

## 6) Änderungen sicher durchführen

Wenn du Live-Daten anpasst, prüfe mindestens:

1. Passende Thresholds in `src/lib/live/types.ts`
2. Gewünschten Cache-Key/Prefix (`src/lib/live/cache.ts` und Aufrufer)
3. Fehler- und Retry-Verhalten im UI (`src/scripts/app/live-counters.ts` oder Stats Hooks)
