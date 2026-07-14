# Spec — architecture refactor without changing the trading contract

**Status:** active plan  
**Scope:** `server/ibkr-server.js`, `src/App.jsx`, and `src/styles.css`. The
completed painter split in `src/Chart.jsx` remains intact; its optional phase-2
interaction split is not required by this plan.  
**Goal:** make the project easier to understand, test, and change while keeping
the live trading contract stable at every step.

This is not a rewrite. The running application must remain usable after every
extraction. A module is split because it owns one responsibility, not merely
because a file has many lines.

## Why this work exists

The project is a manageable size, but most behavior is concentrated in four
files. That makes unrelated features share state and makes a small change hard
to review. The refactor gives safety-critical behavior a clear owner and leaves
the top-level files as coordinators.

Current starting point (2026-07-13):

| File | Approx. lines | Intended end state |
|---|---:|---|
| `server/ibkr-server.js` | 3,131 | bridge startup and service wiring |
| `src/App.jsx` | 2,020 | React composition and top-level UI routing |
| `src/Chart.jsx` | 1,177 | completed painter split; optional work deferred |
| `src/styles.css` | 2,782 | ordered imports of feature styles |

## Trading contract — must not drift during extraction

1. Preserve the two deliberate SPX `MKT` paths: BUY-to-open from the EXECUTE
   ticket when MKT is selected (its current default), and explicitly armed red
   lightning.
2. SELL-to-open, guest orders, amber lightning, CLOSE, REVERSE, attached exits,
   and the kill switch remain limit-only and keep their existing quote guards.
3. Replay and quick mode remain desktop-only. Replay cannot reach the live order
   path.
4. Positions and fills remain IBKR-authoritative. Fill identity is `execId`, and
   reconnect execution backfill remains available.
5. The overnight basis ladder remains fresh options-implied basis, then the
   frozen simultaneous capture, then the cold-start seed.
6. Candle buckets continue to derive from `Date.now()` rather than trusting a
   running edge.
7. Replay dates continue to use local calendar fields rather than UTC fields.
8. The order socket does not gain a client-bundled secret. Its security boundary
   remains the network interface or trusted overlay.
9. Existing WebSocket message types and payload fields remain compatible until
   a separately specified protocol change is made.

If the current implementation contradicts one of these rules, preserve the
declared rule—not the bug—but make that correction in a clearly separated
safety change with its own tests.

## Refactor rules

- One responsibility per extraction.
- No drive-by renaming or visual cleanup inside a structural change.
- Add a test around a seam before or with the move when the behavior can be
  tested without IBKR.
- Do not duplicate mutable state between old and new modules. One owner remains
  authoritative throughout each phase.
- Dependency direction points inward: coordinators may import services and pure
  helpers; services do not import the coordinator.
- Keep external message shapes stable. Internal APIs may be introduced behind
  them.
- Run `npm test` and `npm run build` after every coherent extraction.
- Canvas and CSS changes require running-app verification; a successful build
  alone is not enough.

## Target responsibilities

The filenames below describe ownership. They are a guide, not a requirement to
create every file in one pass.

### Bridge

```text
server/
  ibkr-server.js          process startup and service wiring
  http-server.js          static/TLS server and safe file routes
  market-data.js          SPX, ES, VIX, SPY and option subscriptions
  candle-series.js        candle bucketing and series operations
  basis.js                live/frozen/cold-start basis state
  history.js              historical request lifecycle and caches
  orders/
    validate.js           fail-closed order validation
    contracts.js          IBKR contract construction
    route.js              place/cancel lifecycle and quick expiry
  portfolio.js            account, funds, positions and working orders
  executions.js           execution backfill and execId deduplication
  journal.js              persistence and journal projections
  websocket.js            message dispatch and broadcast transport
```

The first bridge extractions should be modules with narrow inputs and little or
no mutable state. Connection event wiring and shared market-data state move only
after their ownership is explicit.

