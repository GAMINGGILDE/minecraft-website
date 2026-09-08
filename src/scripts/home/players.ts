import type { LiveDataState } from '../../lib/live/types';
import type { MinecraftStatusSnapshot } from '../../lib/minecraft/status';
import { formatLastUpdatedLabel } from '../../lib/live/lastUpdated';

const qs = <T extends Element>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(sel);

const minotarURL = (uuid: string, name: string, size = 80): string =>
  uuid
    ? `https://minotar.net/helm/${encodeURIComponent(uuid)}/${size}.png`
    : `https://minotar.net/helm/${encodeURIComponent(name)}/${size}.png`;

const mcHeadsURL = (uuid: string, name: string, size = 80): string =>
  uuid
    ? `https://mc-heads.net/avatar/${encodeURIComponent(uuid)}/${size}`
    : `https://mc-heads.net/avatar/${encodeURIComponent(name)}/${size}`;

const setMountMessage = (mount: HTMLElement, message: string): void => {
  const p = document.createElement('p');
  p.className = 'text-sm text-muted';
  p.textContent = message;
  mount.replaceChildren(p);
};

function renderPlayers(data: MinecraftStatusSnapshot): void {
  const mount = qs<HTMLElement>('#player-list');
  if (!mount) return;

  if (!data.online) {
    setMountMessage(mount, 'Server derzeit offline.');
    return;
  }
  if (data.players.online === 0) {
    setMountMessage(mount, 'Keine Spieler online.');
    return;
  }
  if (!data.players.list?.length) {
    setMountMessage(
      mount,
      `${data.players.online} Spieler online. Spielernamen derzeit nicht verfügbar.`,
    );
    return;
  }

  const players = data.players?.list ?? [];
  const container = document.createElement('div');
  container.className = 'flex flex-wrap items-start justify-start gap-2';

  const label = document.createElement('div');
  label.className = 'text-xs font-medium text-muted mr-2';
  label.textContent =
    players.length < data.players.online
      ? `Spieler online (${players.length} von ${data.players.online} Namen verfügbar):`
      : 'Spieler online:';
  container.appendChild(label);

  players.forEach((player) => {
    const uuid = player.uuid ?? '';
    const name = player.name ?? 'Unbekannt';

    const chip: HTMLAnchorElement | HTMLSpanElement = uuid
      ? document.createElement('a')
      : document.createElement('span');
    chip.className = uuid ? 'mg-pill' : 'mg-pill cursor-default opacity-85';

    if (chip instanceof HTMLAnchorElement) {
      chip.href = `/statistiken/spieler/?uuid=${encodeURIComponent(uuid)}`;
    } else {
      chip.setAttribute('aria-disabled', 'true');
      chip.title = 'Spielerprofil derzeit nicht verfuegbar';
    }

    const img = document.createElement('img');
    img.className = 'h-6 w-6 rounded-full';
    img.alt = name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = minotarURL(uuid, name, 48);

    const onError = (): void => {
      const step = Number(img.dataset.fallbackStep ?? '0');
      if (step === 0) {
        img.dataset.fallbackStep = '1';
        img.src = mcHeadsURL(uuid, name, 48);
        return;
      }

      img.removeEventListener('error', onError);
      img.classList.add('hidden');
    };

    img.addEventListener('error', onError);

    const span = document.createElement('span');
    span.textContent = name;

    chip.appendChild(img);
    chip.appendChild(span);
    container.appendChild(chip);
  });

  mount.replaceChildren(container);
}

export function renderHomePlayers(state: LiveDataState<MinecraftStatusSnapshot>): void {
  const mount = qs<HTMLElement>('#player-list');
  if (!mount) return;
  mount.dataset.liveState = state.status;
  if (!state.data) {
    setMountMessage(
      mount,
      state.status === 'loading' ? 'Lade Spieler...' : 'Spieleranzeige aktuell nicht verfügbar.',
    );
    return;
  }
  renderPlayers(state.data);
  if (state.status === 'stale') {
    const note = document.createElement('p');
    note.className = 'mt-3 text-xs text-muted';
    note.textContent = `Letzter bekannter Stand. ${formatLastUpdatedLabel(state.data.updatedAt)}.`;
    mount.appendChild(note);
  }
}
