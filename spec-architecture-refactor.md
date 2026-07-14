# Spec — architecture refactor without changing the trading contract

**Status:** implementation and architectural reassessment complete 2026-07-14;
final automated and PAPER verification results are recorded below.
**Scope:** the React cockpit, chart engine, IBKR bridge, and their supporting
modules.
**Goal:** make the project safer to test and change while preserving the trading
contract. This is not a rewrite, and a file is never split merely because it is
long.

- Automated suite/build result: **53/53 test files passed; Vite built 95 modules;
  bridge syntax and `git diff --check` passed.**
- PAPER/session-seam result: **the exact build restarted into PAPER and remained
  continuously active across multiple RTH minute/watchdog cycles. It recovered
  live SPX ticks, 82 option rows, three authoritative positions, zero working
  orders, portfolio/execution readiness, unique sorted candles, and IDLE/unlocked
  KILL and REVERSE state. The pass found and corrected a false RTH runaway caused
  by combining SPX+ES bar counts and interleaving history/live startup writes.**
- Orders sent as part of final verification: **none**.

## Reassessment summary

The refactor has already created useful ownership boundaries. The result is not
that every coordinator became tiny; the result is that pure calculations and
safety-critical workflows can now be tested without starting the whole app.

- `src/Chart.jsx` is 845 lines and now functions as a coordinator. Its
  painters, coordinates, viewport persistence, hover/pan behavior, interaction
  intent, marker geometry, and tooltip JSX have real owners. Its armed-placement
  surface belongs to the canvas interaction lifecycle. **Leave it alone.**
- `src/App.jsx` is 1,992 lines. It
  has shed several independent responsibilities, but live position lifecycle and
  financial view-model work remain substantial enough to justify later
  extractions with focused tests.
- `server/ibkr-server.js` is 3,848 lines. Its line count grew during safety
  hardening even while real services
  were extracted. It is partly a coordinator and partly still the owner of three
  tightly coupled domains: basis, home-market subscriptions, and normal-order
  lifecycle.
- `src/styles.css` is a five-line ordered import manifest. The feature CSS totals
  3,053 lines, but another CSS split would currently be cascade churn,
  not an architectural improvement.

These counts are observations, not targets. A larger coordinator can be healthy
when it wires modules together; a smaller file can still be badly coupled when
two modules mutate the same state.

## The coupling test

An extraction is worthwhile only when all of the following are true:

1. It can name one responsibility and one mutable owner.
2. Its inputs, outputs, and events can be made explicit.
3. It removes a dependency between features, enables a focused test, or lets two
   people work safely in parallel.
4. The coordinator imports the new module; the new module does not import or
   reach back into the coordinator.
5. Behavior can be verified at the seam without inventing a second source of
   truth.

Do **not** extract when the result would be:

- a one-effect hook or a wrapper around one callback;
- the same global refs and maps mutated from a different filename;
- IBKR event handling in one file while the state it owns remains in another;
- a WebSocket router that still needs every bridge-local variable;
- JSX or CSS moved only to reduce a line count;
- duplicated protocol or position state during a transition.

In short: moving lines is not decoupling. Moving ownership, with an explicit
contract and tests, is decoupling.

## Trading contract — must not drift during extraction

1. Preserve the two deliberate SPX `MKT` paths: SPX BUY-to-open from the EXECUTE
   ticket when MKT is selected (its current default), and explicitly armed red
   lightning.
2. SELL-to-open and guest orders require a positive `LMT` (which may rest).
   Amber lightning, CLOSE, REVERSE, add, rung, and staged KILL use side-aware
   marketable limits. Attached exits keep native TP=`LMT`, SL=`STP`, and
   TRAIL=`TRAIL` types.
3. BUY uses a fresh ask; SELL uses a fresh bid. One side or a generic heartbeat
   must never make the other side appear fresh.
4. Replay is local practice. It is hidden during SPX cash hours and unavailable
   whenever authoritative or in-flight live risk exists. Current handlers are
   branch-gated away from live senders; capability-level separation remains a
   recommended hardening boundary below.
