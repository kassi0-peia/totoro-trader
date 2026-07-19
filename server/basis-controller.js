// Basis controller — the single owner of the ES↔SPX basis and its fallback
// ladder. Overnight, every SPX-equivalent price the user sees and trades against
// is `esPrice − effectiveBasis()`, so this state is load-bearing. See
// AGENTS.md ("Basis (ES↔SPX)"), README ("Market sessions & the ES↔SPX basis"),
// and spec-options-implied-basis.md.
//
// The ladder, strongest witness first:
//   1. fresh options-implied basis (esPrice − put/call-parity forward, recomputed
//      overnight from quality-gated near-ATM SPXW quotes; trusted for ~30 s after a
//      good recompute) — delegated to options-forward.js, whose math is not
//      duplicated here;
//   2. the frozen 4:00 PM (or early-close 13:00) SIMULTANEOUS live-ES − live-SPX
//      capture, persisted atomically to `.basis-cache.json` and reloaded on start;
//   3. the cold-start seed (env override → persisted capture/closes → literal).
//
// This module owns ALL basis state. It never imports the bridge or reaches into
// bridge globals: the coordinator injects the clock, persistence, cold-start
// config, and a session getter, then feeds it ticks/chain samples/close-bar
// witnesses and publishes the result. The coordinator keeps the broker I/O
// (market-data subscriptions, history requests for the 15:59 close bars) and the
// live esPrice/spxPrice/chain, which it passes in — those are not basis state.

import { computeOptionsForward } from './options-forward.js';
import { etParts, ymd } from './session.js';

export const BASIS_CFG = {
  captureMin: 16 * 60,       // 4:00 PM ET — cash close, both feeds live: a true ES−SPX read
  liveFreshMs: 30_000,       // options-implied basis trusted this long after a good recompute
  auditTolerancePts: 2.0,    // capture-vs-witness agreement band (normal jitter is << 0.5)
  auditGraceMs: 45_000,      // wait for a qualifying chain before falling to the bar witness
  coldStartLiteral: 20,      // last-resort constant (ES≈7540 − SPX≈7520) when nothing is known
};

/**
 * Create the basis controller.
 *
 * Injected boundaries:
 *   now()                     -> epoch milliseconds (injectable clock)
 *   session()                 -> { rth, source, expiry } (live session, read on demand)
 *   persist(cacheObject)      -> atomically write the `.basis-cache.json` shape
 *   readCache()               -> the parsed cache object, or null (missing/corrupt)
 *   coldStartEnv              -> operator COLD_START_BASIS override (number|null)
 *   coldStartLiteral          -> last-resort constant
 *   log(...) / logError(...)  -> console.log / console.error by default
 *   cfg                       -> BASIS_CFG overrides
 *
 * The persisted on-disk schema is exactly:
 *   { basis, basisEstimated, esClose, spxClose, captureDate, esExpiry, ts }
 * and must stay readable by an unchanged file and the existing backups.
 */
