import type { GalleryImage } from '../../lib/home/gallery';

const qs = <T extends Element>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(sel);

type NetworkInformationLike = {
  saveData?: boolean;
  effectiveType?: string;
};

type NavigatorWithConnection = Navigator & {
  connection?: NetworkInformationLike;
  mozConnection?: NetworkInformationLike;
  webkitConnection?: NetworkInformationLike;
};

type GalleryElements = {
  root: HTMLElement;
  imgA: HTMLImageElement;
  imgB: HTMLImageElement;
  placeholder: HTMLElement | null;
  prevBtn: HTMLElement | null;
  nextBtn: HTMLElement | null;
};

type GalleryRuntime = {
  elements: GalleryElements;
  order: string[];
  sources: Map<string, GalleryImage>;
  bad: Set<string>;
  intervalMs: number;
  fadeMs: number;
  preloadDelayMs: number;
  autoplayAllowed: boolean;
  allowIdlePreload: boolean;
  index: number;
  front: HTMLImageElement;
  back: HTMLImageElement;
  timer: number | null;
  transitionTimer: number | null;
  idlePreloadTimer: number | null;
  idlePreloadHandle: number | null;
  pendingPreloadSrc: string | null;
  isAutoplayPaused: boolean;
  isInViewport: boolean;
  ready: boolean;
  isTransitioning: boolean;
  touchStartX: number | null;
  touchStartY: number | null;
  disposed: boolean;
  preloadOk: (src: string) => Promise<boolean>;
  cleanupFns: Array<() => void>;
};

const getNetworkHints = (): { saveData: boolean; slowNetwork: boolean } => {
  if (typeof navigator === 'undefined') {
    return { saveData: false, slowNetwork: false };
  }

  const nav = navigator as NavigatorWithConnection;
  const connection = nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
  const effectiveType = (connection?.effectiveType ?? '').toLowerCase();
  const slowNetwork = effectiveType.includes('2g') || effectiveType === '3g';

  return {
    saveData: connection?.saveData === true,
    slowNetwork,
  };
};

const shuffleInPlace = <T>(arr: T[]): T[] => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

function parseImageList(root: HTMLElement): GalleryImage[] {
  const raw = root.getAttribute('data-gallery-images') || '[]';

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (image): image is GalleryImage =>
        image &&
        typeof image.src === 'string' &&
        image.src.length > 0 &&
        typeof image.srcset === 'string' &&
        typeof image.sizes === 'string',
    );
  } catch {
    return [];
  }
}

function readNumberAttribute(root: HTMLElement, attr: string, fallback: number, min = 0): number {
  const parsed = Number(root.getAttribute(attr) || String(fallback));
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function resolveTiming(root: HTMLElement): {
  intervalMs: number;
  preloadDelayMs: number;
  fadeMs: number;
  autoplayAllowed: boolean;
  allowIdlePreload: boolean;
} {
  const intervalMs = readNumberAttribute(root, 'data-gallery-interval', 5200, 1);
  const preloadDelayDefaultMs = readNumberAttribute(
    root,
    'data-gallery-preload-delay-default',
    350,
    0,
  );
  const preloadDelaySlowMs = readNumberAttribute(root, 'data-gallery-preload-delay-slow', 1200, 0);
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fadeMs = prefersReduced ? 0 : 700;
  const { saveData, slowNetwork } = getNetworkHints();

  return {
    intervalMs,
    preloadDelayMs: slowNetwork ? preloadDelaySlowMs : preloadDelayDefaultMs,
    fadeMs,
    autoplayAllowed: !saveData,
    allowIdlePreload: !saveData,
  };
}

function setVisible(el: HTMLElement, visible: boolean): void {
  el.classList.toggle('opacity-100', visible);
  el.classList.toggle('opacity-0', !visible);
}

function revealPlaceholder(placeholder: HTMLElement | null): void {
  if (!placeholder) return;
  placeholder.classList.add('opacity-0');
}

function showSingle(elements: GalleryElements): void {
  setVisible(elements.imgA, true);
  setVisible(elements.imgB, false);
  revealPlaceholder(elements.placeholder);
}

function applyImageSource(el: HTMLImageElement, image: GalleryImage): void {
  el.sizes = image.sizes;
  el.srcset = image.srcset;
  el.src = image.src;
}

function createPreloadOk(
  bad: Set<string>,
  sources: Map<string, GalleryImage>,
): (src: string) => Promise<boolean> {
  return (src: string) =>
    new Promise((resolve) => {
      if (!src) return resolve(false);
      if (bad.has(src)) return resolve(false);

      const tmp = new Image();
      let done = false;

      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        if (!ok) bad.add(src);
        resolve(ok);
      };

      tmp.decoding = 'async';
      tmp.loading = 'eager';
      tmp.onload = () => finish(true);
      tmp.onerror = () => finish(false);
      const image = sources.get(src);
      if (!image) return finish(false);
      applyImageSource(tmp, image);

      if (tmp.complete) {
        finish(tmp.naturalWidth > 0);
      }
    });
}

