export type ViewportInset = Partial<Record<'top' | 'bottom' | 'left' | 'right', number>>;
export interface TelegramViewport {
  ready?: () => void;
  expand?: () => void;
  disableVerticalSwipes?: () => void;
  enableVerticalSwipes?: () => void;
  isVerticalSwipesEnabled?: boolean;
  requestFullscreen?: () => void;
  exitFullscreen?: () => void;
  isFullscreen?: boolean;
  platform?: string;
  lockOrientation?: () => void;
  unlockOrientation?: () => void;
  isOrientationLocked?: boolean;
  setHeaderColor?: (color: string) => void;
  isVersionAtLeast?: (version: string) => boolean;
  viewportStableHeight?: number;
  viewportHeight?: number;
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
  const previousKeyboard = root.getAttribute('data-pico-keyboard-open');
  let keyboardOpen = false;
  let keyboardFrame = 0;
  let baselineWidth = window.innerWidth;
  const usableBaseline = () =>
    Math.min(
      window.innerHeight,
      positive(visual?.height) || window.innerHeight,
      positive(telegram?.viewportStableHeight) || window.innerHeight,
    );
  let baselineHeight = usableBaseline();
  const editable = () => {
    const element = document.activeElement;
    if (element instanceof HTMLTextAreaElement)
      return !element.disabled && !element.readOnly ? element : null;
    if (element instanceof HTMLInputElement)
      return !element.disabled &&
        !element.readOnly &&
        element.inputMode !== 'none' &&
        ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(element.type)
        ? element
        : null;
    return element instanceof HTMLElement && element.isContentEditable ? element : null;
  };
  const revealEditable = () => {
    cancelAnimationFrame(keyboardFrame);
    keyboardFrame = requestAnimationFrame(() => {
      if (cleaned || !keyboardOpen) return;
      const field = editable();
      if (!field) return;
      let top = positive(visual?.offsetTop) + 12;
      let bottom =
        positive(visual?.offsetTop) +
        parseFloat(root.style.getPropertyValue('--pico-view-height')) -
        12;
      const dialog = field.closest('[role="dialog"]');
      const footer = dialog?.querySelector(
        '.company-form-footer, .cc-editor-actions, form > button.primary',
      );
      if (footer && !footer.contains(field)) {
        const footerBounds = footer.getBoundingClientRect();
        if (footerBounds.height && footerBounds.top > top)
          bottom = Math.min(bottom, footerBounds.top - 12);
      }
      const header = dialog?.querySelector('.section-head');
      if (header) top = Math.max(top, header.getBoundingClientRect().bottom + 12);
      const shift = (upper: number, lower: number) => {
        const bounds = field.getBoundingClientRect();
        if (bounds.top < upper) return bounds.top - upper;
        return Math.max(0, bounds.bottom - lower);
      };
      // Scroll the actual inner form first. Native Telegram can report a smaller
      // usable area without changing the browser's own scrollIntoView viewport.
      for (let parent = field.parentElement; parent; parent = parent.parentElement) {
        if (
          /(auto|scroll)/.test(getComputedStyle(parent).overflowY) &&
          parent.scrollHeight > parent.clientHeight
        ) {
          const clip = parent.getBoundingClientRect();
          parent.scrollTop += shift(
            Math.max(top, clip.top + 12),
            Math.min(bottom, clip.bottom - 12),
          );
        }
      }
      if (!dialog) window.scrollBy({ top: shift(top, bottom), behavior: 'instant' });
    });
  };
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
    const field = editable();
    // Native viewportHeight may shrink before the stable height or browser viewport changes.
    const liveHeight = mobile && (field || keyboardOpen) ? positive(telegram?.viewportHeight) : 0;
    const height = Math.min(
      liveHeight || window.innerHeight,
      window.innerHeight,
      positive(visual?.height) || window.innerHeight,
      positive(telegram?.viewportStableHeight) || window.innerHeight,
    );
    if (baselineWidth !== window.innerWidth) {
      baselineWidth = window.innerWidth;
      baselineHeight = usableBaseline();
      keyboardOpen = false;
    }
    baselineHeight = Math.max(baselineHeight, height);
    keyboardOpen =
      mobile &&
      (visual?.scale == null || visual.scale === 1) &&
      Boolean(field || keyboardOpen) &&
      baselineHeight - height > Math.max(120, baselineHeight * 0.2);
    root.setAttribute('data-pico-keyboard-open', String(keyboardOpen));
    root.style.setProperty('--pico-view-height', height + 'px');
    root.style.setProperty('--pico-view-top', top + 'px');
    root.style.setProperty(
      '--pico-bottom-offset',
      Math.max(0, window.innerHeight - top - height) + 'px',
    );
    revealEditable();
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
  // Keep Telegram's native title/close/menu bar visible, including reopened sessions.
  if (telegram?.exitFullscreen && telegram.isFullscreen) {
    try {
      if (!telegram.isVersionAtLeast || telegram.isVersionAtLeast('8.0')) telegram.exitFullscreen();
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
  const updateFocus = () => {
    cancelAnimationFrame(keyboardFrame);
    keyboardFrame = requestAnimationFrame(() => {
      // Focus alone must not rewrite viewport/safe-area geometry (e.g. hardware
      // keyboards or a sheet with an independently constrained usable height).
      const focusedHeight = Math.min(
        window.innerHeight,
        positive(visual?.height) || window.innerHeight,
        positive(telegram?.viewportHeight) || window.innerHeight,
        positive(telegram?.viewportStableHeight) || window.innerHeight,
      );
      if (
        mobile &&
        (keyboardOpen ||
          (editable() && baselineHeight - focusedHeight > Math.max(120, baselineHeight * 0.2)))
      )
        update();
    });
  };
  document.addEventListener('focusin', updateFocus);
  document.addEventListener('focusout', updateFocus);
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  orientation?.addEventListener('change', update);
  visual?.addEventListener('resize', update);
  visual?.addEventListener('scroll', update);
  update();
  return () => {
    cleaned = true;
    cancelAnimationFrame(keyboardFrame);
    if (previousKeyboard === null) root.removeAttribute('data-pico-keyboard-open');
    else root.setAttribute('data-pico-keyboard-open', previousKeyboard);
    document.removeEventListener('focusin', updateFocus);
    document.removeEventListener('focusout', updateFocus);
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