5. Positions and fills remain IBKR-authoritative. Fill identity is `execId`, and
   reconnect execution backfill remains available.
6. Staged KILL remains server-owned: lock routes, clear automation, read and
   cancel exact working orders, wait for IBKR confirmation, re-read exact
   positions, quote the closing side, submit marketable limits, then verify
   account truth. The browser sends one KILL intent and renders progress.
7. Account and working-order readiness must be confirmed before execution is
   enabled. Recovered orders remain scoped to the selected account.
8. IBKR order IDs and request IDs remain in disjoint namespaces.
9. The overnight basis ladder remains fresh options-implied basis, then the
   frozen simultaneous 4:00 PM capture, then the cold-start seed.
10. Candle buckets continue to derive from `Date.now()`, and a new candle opens
    at its first real tick so session gaps remain visible.
11. Replay dates continue to use local calendar fields rather than UTC fields.
12. The order socket does not gain a client-bundled secret. Its security boundary
    remains the configured network interface, private LAN, or trusted overlay.
13. Guest market-data state remains isolated per browser identity and exact
    symbol/resource identity. A late or foreign guest update must not mutate
    another browser's cockpit.
14. Normal orders reserve a validated `clientRef` before broker submission.
    In-flight refs and the newest 10,000 committed refs block duplicates or
    replay the committed acknowledgement; once submission is uncertain the ref
    is consumed. This registry is process-local, not persisted cross-restart
    idempotency.
15. REVERSE remains one account-bound persisted server transaction: exact close,
    full-fill/flat/public-authority proof, a second fresh target quote, then one
    exact-size target LMT. Partial or uncertain closure never reopens.
16. Reduce-only capacity derives from exact selected-account position truth minus
    every plausible working exposure; browser intent is never sufficient authority
    to cross or reverse a position.

If code contradicts one of these rules, preserve the declared rule—not the bug—
and make the correction as a separately testable safety change.

## Implemented architecture

### Chart: the split is complete

`Chart.jsx` now coordinates one canvas surface rather than implementing every
part of it itself.

Implemented boundaries:

- `src/chart/draw/*` owns individual painters and returns hit lists rather than
  mutating Chart refs.
- `src/chart/coords.js` owns pure price/time/pixel coordinate transforms.
- `src/chart/viewportPersistence.js` owns the persisted zoom/viewport contract.
- `src/chart/interactionIntent.js` resolves ordered click/context-menu intent.
- `src/chart/markerGeometry.js` owns marker hit geometry.
- `src/chart/useChartHover.js` owns hover timing and hover intent.
- `src/chart/useChartPanZoom.js` owns mouse/touch pan and zoom behavior.
- `src/chart/ChartTooltips.jsx` owns chart tooltip JSX.

What correctly remains in `Chart.jsx`:

- the canvas and overlay refs;
- canvas lifecycle, DPR sizing, pane-size observation, invocation of the pure
  layout builders, and draw scheduling;
- assembling painter-ready props and calling painters in visual order;
- routing the already-resolved interaction intents to App callbacks;
- composing chart controls and extracted tooltip surfaces.

Reassessment of the previously proposed Chart extractions:

| Possible responsibility | Decision | Why |
|---|---|---|
| Hover and pinned position-card surfaces | Implemented outside Chart | `PinnedPositionCards` and its pure state model own exact identity, persistence, move/resize/focus/close, z-order, and authoritative resolution. Moving them into Chart would couple a reusable canvas to portfolio-window state. |
| Hover, pan, drag, clicks, bus-stop and marker routing | Extracted where it mattered | Pure intent, hover, and pan/zoom now have focused owners. Chart keeps only orchestration. |
| Candles, quotes, positions and levels transformed for painting | Do not add it to Chart; reassess as an App view model | App already prepares marks, expected move, day levels, and chart positions; Chart aggregates the selected tape, while a few pure painters still perform presentation-specific fallback/label math. A later explicit-input view model could reduce that remaining financial coupling. Moving it into another Chart hook would not. |
| Canvas sizing, DPR and pane geometry | Keep coordinated in Chart | These share one canvas lifecycle and draw loop. The reusable coordinate math is already pure; another hook would mostly pass refs around. |