function findNextIndex(runtime: GalleryRuntime, fromIndex: number, delta: number): number | null {
  for (let tries = 1; tries <= runtime.order.length; tries++) {
    const i = (fromIndex + delta * tries + runtime.order.length) % runtime.order.length;
    if (!runtime.bad.has(runtime.order[i])) return i;
  }
  return null;
}

async function pickFirstLoadableIndex(
  runtime: GalleryRuntime,
  startAt = 0,
): Promise<number | null> {
  for (let tries = 0; tries < runtime.order.length; tries++) {
    const i = (startAt + tries) % runtime.order.length;
    const ok = await runtime.preloadOk(runtime.order[i]);
    if (ok) return i;
  }
  return null;
}

function cancelPendingIdlePreload(runtime: GalleryRuntime): void {
  if (runtime.idlePreloadTimer != null) {
    window.clearTimeout(runtime.idlePreloadTimer);
    runtime.idlePreloadTimer = null;
  }

  if (runtime.idlePreloadHandle != null && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(runtime.idlePreloadHandle);
    runtime.idlePreloadHandle = null;
  }

  runtime.pendingPreloadSrc = null;
}

function scheduleIdlePreload(runtime: GalleryRuntime, src: string): void {
  if (!runtime.isInViewport || document.hidden) return;
  if (!runtime.allowIdlePreload || !src || runtime.bad.has(src) || runtime.disposed) return;
  if (
    runtime.pendingPreloadSrc === src &&
    (runtime.idlePreloadTimer != null || runtime.idlePreloadHandle != null)
  ) {
    return;
  }

  cancelPendingIdlePreload(runtime);
  runtime.pendingPreloadSrc = src;

  runtime.idlePreloadTimer = window.setTimeout(() => {
    runtime.idlePreloadTimer = null;

    const run = () => {
      runtime.idlePreloadHandle = null;
      const target = runtime.pendingPreloadSrc;
      runtime.pendingPreloadSrc = null;
      if (!target || runtime.disposed || document.hidden || !runtime.isInViewport) return;
      void runtime.preloadOk(target);
    };

    if (typeof window.requestIdleCallback === 'function') {
      runtime.idlePreloadHandle = window.requestIdleCallback(run, {
        timeout: runtime.preloadDelayMs + 1000,
      });
    } else {
      run();
    }
  }, runtime.preloadDelayMs);
}

function scheduleNextIdlePreload(runtime: GalleryRuntime, fromIndex: number): void {
  const nextIndex = findNextIndex(runtime, fromIndex, +1);
  if (nextIndex == null) return;
  scheduleIdlePreload(runtime, runtime.order[nextIndex]);
}

async function setSrcSafe(
  runtime: GalleryRuntime,
  el: HTMLImageElement,
  src: string,
): Promise<boolean> {
  const ok = await runtime.preloadOk(src);
  if (!ok || runtime.disposed) return false;
  const image = runtime.sources.get(src);
  if (!image) return false;
  applyImageSource(el, image);
  return true;
}

async function transitionTo(runtime: GalleryRuntime, targetIndex: number): Promise<void> {
  if (runtime.disposed || document.hidden) return;
  if (runtime.isTransitioning) return;
  runtime.isTransitioning = true;

  let nextIndex: number | null = targetIndex;
  let nextSrc = '';
  let loaded = false;

  for (let tries = 0; tries < runtime.order.length; tries++) {
    if (nextIndex == null) break;
    nextSrc = runtime.order[nextIndex];
    loaded = await setSrcSafe(runtime, runtime.back, nextSrc);
    if (loaded) break;
    nextIndex = findNextIndex(runtime, nextIndex, +1);
  }

  if (!loaded || nextIndex == null || runtime.disposed) {
    runtime.isTransitioning = false;
    return;
  }

  scheduleNextIdlePreload(runtime, nextIndex);

  if (runtime.fadeMs === 0) {
    applyImageSource(runtime.front, runtime.sources.get(nextSrc)!);
    runtime.index = nextIndex;
    runtime.isTransitioning = false;
    return;
  }

  setVisible(runtime.back, true);
  setVisible(runtime.front, false);

  runtime.transitionTimer = window.setTimeout(() => {
    if (runtime.disposed) return;
    const tmp = runtime.front;
    runtime.front = runtime.back;
    runtime.back = tmp;

    setVisible(runtime.back, false);
    runtime.index = nextIndex;
    runtime.isTransitioning = false;
  }, runtime.fadeMs + 30);
}