### React application

```text
src/
  App.jsx                         composition and surface routing
  app/
    helpers.js                    pure symbol/date/position helpers
    useReplayController.js        replay clock and simulated positions
    useOrderActions.js             trade submission and quote gates
    usePositionActions.js          add/close/reverse orchestration
    useArmedOrders.js              armed-order UI synchronization
```

Hooks receive their dependencies as arguments. They do not import the live feed
singleton or silently create a second source of truth.

### Chart

The painter split in `spec-chart-split.md` is complete. Do not reopen it as part
of this refactor. Its optional phase 2 (view/layout, interaction, and tooltip JSX)
requires deterministic replay screenshot verification and should be a separate
decision after the bridge and app coordinators are smaller.

### Styles

```text
src/styles/
  foundation.css          reset, variables, typography and shared controls
  layout.css              shell, header, chart and drawers
  trading.css             positions, tickets, quotes and order states
  replay.css              replay bar, calendar, ghosts and bus stops
  responsive.css          media queries, kept last
```

`src/styles.css` becomes an ordered import manifest. The original rule order is
preserved during the split so CSS specificity and cascade behavior do not change.

## Phased implementation plan

### Phase 0 — baseline and safety net

- Record current file sizes and the existing test/build result.
- Add focused tests for new pure seams.
- Keep the order-routing matrix that locks the declared market/limit contract.
- Keep safety corrections separate from structural moves in the diff.

### Phase 1 — low-risk pure extraction

- Extract app-level pure helpers.
- Extract server candle/time/contract helpers where inputs are explicit.
- Reuse the helpers from the original coordinators.
- Verify identical results with unit tests.

### Phase 2 — bridge services

- Extract the static HTTP/TLS server.
- Centralize order validation and contract construction before moving placement.
- Extract journal persistence and execution projection.
- Move historical request bookkeeping into a service with explicit completion,
  error, and timeout cleanup.
- Move market-data services last because they share the most live state.

### Phase 3 — App coordinator

- Extract replay state and actions.
- Extract normal and quick order actions.
- Extract position add/close/reverse actions.
- Extract armed-order synchronization.
- Leave `App.jsx` responsible for selecting live versus replay data and composing
  visible surfaces.

### Phase 4 — CSS

- Move contiguous sections without editing individual declarations.
- Import feature files in their original order.
- Compare desktop and sub-720 px layouts, tooltips, drawers, modals, replay, and
  all lightning states.

## Verification gates

Every phase must pass:

```text
npm test
npm run build
```

Bridge/order phases additionally verify:

- each client message reaches the same handler;
- malformed payloads fail closed;
- only the two documented paths can produce an IBKR `MKT` order;
- recovered fills remain deduplicated by `execId`;
- reconnect does not lose cancel or history bookkeeping.

UI phases additionally verify in the running application:

- offline state renders without crashing;
- deterministic replay paints and remains non-live;
- chart zoom, pan, markers, tooltips, position controls, and drawers work;
- mobile hides replay and quick-mode controls;
- CSS and canvas screenshots show no unintended difference.

## Stop conditions

Stop the current extraction and restore the last passing structure if:

- an order payload changes without an intentional safety test;
- two modules become competing owners of the same live state;
- replay can invoke a live feed action;
- an IBKR event must be handled in two places to keep behavior working;
- a canvas or CSS difference cannot be explained and approved;
- tests or build fail for reasons introduced by the extraction.

## Definition of done

- The four coordinator files no longer contain unrelated implementation blocks.
- Safety-critical order rules have one server-side enforcement point.
- Mutable state has a named owner and is not mirrored accidentally.
- The completed chart painter split remains unchanged; its optional phase 2 is
  explicitly deferred.
- Tests and production build pass.
- The running app is verified offline and in replay; live-only verification is
  documented if it cannot be exercised safely.
- The final handoff lists structural changes separately from behavior fixes.