export function createBasisController({
  now = Date.now,
  session,
  persist = () => {},
  readCache = () => null,
  coldStartEnv = null,
  coldStartLiteral = BASIS_CFG.coldStartLiteral,
  log = console.log,
  logError = console.error,
  cfg = {},
} = {}) {
  if (typeof session !== 'function') throw new TypeError('basis session getter is required');
  if (typeof now !== 'function') throw new TypeError('basis now clock must be a function');
  const C = { ...BASIS_CFG, ...cfg };

  // ── Basis state — this module is the only writer ──────────────────────────
  let basis = null;            // the applied frozen basis (ES − SPX)
  let basisFrozen = true;      // live during RTH (cash is authoritative), frozen otherwise
  let basisEstimated = false;  // true when `basis` is the cold-start fallback, not a real capture
  let basisCaptureDate = null; // YYYYMMDD of the 4:00 capture in force
  let basisEsExpiry = null;    // ES contract the basis was measured against (catches the roll)
  let esClose = null;          // raw ES at the capture (persisted; daily-change reference)
  let spxClose = null;         // raw SPX at the capture (persisted; daily-change reference)

  // Options-implied live basis (overnight). Never persisted.
  let basisLive = null;        // esPrice − optionsForward
  let basisLiveTs = 0;         // now() of the last good recompute
  let basisLiveWasFresh = false; // last observed freshness (drives the flip broadcast)

  // Same-day audit of the live capture (a lagging close print can freeze it wrong).
  let basisAuditDate = null;
  let basisAuditWaitUntil = null; // grace window while waiting for the options arbiter

  const isRth = () => !!session()?.rth;

  function basisLiveFresh() {
    return basisLive != null && now() - basisLiveTs < C.liveFreshMs;
  }

  // The number every overnight conversion uses: fresh options-implied when the
  // chain qualifies, else the frozen capture (RTH never reaches here for price —
  // source is SPX cash — and the !rth guard keeps a lingering basisLive off an
  // RTH-built bar).
  function effectiveBasis() {
    if (!isRth() && basisLiveFresh()) return basisLive;
    return basis ?? 0;
  }

  // Whether a shifted ES-proxy candle is riding an estimated basis (cold start /
  // mid-roll) — a fresh options-implied basis is chain-anchored, not an estimate.
  function estimatedProxy() {
    return basisEstimated && !basisLiveFresh();
  }

  function save() {
    try {
      persist({
        basis,
        basisEstimated,
        esClose,
        spxClose,
        captureDate: basisCaptureDate,
        esExpiry: basisEsExpiry,
        ts: now(),
      });
    } catch (err) {
      logError('[ibkr] saveBasis failed:', err);
    }
  }

  // Restore a trusted persisted 4:00 capture on start. A persisted *estimate*
  // (cold start) must not pin the value — let the fallback re-fire until the next
  // capture.
  function load() {
    let d;
    try { d = readCache(); } catch { return; }
    if (!d || typeof d.basis !== 'number' || d.basisEstimated) return;
    basis = d.basis;
    basisEstimated = false;
    basisFrozen = true;
    if (typeof d.esClose === 'number') esClose = d.esClose;
    if (typeof d.spxClose === 'number') spxClose = d.spxClose;
    // The ES contract the basis was measured against. Older cache files lack it
    // (null) — the backfill then re-derives against the resolved front month,
    // which both heals a missing value and catches a roll.
    if (typeof d.esExpiry === 'string') basisEsExpiry = d.esExpiry;
    // Capture date drives the backfill staleness check. Older files lack it —
    // derive it from the save timestamp's ET date.
    if (typeof d.captureDate === 'string') basisCaptureDate = d.captureDate;
    else if (typeof d.ts === 'number') {
      const e = etParts(new Date(d.ts));
      basisCaptureDate = ymd(e.y, e.mo, e.d);
    }
    const tail = (esClose != null && spxClose != null)
      ? ` (ES ${esClose.toFixed(2)} − SPX ${spxClose.toFixed(2)})` : '';
    log(`[ibkr] loaded persisted 4:00 basis ${basis.toFixed(2)}${tail}`);
  }

  // Resolve the cold-start basis, preferring real information over the literal:
  //   1. an explicit env override (operator knows best);
  //   2. the most recent persisted 4:00 capture — its `basis`, or recomputed from
  //      the persisted ES/SPX closes (even days-stale, the real premium tracks the
  //      level far better than a constant);
  //   3. the literal constant — only when nothing at all is known.
  function coldStart() {
    if (coldStartEnv != null && Number.isFinite(coldStartEnv)) {
      return { value: coldStartEnv, from: 'env override' };
    }
    try {
      const d = readCache();
      if (d) {
        if (typeof d.basis === 'number' && !d.basisEstimated) {
          return { value: d.basis, from: 'persisted 4:00 capture' };
        }
        if (typeof d.esClose === 'number' && typeof d.spxClose === 'number') {
          return { value: d.esClose - d.spxClose, from: 'persisted ES/SPX closes' };
        }
      }
    } catch { /* no/old cache file */ }
    return { value: coldStartLiteral, from: 'literal default' };
  }

  // Cold-start fallback: started overnight with no trusted basis. Seed from
  // coldStart() and apply it to live ES. Replaced by the next capture/backfill.
  function ensureOvernight(esPrice) {
    if (isRth() || basis != null || esPrice == null) return false;
    const cs = coldStart();
    basis = cs.value;
    basisEstimated = true;
    basisFrozen = true;
    save();
    log(`[ibkr] cold-start basis = ${basis.toFixed(2)} (${cs.from}). SPX-equiv = ES − ${basis.toFixed(2)}. The next 4:00 capture replaces it.`);
    return true;
  }

  // The authoritative capture: a SIMULTANEOUS live-ES − live-SPX reading at 4:00
  // PM ET (13:00 on a half-day — the coordinator drives the ET minute so the
  // early close reconstructs from the 13:00 witnesses). Both feeds are live at the
  // cash close, so this is a true ES−SPX read. Freshness of each leg is proven by
  // the coordinator (a watchdog reconnect near the close can leave stale ticks).
  function captureFrozen({ etMins, today, esPrice, spxPrice, esExpiry, spxFresh, esFresh }) {
    if (!isRth() || !(etMins >= C.captureMin) || basisCaptureDate === today
        || esPrice == null || spxPrice == null || !spxFresh || !esFresh) {
      return false;
    }
    basis = esPrice - spxPrice;
    basisFrozen = true;
    basisEstimated = false;
    basisCaptureDate = today;
    basisEsExpiry = esExpiry;
    esClose = esPrice;
    spxClose = spxPrice;
    save();
    log(`[ibkr] 4:00 PM basis captured = ${basis.toFixed(2)} (ES ${esPrice.toFixed(2)} − SPX ${spxPrice.toFixed(2)}, simultaneous, ${esExpiry})`);
    return true;
  }

  // Overnight options-implied recompute + freshness-transition detection. Returns
  // { fresh, freshChanged } so the coordinator can re-level the chart the moment
  // the applied basis flips options↔frozen in either direction.
  function recomputeFromChain({ esPrice, currentExpiry, entries } = {}) {
    recompute(esPrice, currentExpiry, entries);
    const fresh = !isRth() && basisLiveFresh();
    const freshChanged = fresh !== basisLiveWasFresh;
    if (freshChanged) {
      basisLiveWasFresh = fresh;
      if (!fresh) log('[ibkr] options-implied basis stale/unavailable — falling back to frozen');
    }
    return { fresh, freshChanged };
  }

  function recompute(esPrice, currentExpiry, entries) {
    if (isRth() || esPrice == null || currentExpiry == null || !Array.isArray(entries)) return;
    const frozenEstimate = esPrice - (basis ?? 0);
    const f = computeOptionsForward(
      entries.filter((e) => e && e.expiry === currentExpiry),
      // Anchor the strike band on the best current estimate so it survives a bad
      // frozen basis; sanity-check against the frozen estimate so a corrupt or
      // wrong-expiry chain can't drag the price somewhere wild.
      { anchor: esPrice - effectiveBasis(), sanityAnchor: frozenEstimate, now: now() },
    );
    if (!f) return; // fallback: effectiveBasis() degrades to frozen after the fresh window
    if (!basisLiveFresh()) {
      log(`[ibkr] options-implied basis live = ${(esPrice - f.forward).toFixed(2)} (fwd ${f.forward.toFixed(2)}, ${f.n} strikes; frozen ${basis == null ? 'none' : basis.toFixed(2)})`);
    }
    basisLive = esPrice - f.forward;
    basisLiveTs = now();
  }

  // Decide what the day's capture audit / backfill needs. The controller owns the
  // decision and every state mutation; the coordinator owns the broker I/O (the
  // 15:59 close-bar lookup/fetch) and acts on the returned action:
  //   'skip'       -> nothing to do
  //   'applied'    -> state changed via the options-parity audit; broadcast
  //   'wait'       -> hold the grace window; if scheduleMs, retry after it
  //   'need-bars'  -> supply the 16:00 close bars, then call applyBars()
  function planBackfill({ target, esExpiry } = {}) {
    if (!target) return { action: 'skip' };
    // A basis is stale if it's from an earlier day, an estimate, OR was measured
    // against a different ES contract than the one we now stream (the front-month
    // roll jumps the calendar contract ~60–80 pts). esExpiry==null (unknown
    // contract) also re-derives, to be safe.
    const contractStale = !!esExpiry && basisEsExpiry !== esExpiry;
    const current = basisCaptureDate === target.ymd && !basisEstimated && !contractStale;
    if (current && basisAuditDate === target.ymd) return { action: 'skip' }; // captured AND audited

    // Strongest witness first: with a fresh options-implied basis in hand,
    // arbitrate against parity directly — no bar fetch at all (HMDS goes quiet
    // overnight and a silently dead request used to strand the audit).
    if (current && !isRth() && basisLiveFresh()) {
      basisAuditDate = target.ymd;
      if (Math.abs(basisLive - basis) <= C.auditTolerancePts) {
        log(`[ibkr] 4:00 basis audit ok: capture ${basis.toFixed(2)} vs options parity ${basisLive.toFixed(2)} — keeping the capture`);
        return { action: 'skip' };
      }
      log(`[ibkr] 4:00 basis audit OVERRIDE: capture ${basis.toFixed(2)} vs options parity ${basisLive.toFixed(2)} (Δ ${(basis - basisLive).toFixed(2)}) — the live grab likely froze a lagging print; adopting the options value`);
      basis = basisLive;
      basisFrozen = true;
      basisEstimated = false;
      basisCaptureDate = target.ymd;
      if (esExpiry) basisEsExpiry = esExpiry;
      save();
      return { action: 'applied', changed: true };
    }

    // No qualifying chain yet: hold a grace WINDOW (not a one-shot flag — both the
    // SPX and ES seed completions call in seconds apart, and a flag lets the second
    // caller barge through to the bar witness while the chain is still warming). A
    // dead chain (pre-8:15 GTH, weekend) just means the timed retry lands on the
    // 15:59 bars, which is the correct fallback.
    if (current && !isRth()) {
      if (basisAuditWaitUntil == null) {
        basisAuditWaitUntil = now() + C.auditGraceMs;
        return { action: 'wait', scheduleMs: C.auditGraceMs + 1_000 };
      }
      if (now() < basisAuditWaitUntil) return { action: 'wait' }; // inside the window — the timer retries
      // window expired with no qualifying chain → fall through to the bar witness
    }

    if (contractStale) {
      basisEstimated = true; // honest header until the re-derivation below lands
      log(`[ibkr] basis contract roll detected (was ${basisEsExpiry ?? 'unknown'}, now ${esExpiry}) — re-deriving against the current front month`);
    }
    return { action: 'need-bars' };
  }

  // Apply the 16:00 close bars supplied by the coordinator. When a same-day
  // capture exists, arbitrate it against the strongest witness (fresh options
  // parity, else the 15:59 bars); otherwise adopt the bar basis outright. Returns
  // { changed } so the coordinator broadcasts only on a real change.
  function applyBars(target, spxBarClose, esBarClose, how, esExpiry) {
    const barBasis = esBarClose - spxBarClose;
    const haveCapture = basisCaptureDate === target.ymd && !basisEstimated
      && (!esExpiry || basisEsExpiry === esExpiry);
    if (haveCapture) {
      basisAuditDate = target.ymd;
      const optionsFresh = !isRth() && basisLiveFresh();
      const arbiter = optionsFresh ? basisLive : barBasis;
      const witness = optionsFresh ? 'options parity' : `15:59 bars (ES ${esBarClose.toFixed(2)} − SPX ${spxBarClose.toFixed(2)})`;
      if (Math.abs(arbiter - basis) <= C.auditTolerancePts) {
        log(`[ibkr] 4:00 basis audit ok: capture ${basis.toFixed(2)} vs ${witness} ${arbiter.toFixed(2)} — keeping the capture`);
        return { changed: false };
      }
      log(`[ibkr] 4:00 basis audit OVERRIDE: capture ${basis.toFixed(2)} vs ${witness} ${arbiter.toFixed(2)} (Δ ${(basis - arbiter).toFixed(2)}) — the live grab likely froze a lagging print; adopting the ${optionsFresh ? 'options' : 'bar'} value`);
      basis = arbiter;
    } else {
      basis = barBasis;
      basisAuditDate = target.ymd; // freshly bar-derived — no separate audit needed
    }
    basisFrozen = true;
    basisEstimated = false;
    basisCaptureDate = target.ymd;
    basisEsExpiry = esExpiry; // re-derived against the current front month
    esClose = esBarClose;
    spxClose = spxBarClose;
    save();
    log(`[ibkr] 4:00 basis backfilled (${how} bars, ${target.ymd}, ${esExpiry}) = ${basis.toFixed(2)} (ES ${esBarClose.toFixed(2)} − SPX ${spxBarClose.toFixed(2)})`);
    return { changed: true };
  }

  // The public basis fields for the snapshot. 'options' = live chain-anchored,
  // 'frozen' = the 4 PM capture, 'estimated' = cold-start fallback. RTH shows SPX
  // cash directly, so it reports 'frozen'/'estimated' vacuously.
  function snapshot() {
    const fresh = basisLiveFresh();
    return {
      basis,
      basisFrozen,
      basisEstimated,
      basisLive: fresh ? basisLive : null,
      basisSource: !isRth() && fresh ? 'options' : basisEstimated ? 'estimated' : 'frozen',
      esClose,
      spxClose,
    };
  }

  return {
    load,
    ensureOvernight,
    captureFrozen,
    recomputeFromChain,
    planBackfill,
    applyBars,
    effectiveBasis,
    estimatedProxy,
    basisLiveFresh,
    snapshot,
    // Test/introspection helpers — never used to mutate from outside.
    _debugState: () => ({
      basis, basisFrozen, basisEstimated, basisCaptureDate, basisEsExpiry,
      esClose, spxClose, basisLive, basisLiveTs, basisAuditDate, basisAuditWaitUntil,
    }),
  };
}