async function step(runtime: GalleryRuntime): Promise<void> {
  if (runtime.disposed || runtime.isAutoplayPaused || document.hidden || !runtime.isInViewport)
    return;
  const nextIndex = findNextIndex(runtime, runtime.index, +1);
  if (nextIndex == null) return;
  void transitionTo(runtime, nextIndex);
}

function start(runtime: GalleryRuntime): void {
  if (
    !runtime.autoplayAllowed ||
    runtime.disposed ||
    !runtime.ready ||
    !runtime.isInViewport ||
    runtime.isAutoplayPaused ||
    document.hidden
  )
    return;
  if (runtime.timer != null) window.clearInterval(runtime.timer);
  runtime.timer = window.setInterval(() => {
    void step(runtime);
  }, runtime.intervalMs);
}

function pause(runtime: GalleryRuntime): void {
  runtime.isAutoplayPaused = true;
  if (runtime.timer != null) window.clearInterval(runtime.timer);
  runtime.timer = null;
}

function resume(runtime: GalleryRuntime): void {
  if (!runtime.autoplayAllowed) return;
  if (!runtime.isAutoplayPaused || runtime.disposed) return;
  runtime.isAutoplayPaused = false;
  start(runtime);
}

async function nudge(runtime: GalleryRuntime, delta: number): Promise<void> {
  const nextIndex = findNextIndex(runtime, runtime.index, delta);
  if (nextIndex == null) return;
  void transitionTo(runtime, nextIndex);
  if (!runtime.isAutoplayPaused) start(runtime);
}

function registerEvent(
  runtime: GalleryRuntime,
  target: EventTarget,
  event: string,
  handler: EventListener,
  options?: AddEventListenerOptions,
): void {
  target.addEventListener(event, handler, options);
  runtime.cleanupFns.push(() => target.removeEventListener(event, handler, options));
}

function registerInteractions(runtime: GalleryRuntime): void {
  const { root, prevBtn, nextBtn } = runtime.elements;

  if (prevBtn) {
    const onPrev: EventListener = () => {
      void nudge(runtime, -1);
    };
    registerEvent(runtime, prevBtn, 'click', onPrev);
  }

  if (nextBtn) {
    const onNext: EventListener = () => {
      void nudge(runtime, 1);
    };
    registerEvent(runtime, nextBtn, 'click', onNext);
  }

  const onTouchStart: EventListener = (event) => {
    const e = event as TouchEvent;
    if (e.touches.length !== 1) return;
    runtime.touchStartX = e.touches[0].clientX;
    runtime.touchStartY = e.touches[0].clientY;
  };

  const onTouchEnd: EventListener = (event) => {
    const e = event as TouchEvent;
    if (runtime.touchStartX == null || runtime.touchStartY == null) return;
    const touch = e.changedTouches[0];
    if (!touch) return;

    const dx = touch.clientX - runtime.touchStartX;
    const dy = touch.clientY - runtime.touchStartY;
    runtime.touchStartX = null;
    runtime.touchStartY = null;

    if (Math.abs(dx) < 40) return;
    if (Math.abs(dx) < Math.abs(dy)) return;

    if (dx > 0) {
      void nudge(runtime, -1);
    } else {
      void nudge(runtime, 1);
    }
  };

  const onVisibilityChange: EventListener = () => {
    if (document.hidden) pause(runtime);
    else resume(runtime);
  };

  registerEvent(runtime, root, 'touchstart', onTouchStart, { passive: true });
  registerEvent(runtime, root, 'touchend', onTouchEnd, { passive: true });
  registerEvent(runtime, root, 'mouseenter', () => pause(runtime));
  registerEvent(runtime, root, 'mouseleave', () => resume(runtime));
  registerEvent(runtime, root, 'focusin', () => pause(runtime));
  registerEvent(runtime, root, 'focusout', () => resume(runtime));
  registerEvent(runtime, document, 'visibilitychange', onVisibilityChange);
}

