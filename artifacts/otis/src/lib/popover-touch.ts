/**
 * Helpers for popovers that must work with both hover (desktop) and tap (PWA).
 *
 * swallowNextClick: a non-modal Radix popover dismisses on pointerdown outside,
 * but the browser still fires the follow-up click on whatever was underneath —
 * which can trigger row clicks (e.g. opening a bill's edit dialog). Call this
 * from onPointerDownOutside to eat that one ghost click.
 *
 * canHover: hover open/close handlers should only run on devices with a real
 * hover pointer; on touch they interfere with the emulated mouse-event
 * sequence a tap produces.
 */
export function swallowNextClick(): void {
  const swallow = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
  };
  document.addEventListener("click", swallow, { capture: true, once: true });
  // Safety: if no click follows (e.g. dismissed via Escape), drop the trap.
  setTimeout(() => document.removeEventListener("click", swallow, { capture: true }), 500);
}

export function canHover(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(hover: hover)").matches;
}

import { useEffect, type RefObject } from "react";

/**
 * Dismiss an open popover on any pointerdown outside its content/trigger,
 * in the CAPTURE phase — before Radix and before anything underneath sees
 * the event. Needed because Radix's DismissableLayer defers touch dismissal
 * to the follow-up click event, which then also fires on whatever row was
 * underneath (ghost click). We close on pointerdown, cancel it, and swallow
 * the follow-up click ourselves.
 */
export function useOutsideTapDismiss(
  open: boolean,
  onClose: () => void,
  contentRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (ev: PointerEvent) => {
      // Touch only: on mouse/pen, Radix's own outside-dismiss works and
      // cancelling the event would eat the first click on unrelated UI.
      if (ev.pointerType !== "touch") return;
      const target = ev.target as Node | null;
      if (target && (contentRef.current?.contains(target) || triggerRef.current?.contains(target))) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      swallowNextClick();
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => document.removeEventListener("pointerdown", onPointerDown, { capture: true });
  }, [open, onClose, contentRef, triggerRef]);
}