This is a healthy coordinator. Another split would currently move lines without
reducing coupling, so Chart phase 2 is no longer an open line-count task.

### React application: completed seams

Implemented boundaries include:

- `src/feed-model.js`: pure inbound message reducer, separate from WebSocket and
  React lifecycle in `src/feed.js`;
- `src/app/helpers.js`: stable constants and pure shared helpers;
- `src/app/useCockpitSettings.js`: persisted visual settings and CSS variables;
- `src/app/useReplayController.js`: replay tape, clock, ghosts, and simulated
  position storage, receiving only replay/journal operations;
- `src/app/replayAccess.js`: pure fail-closed replay-risk gate;
- `src/app/useOrderActions.js`: the current action facade for ticket, lightning,
  position, exit, rung, reverse, cancel, and KILL intents;
- `src/order-payload.js`: tested open/quick payload construction and
  side-specific quote freshness;
- `src/app/positionModel.js`: exact contract identity, authoritative position
  reconciliation, execution episodes, closed-chart annotations, and working-
  order presentation reconciliation;
- `src/app/pinnedPositionCards.js` and `src/PinnedPositionCards.jsx`: exact-keyed
  persistent multi-card layout/z-order with live content resolved separately
  from authoritative position truth;
- `src/app/armedPlacement.js`: pure exact-contract-first/trigger-second validation
  and geometry for regular-right-click armed entries;
- `src/app/killAction.js` and `src/app/killDisplay.js`: the browser's narrow KILL
  intent and server-state display contract;
- existing focused hooks for alerts, watchlist, bottom drawer, and hotkeys.

These extractions are already useful. They do not mean `App.jsx` must be made
small at any cost.

### Bridge: completed services and pure seams

The bridge now has named owners for the following responsibilities. Final
integration verification is recorded separately from this architectural list.

| Module | Responsibility it owns | Coupling removed |
|---|---|---|
| `server/http-server.js` | Static files, TLS setup, and safe HTTP routes | HTTP concerns no longer share market/order implementation blocks. |
| `server/candle-series.js` and `server/session.js` | Candle series operations and Eastern-session/expiry rules | Time and bucketing rules can be tested without IBKR. |
| `server/history.js` | Client-requested timeframe, option-premium, and replay history lifecycle: dedupe, cache, timeout/error completion, and targeted publication | Those history requests no longer scatter cleanup across message and IB callbacks; live market seeds remain with their market-data owners. |
| `server/portfolio.js` and `server/portfolio-sync.js` | Selected-account position/funds authority, exact option positions, correlated refreshes, and readiness composition with the separate open-order barrier | Positions and funds have one authoritative service rather than client inference, without pretending that service owns broker working orders. |
| `server/quote-service.js` | Exact contract quote requests, side timestamps, ownership, timeout, and completion | Order/KILL quote consumers no longer borrow unrelated chain request state. |
| `server/id-allocator.js` | Disjoint order-ID and request-ID namespaces | Request errors cannot accidentally be treated as real order errors. |
| `server/order-scope.js` | Selected-account visibility and broker client/order/perm identity | Foreign/unknown recovered orders stay read-only and cannot be guessed into cancellation or KILL authority. |
| `server/order-plan.js` | Fail-closed order validation and pure routing plans | Payload coercion and route decisions are testable before broker placement. |
| `server/order-request-registry.js` | Process-local validation, reserve/commit/release, bounded committed-ref retention, duplicate blocking, and ack replay for exact normal-order `clientRef`s | Concurrent messages and retained replays cannot place a second order, and uncertain submissions cannot be retried blindly. |
| `server/trade-journal.js`, `server/atomic-file.js`, and execution-time helpers | `execId`-based fill projection, persistence, notes/shots, and atomic writes | Journal projection is separate from broker transport. |
| `server/kill-switch.js` | Staged KILL state machine, account anchoring, timeouts, aborts, and final truth decision | The emergency workflow has one transaction owner. |
| `server/kill-order-service.js` | IBKR working-order recovery/cancel confirmation and KILL close submission | Broker callbacks used by KILL are correlated behind an adapter instead of browser loops. |
| `server/routing-lock-store.js` | Atomic, restart-persistent KILL routing lock with fail-closed reads and persist-before-unlock semantics | A process restart cannot silently erase an unresolved emergency lock. |
| `server/reduce-only.js` | Exact selected-account close capacity after all plausible working exposure | Browser intent cannot over-close or silently create the opposite position. |
| `server/position-authority-fence.js` | Correlated agreement between internal and public authoritative position books | Transactions cannot proceed on a stale/private-only flat claim. |
| `server/reverse.js` | Account-bound persisted REVERSE transaction, exact close/full-fill/flat proof, target requote/open, cleanup, and KILL handoff | The browser no longer coordinates a race-prone close-then-open pair. |
| `server/guest-registry.js` | Per-client guest identity, exact resource ownership, generations, capacity, refcounts, and reload grace | One browser can no longer own a process-global guest cockpit by accident. |
| `server/armed.js` and `server/watchlist.js` | Pure armed-trigger validation/crossing rules and watchlist normalization/quote shaping | Malformed input and crossing decisions are testable; the bridge still owns the mutable armed list, firing, and process-wide watchlist poller. |

