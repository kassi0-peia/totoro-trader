// Soft cockpit sounds. Two tones, both intentionally quiet:
// money should be audible, never loud. Best-effort — the browser may block
// audio before the first user interaction; we just skip.

function withCtx(fn) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    fn(ctx);
    setTimeout(() => ctx.close().catch(() => {}), 800);
  } catch {}
}

// Fill chime — the original two-note hop (moved verbatim from App.jsx):
// A5 → E6, a happy fifth-ish, ~0.35s.
export function chimeFill() {
  withCtx((ctx) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.connect(g);
    g.connect(ctx.destination);
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.setValueAtTime(1318.5, ctx.currentTime + 0.09); // E6 — a happy fifth-ish hop
    g.gain.setValueAtTime(0.07, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.start();
    o.stop(ctx.currentTime + 0.4);
  });
}

// Alert blip — a single, equally-soft tone an octave down (A4), ~0.2s.
// Distinct from the fill chime at a glance-of-the-ear: one low note = a level
// pinged; two rising notes = money moved.
export function chimeAlert() {
  withCtx((ctx) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.connect(g);
    g.connect(ctx.destination);
    o.frequency.setValueAtTime(440, ctx.currentTime);
    g.gain.setValueAtTime(0.06, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
    o.start();
    o.stop(ctx.currentTime + 0.22);
  });
}