function createGalleryRuntime(elements: GalleryElements, images: GalleryImage[]): GalleryRuntime {
  const timing = resolveTiming(elements.root);
  const bad = new Set<string>();
  const sources = new Map(images.map((image) => [image.src, image]));
  // Das bereits im HTML geladene Startbild bleibt erhalten; nur Folgebilder werden gemischt.
  const order = [images[0].src, ...shuffleInPlace(images.slice(1).map((image) => image.src))];

  return {
    elements,
    order,
    sources,
    bad,
    intervalMs: timing.intervalMs,
    fadeMs: timing.fadeMs,
    preloadDelayMs: timing.preloadDelayMs,
    autoplayAllowed: timing.autoplayAllowed,
    allowIdlePreload: timing.allowIdlePreload,
    index: 0,
    front: elements.imgA,
    back: elements.imgB,
    timer: null,
    transitionTimer: null,
    idlePreloadTimer: null,
    idlePreloadHandle: null,
    pendingPreloadSrc: null,
    isAutoplayPaused: !timing.autoplayAllowed,
    isInViewport: false,
    ready: false,
    isTransitioning: false,
    touchStartX: null,
    touchStartY: null,
    disposed: false,
    preloadOk: createPreloadOk(bad, sources),
    cleanupFns: [],
  };
}

function cleanupRuntime(runtime: GalleryRuntime): void {
  runtime.disposed = true;
  if (runtime.timer != null) window.clearInterval(runtime.timer);
  if (runtime.transitionTimer != null) window.clearTimeout(runtime.transitionTimer);
  cancelPendingIdlePreload(runtime);
  runtime.cleanupFns.forEach((fn) => fn());
}

async function bootGallery(runtime: GalleryRuntime): Promise<void> {
  showSingle(runtime.elements);

  const firstIndex = await pickFirstLoadableIndex(runtime, 0);
  if (firstIndex == null || runtime.disposed) return;

  runtime.index = firstIndex;
  await setSrcSafe(runtime, runtime.front, runtime.order[runtime.index]);
  if (runtime.disposed) return;

  setVisible(runtime.front, true);
  setVisible(runtime.back, false);
  revealPlaceholder(runtime.elements.placeholder);
  runtime.ready = true;
  scheduleNextIdlePreload(runtime, runtime.index);
  start(runtime);
}

export function initHomeGallery(): () => void {
  const root = qs<HTMLElement>('[data-gallery]');
  if (!root) return () => {};

  const imgA = root.querySelector<HTMLImageElement>('[data-gallery-a]');
  const imgB = root.querySelector<HTMLImageElement>('[data-gallery-b]');
  const placeholder = root.querySelector<HTMLElement>('[data-gallery-placeholder]');
  const prevBtn = root.querySelector<HTMLElement>('[data-gallery-prev]');
  const nextBtn = root.querySelector<HTMLElement>('[data-gallery-next]');
  if (!imgA || !imgB) return () => {};

  const elements: GalleryElements = {
    root,
    imgA,
    imgB,
    placeholder,
    prevBtn,
    nextBtn,
  };

  const images = parseImageList(root);
  if (images.length < 2) {
    showSingle(elements);
    return () => {};
  }

  const runtime = createGalleryRuntime(elements, images);
  registerInteractions(runtime);

  if (typeof IntersectionObserver !== 'function') {
    runtime.isInViewport = true;
    void bootGallery(runtime);
  } else {
    let booted = false;
    const nearObserver = new IntersectionObserver(
      (entries) => {
        if (booted || !entries.some((entry) => entry.isIntersecting)) return;
        booted = true;
        nearObserver.disconnect();
        void bootGallery(runtime);
      },
      { rootMargin: '300px' },
    );
    const visibleObserver = new IntersectionObserver((entries) => {
      runtime.isInViewport = entries.some((entry) => entry.isIntersecting);
      if (runtime.isInViewport) {
        start(runtime);
        if (runtime.ready) scheduleNextIdlePreload(runtime, runtime.index);
      } else {
        if (runtime.timer != null) window.clearInterval(runtime.timer);
        runtime.timer = null;
        cancelPendingIdlePreload(runtime);
      }
    });
    nearObserver.observe(root);
    visibleObserver.observe(root);
    runtime.cleanupFns.push(() => {
      nearObserver.disconnect();
      visibleObserver.disconnect();
    });
  }

  return () => {
    cleanupRuntime(runtime);
  };
}