`ibkr-server.js` still wires the IB API, WebSocket clients, snapshots, and these
services together. That is coordinator work. Its remaining domain blocks are
assessed below.

### Styles: the mechanical split is complete

`src/styles.css` is an ordered import manifest for:

- `foundation.css`
- `chart.css`
- `replay.css`
- `trading.css`
- `responsive-drawers.css`

The names reflect historical growth imperfectly, especially the final two
files. Re-sorting thousands of rules solely to make the filenames prettier
would risk cascade changes and would not improve trading safety. New styles
should follow their owning component/feature, and existing rules should move
only when that component is already being changed and visually verified.

## Recommended later boundaries

These are architectural candidates, not promises to create files. Each should
be implemented only with its focused tests and proportionate runtime
verification.

The pinned position-card manager is implemented and no longer a later boundary.
It stores only exact identity/layout, owns move/resize/focus/close and z-order,
and resolves current content from the authoritative position model.

### Frontend

| Candidate | What it would own | Why separate | What remains in `App.jsx` | Does coupling fall? |
|---|---|---|---|---|
| Position lifecycle reducer/controller | Optimistic pending/closing rows, exact client refs, order-event transitions, attached-exit refs, symbol-aware fill metadata, and reconciliation inputs | Position state is currently written from both App event handling and order actions. One reducer would make transition races testable while keeping IBKR positions authoritative. | Position selection, hover/pin surfaces, drawers, notifications, and composition | **Yes**, if it becomes the only writer of transient local position state. **No** if it mirrors server positions into a second store. |
| Cockpit/position view model | Live/replay/guest source selection, quote freshness, wing caps, mark/Greek choice, day quote, expected move, P/L, and chart-ready positions | This financial transformation is substantial, pure in principle, and currently closes over many App values. | Mode and surface routing plus rendering | **Yes**, if it is a pure explicit-input/explicit-output module with SPX, guest, expired, inactive, and replay tests. |
| Live position-order planner | Pure plans for close, add, reverse, attached exits, and rung, including action-side quotes and exact identity | Open/quick orders already use tested builders; the other money paths still combine planning, sending, toasts, and optimistic UI updates. | Confirmation/UI intent and dispatch of an accepted plan | **Yes**, because broker payload decisions become testable without React or a socket. |
| Separate live and replay action capabilities | Live controller receives a narrow `sendOrder/sendCancel/sendKill/requestQuote` port; replay controller receives only local simulation setters and replay pricing | `useOrderActions` still branches between real and practice behavior. Capability separation makes “replay cannot send” structural instead of conditional. | Choosing which action set is active and passing handlers to surfaces | **Yes**, if the replay module cannot import or receive live senders. Avoid one hook per button. |
| Active-instrument session controller | Exact `{symbol, conId}` intent, per-tab identity/persistence, activation ack, reconnect restoration, pending state, and home transition | With the registry protocol now explicit, frontend identity/reconnect behavior is a substantial independent state machine. | Rendering the returned active instrument and coordinating unrelated UI modes | **Yes**, if callers receive one exact instrument object. A wrapper returning the same scattered booleans would not help. |
| Shared premium-history chart | Canvas sizing/DPR, resize, premium/time geometry, crosshair, zoom, axes, reference lines, and fill markers | `TradeModal` and `PositionModal` contain duplicate canvas engines that have already diverged. | Trade form/risk fields in `TradeModal`; stats/exits and the hover/current-inspect or future card shell in `PositionModal` | **Yes**, especially if geometry is pure and tested and overlays are declarative props. |

