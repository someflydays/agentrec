/**
 * Shortcut arbitration. The timeline and the app shell both bind bare keys, so
 * they need one answer to "is something else already using the keyboard?".
 */

let openOverlays = 0;

/** Called by every modal while it is mounted; the returned function releases it. */
export function registerOverlay(): () => void {
  openOverlays += 1;
  return () => {
    openOverlays -= 1;
  };
}

export function overlayIsOpen(): boolean {
  return openOverlays > 0;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}
