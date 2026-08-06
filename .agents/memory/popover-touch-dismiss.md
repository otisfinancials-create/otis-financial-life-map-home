---
name: Popover touch dismiss (PWA)
description: How to make Radix popovers dismiss cleanly on mobile tap without ghost clicks
---

Rule: for tap-outside dismissal of non-modal Radix popovers on touch, use the shared hook in `artifacts/otis/src/lib/popover-touch.ts` (`useOutsideTapDismiss` + `swallowNextClick`, touch-pointer only), not `modal` and not `onPointerDownOutside`.

**Why:** Radix DismissableLayer defers *touch* outside-dismissal to the follow-up click event, so the same click also fires on whatever was underneath (e.g. a table row's onClick opened an edit dialog). `modal` popovers failed to dismiss at all on touch in e2e. Swallowing the click from `onPointerDownOutside` is too late because the dismissal *is* the click.

**How to apply:** capture-phase document `pointerdown` listener while open; if `pointerType==='touch'` and target is outside content+trigger refs, preventDefault + stopPropagation, swallow the next click (one-shot capture listener, 500ms safety timeout), and close. Mouse/pen falls through to Radix's normal dismissal. Hover open/close handlers must be gated on `matchMedia('(hover: hover)')` or they interfere with tap-emulated mouse events.