Lower-priority frontend ideas that should remain deferred:

- Do not extract the App JSX shell, drawer stack, or Esc priority chain into
  wrapper components merely to shorten the file. App should remain the surface
  coordinator.
- Bus-stop math already has pure helpers. A dedicated state hook is justified
  only if persistence/resolution grows into a larger independent workflow.
- Keep `feed-model.js` as one cohesive snapshot reducer. Add exact resource and
  generation guards there rather than fragmenting every message case.
- Keep `feed.js` as the transport boundary. A common safe-send helper, client
  identity handshake, and stable command port are internal improvements; they
  do not yet require multiple transport files.
- Do not create tiny `useDayLevels`, `useExpectedMove`, or one-effect persistence
  hooks. Those would hide dependencies rather than remove them.

### Bridge

Three remaining bridge boundaries are substantial enough to consider later.

#### 1. Basis controller

It would own:

- options-implied forward samples and quality gates;
- frozen simultaneous ES/SPX capture and atomic persistence;
- cold-start seed selection;
- source freshness, daily reset/roll, and the public basis snapshot.

Why it should eventually be separate: basis is a coherent state machine with
its own fallback ladder and failure modes, and it affects every overnight price.
It is testable with injected clocks and quotes.

What remains in `ibkr-server.js`: subscribe to the required witnesses, pass
ticks/chain samples into the controller, and publish the controller's result.

Coupling falls only if the controller owns all basis state. Moving calculations
while the bridge still mutates basis timestamps, caches, and source flags would
create two owners and be worse.

Verification needed: a PAPER/session-seam window covering 4:00 capture, 16:15
roll, options-basis availability, fallback selection, and restart recovery; an
early-close variant should cover the 13:00/13:15 witnesses when relevant.

#### 2. Home-market data controller

It would own:

- SPX, ES, VIX, SPY, and SPXW subscription lifecycle;
- connection-generation guards and stale callback rejection;
- day/overnight session switches and expiry roll resubscription;
- home chain state and feed-to-candle updates;
- teardown/reconnect of home subscriptions.

Why it should eventually be separate: this is one domain distinct from guest
resources, history, portfolio, and orders. It is also the largest place where
session and connection seams can cross.

What remains in `ibkr-server.js`: IB connection startup, service wiring,
snapshot composition, and publication.

Coupling falls only when the controller receives explicit session/basis inputs
and owns its request IDs and subscription handles. A file containing callback
functions while bridge globals still own their maps would be cosmetic.

Verification needed: connected PAPER data across a real minute boundary and,
when relevant, an RTH/overnight seam; unique sorted candles, correct first-tick
open, correct source, fresh ticks, and clean reconnect.

#### 3. Normal order gateway

It would own the non-KILL broker order lifecycle:

- place/cancel submission after `order-plan.js` accepts a plan;
- exact account and contract anchoring;
- parent/bracket/OCA child construction and records;
- quick-order expiry and auto-cancel;
- normal open-order/order-status/error correlation;
- integration of process-local client-ref reservation/ack replay, any future
  cross-restart dedupe seeding, and the authoritative working-order projection.

Why it should eventually be separate: pure planning is already extracted, but
normal placement records and callbacks still share the bridge. KILL now has a
dedicated broker adapter, proving this can be a real service boundary.

What remains in `ibkr-server.js`: dispatch a validated client command to the
gateway and publish gateway events/snapshots.

Coupling falls only if the gateway owns its order records and callback
correlation. Moving `placeOrder()` into a helper while `ibkr-server.js` still
mutates the order map is not a split.

