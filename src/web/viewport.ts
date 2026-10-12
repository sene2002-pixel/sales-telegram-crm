export type ViewportInset = Partial<Record<'top' | 'bottom' | 'left' | 'right', number>>;
export interface TelegramViewport {
  ready?: () => void;
  expand?: () => void;
  requestFullscreen?: () => void;
  isFullscreen?: boolean;
  platform?: string;
  lockOrientation?: () => void;
  unlockOrientation?: () => void;
  isOrientationLocked?: boolean;
  setHeaderColor?: (color: string) => void;
  isVersionAtLeast?: (version: string) => boolean;
  viewportStableHeight?: number;
  safeAreaInset?: ViewportInset;
  contentSafeAreaInset?: ViewportInset;
  onEvent?: (name: string, callback: () => void) => void;
  offEvent?: (name: string, callback: () => void) => void;
}

// SDK failures must not interrupt authentication or ordinary browser use.
export function configureViewport(telegram?: TelegramViewport) {
  const root = document.documentElement;
  const properties = [
    '--pico-view-height',
    '--pico-view-top',
    '--pico-bottom-offset',
    ...['top', 'bottom', 'left', 'right'].map((side) => '--pico-safe-' + side),
  ];
  const previous = properties.map((name) => [
    name,
    root.style.getPropertyValue(name),
    root.style.getPropertyPriority(name),
  ]);
  const safeCall = (action?: () => void) => {
    try {
      action?.();
    } catch {
      /* Unsupported native capability: keep browser fallback. */
    }
  };
  const positive = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  const visual = window.visualViewport;
  const orientation = window.screen.orientation;
  const mobile =
    telegram?.platform === 'ios' ||
    telegram?.platform === 'android' ||
    window.matchMedia('(pointer: coarse)').matches;
  const previousPortrait = root.getAttribute('data-pico-portrait-required');
  let ownsNativeLock = false;
  let nativeLockAttempted = false;
  let landscapeUnlockAttempted = false;
  let ownsBrowserLock = false;
  let browserLockRequested = false;
  let cleaned = false;
  const native8 = () => {
    try {
      return !telegram?.isVersionAtLeast || telegram.isVersionAtLeast('8.0');
    } catch {
      return false;
    }
  };
  const updateOrientation = () => {
    if (!mobile) return;
    // Screen orientation survives keyboard viewport shrinking; viewport aspect does not.
    const portrait = orientation?.type
      ? orientation.type.startsWith('portrait')
      : typeof window.orientation === 'number'
        ? Math.abs(window.orientation) !== 90
        : window.screen.height >= window.screen.width;
    root.setAttribute('data-pico-portrait-required', String(!portrait));
    if (!portrait && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (
      !portrait &&
      telegram?.isOrientationLocked &&
      !landscapeUnlockAttempted &&
      native8() &&
      telegram.unlockOrientation
    ) {
      landscapeUnlockAttempted = true;
      try {
        telegram.unlockOrientation();
        ownsNativeLock = false;
        nativeLockAttempted = false;
      } catch {
        /* Keep rotate-to-portrait fallback without repeated native calls. */
      }
    }
    if (
      portrait &&
      !nativeLockAttempted &&
      !ownsNativeLock &&
      !telegram?.isOrientationLocked &&
      native8() &&
      telegram?.lockOrientation
    ) {
      nativeLockAttempted = true;
      try {
        telegram.lockOrientation();
        ownsNativeLock = true;
      } catch {
        /* Portrait guard remains the fallback. */
      }
    }
    const lock = (orientation as ScreenOrientation & { lock?: (mode: string) => Promise<void> })
      ?.lock;
    if (!browserLockRequested && lock) {
      browserLockRequested = true;
      try {
        Promise.resolve(lock.call(orientation, 'portrait'))
          .then(() => {
            if (cleaned) orientation?.unlock?.();
            else {
              ownsBrowserLock = true;
              updateOrientation();
            }
          })
          .catch(() => {
            /* Native SDK or rotate-to-portrait guard remains available. */
          });
      } catch {
        /* Unsupported browser lock must not interrupt startup. */
      }
    }
  };
  const update = () => {
    if (cleaned) return;
    updateOrientation();
    const top = positive(visual?.offsetTop);
    const height = Math.min(
      window.innerHeight,
      positive(visual?.height) || window.innerHeight,
      positive(telegram?.viewportStableHeight) || window.innerHeight,
    );
    root.style.setProperty('--pico-view-height', height + 'px');
    root.style.setProperty('--pico-view-top', top + 'px');
    root.style.setProperty(
      '--pico-bottom-offset',
      Math.max(0, window.innerHeight - top - height) + 'px',
    );
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      root.style.setProperty(
        '--pico-safe-' + side,
        `calc(max(env(safe-area-inset-${side}, 0px), ${positive(telegram?.safeAreaInset?.[side])}px) + ${positive(telegram?.contentSafeAreaInset?.[side])}px)`,
      );
    }
  };
  const fallback = () => {
    if (cleaned) return;
    safeCall(() => telegram?.expand?.());
    update();
  };
  const events = [
    'viewportChanged',
    'safeAreaChanged',
    'contentSafeAreaChanged',
    'fullscreenChanged',
  ];
  for (const name of events) safeCall(() => telegram?.onEvent?.(name, update));
  safeCall(() => telegram?.onEvent?.('fullscreenFailed', fallback));
  safeCall(() => telegram?.ready?.());
  safeCall(() => {
    if (!telegram?.isVersionAtLeast || telegram.isVersionAtLeast('6.9'))
      telegram?.setHeaderColor?.('#f5f7ff');
    else if (telegram.isVersionAtLeast('6.1')) telegram.setHeaderColor?.('bg_color');
  });
  safeCall(() => telegram?.expand?.());
  if (telegram?.requestFullscreen && !telegram.isFullscreen) {
    try {
      if (!telegram.isVersionAtLeast || telegram.isVersionAtLeast('8.0'))
        telegram.requestFullscreen();
    } catch {
      fallback();
    }
  }
  const preventPinch = (event: TouchEvent) => {
    if (event.touches.length > 1 && event.cancelable) event.preventDefault();
  };
  const preventGesture = (event: Event) => {
    if (event.cancelable) event.preventDefault();
  };
  const preventWheelPinch = (event: WheelEvent) => {
    if (event.ctrlKey && event.cancelable) event.preventDefault();
  };
  const options = { passive: false, capture: true };
  document.addEventListener('touchstart', preventPinch, options);
  document.addEventListener('touchmove', preventPinch, options);
  document.addEventListener('gesturestart', preventGesture, options);
  document.addEventListener('gesturechange', preventGesture, options);
  document.addEventListener('wheel', preventWheelPinch, options);
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  orientation?.addEventListener('change', update);
  visual?.addEventListener('resize', update);
  visual?.addEventListener('scroll', update);
  update();
  return () => {
    cleaned = true;
    if (ownsNativeLock) safeCall(() => telegram?.unlockOrientation?.());
    if (ownsBrowserLock) safeCall(() => orientation?.unlock?.());
    if (previousPortrait === null) root.removeAttribute('data-pico-portrait-required');
    else root.setAttribute('data-pico-portrait-required', previousPortrait);
    for (const name of events) safeCall(() => telegram?.offEvent?.(name, update));
    safeCall(() => telegram?.offEvent?.('fullscreenFailed', fallback));
    document.removeEventListener('touchstart', preventPinch, true);
    document.removeEventListener('touchmove', preventPinch, true);
    document.removeEventListener('gesturestart', preventGesture, true);
    document.removeEventListener('gesturechange', preventGesture, true);
    document.removeEventListener('wheel', preventWheelPinch, true);
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', update);
    orientation?.removeEventListener('change', update);
    visual?.removeEventListener('resize', update);
    visual?.removeEventListener('scroll', update);
    for (const [name, value, priority] of previous)
      value ? root.style.setProperty(name, value, priority) : root.style.removeProperty(name);
  };
}
