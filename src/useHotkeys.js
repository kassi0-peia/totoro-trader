// Keyboard layer — invisible cockpit controls (kisa's clutter rule: new
// features earn zero pixels). One window-level keydown listener dispatches:
//
//   1..N   → timeframe buttons, in tf-bar order
//   Esc    → close the top-most transient thing (ONE per press; App owns the
//            priority chain — components that already self-handle Esc, like
//            the trade modal and the chart menu, are only *consumed* here)
//   Space  → re-center / follow the chart (snap to now)
//   C / P  → arm a CALL / PUT confirm ticket at the hovered strike, else the
//            nearest OTM strike — the same setPending path a chart click uses;
//            NEVER sends an order directly
//
// Guards: nothing fires from inputs/textareas/selects/contentEditable, nothing
// fires with ctrl/meta/alt held, and key repeat is ignored (a held Esc must
// not cascade-close every layer).

import { useEffect, useRef } from 'react';

// Is the event target a text-entry surface? (Pure — unit-tested.)
export function isEditableTarget(t) {
  if (!t) return false;
  const tag = String(t.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable;
}

// Map a keydown to an intent, or null. (Pure — unit-tested.)
export function keyIntent(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.repeat) return null;
  if (e.key === 'Escape') return { kind: 'escape' };
  if (/^[1-9]$/.test(e.key)) return { kind: 'digit', n: +e.key };
  if (e.key === ' ') return { kind: 'space' };
  const k = String(e.key).toLowerCase();
  if (k === 'c') return { kind: 'ticket', type: 'call' };
  if (k === 'p') return { kind: 'ticket', type: 'put' };
  if (k === 'n') return { kind: 'note' }; // annotate the latest fill
  if (e.key === '?') return { kind: 'help' }; // the self-documenting overlay
  return null;
}

// handlers: { onEscape, onDigit(n), onSpace(), onTicket('call'|'put'), onNote() }.
// onDigit/onSpace/onTicket/onNote return true when they acted → preventDefault
// (stops Space from scrolling the page). Handlers are read through a ref so the
// listener binds once and never goes stale.
export default function useHotkeys(handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e) => {
      if (isEditableTarget(e.target)) return;
      const intent = keyIntent(e);
      if (!intent) return;
      const h = ref.current;
      if (intent.kind === 'escape') { h.onEscape?.(); return; }
      if (intent.kind === 'digit') { if (h.onDigit?.(intent.n)) e.preventDefault(); return; }
      if (intent.kind === 'space') { if (h.onSpace?.()) e.preventDefault(); return; }
      if (intent.kind === 'ticket') { if (h.onTicket?.(intent.type)) e.preventDefault(); return; }
      if (intent.kind === 'note') { if (h.onNote?.()) e.preventDefault(); return; }
      if (intent.kind === 'help') { if (h.onHelp?.()) e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