Verification needed: focused unit tests for every route plus a separately
authorized PAPER order window. Read-only restart verification cannot prove
placement behavior, and this spec does not authorize an order.

#### Boundaries to leave in the bridge for now

- Keep top-level IB connection/probe/reconnect wiring in `ibkr-server.js` until
  all consumers have explicit reset and generation contracts. Extracting it now
  would make every service reach back into bridge globals.
- Keep snapshot assembly and top-level WebSocket dispatch in the coordinator.
  A router file that imports every bridge-local handler would only relocate a
  switch statement.
- Keep service event fan-out near the coordinator unless a service can publish a
  complete domain event without the coordinator reading its internals.
- Keep the armed-trigger and watchlist runtime blocks in the bridge for now.
  Their extracted modules are deliberately pure helpers, not lifecycle owners;
  a real split becomes worthwhile if armed state gains a service lifecycle or
  watchlist polling becomes per-client rather than one process-wide set.
- Do not split one IB callback into an emitter file and its state mutation into
  another file. Callback and owned state belong together.

## Recommended implementation order

1. Extract and test the frontend live position-order planner.
2. Give transient position lifecycle one reducer/controller owner.
3. Extract the pure cockpit/position view model.
4. Separate live and replay action capabilities behind the same UI intents.
5. Extract the shared premium-history chart when the modals next need work.
6. Consider basis, home-market data, and the normal order gateway one at a time,
   each with the required PAPER/session verification window.

The order is intentionally conservative: pure calculations first, then one
mutable owner at a time, then live broker/session services.

## Verification gates

Every coherent extraction must pass:

```text
npm test
npm run build
```

Also run syntax/diff checks appropriate to the touched files. Counts and results
at the top describe the final integrated tree, not an intermediate agent branch.

Bridge/order phases additionally verify:

- malformed payloads fail closed rather than being repaired;
- only the two documented routes can produce an IBKR `MKT` order;
- duplicate retained normal-order `clientRef`s produce at most one broker
  submission and replay the first committed acknowledgement;
- BUY and SELL require their own fresh book side;
- request IDs cannot be confused with order IDs;
- recovered orders and positions belong to the selected account;
- reconnect does not lose cancel, quote, history, or execution bookkeeping;
- KILL remains locked and visible until IBKR truth reaches a terminal result;
- guest updates publish only to the owning browser/resource generation.

UI phases additionally verify in the running application:

- offline state renders without crashing;
- replay remains isolated and exits when live risk appears;
- chart refresh preserves viewport; zoom, pan, markers, tooltips, rays, position
  controls, hover cards, and drawers still work;
- identical visible contracts do not collide across symbols or conIds;
- mobile hides desktop-only replay and lightning controls;
- canvas and CSS changes show no unintended difference.

PAPER verification is proportionate to the seam:

- read-only restart/reconnect checks may verify account authority, positions,
  working orders, funds, executions, fresh ticks, candles, basis, and KILL IDLE;
- no cancel, KILL, or order command is sent during a read-only check;
- placement/cancel behavior requires a separately authorized PAPER order plan.

## Stop conditions

Stop an extraction if:

- an order payload changes without an intentional safety test;
- two modules become competing owners of the same mutable state;
- replay receives a live order capability;
- an IBKR event must be handled in two places to keep state coherent;
- an account, contract, client, or request identity is weakened;
- a canvas or CSS difference cannot be explained and approved;
- the relevant tests, build, or runtime seam fails because of the extraction.

## Definition of done for this refactor series

- Coordinators wire named services and view models rather than duplicating their
  implementation.
- Safety-critical order rules have pure plans and one server-side enforcement
  path.
- Mutable state has one named owner and no accidental mirror.
- Chart remains the current 845-line coordinator unless a new independent
  responsibility genuinely emerges.
- App retains composition and surface routing; later extractions are driven by
  lifecycle and financial-model ownership, not a target line count.
- Bridge follow-ups are performed one live seam at a time with their required
  PAPER verification.
- Final automated and PAPER results are recorded from the exact integrated build.
- The final handoff separates structural changes, safety corrections, and
  intentionally deferred work.
