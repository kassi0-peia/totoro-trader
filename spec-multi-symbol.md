# Spec — exact per-browser guest instruments

**Status (2026-07-14):** guest charting, execution, watchlist UI/polling,
per-tab recovery, and bridge-side guest ownership are implemented. Runtime
verification is not claimed here; this document describes the protocol and its
limits.

**Goal:** keep SPX as the home cockpit while a browser tab can choose one exact
US-stock contract and use its stock chart, near-ATM option chain, nearest listed
expiry, quotes, greeks, history, and limit-only option tickets. A symbol string
alone is never enough to own or route a guest.

## Non-negotiable rules

1. The SPX session, ES proxy, basis ladder, candle watchdog, and roll rules stay
   independent of guest state.
2. A guest order is always a positive `LMT`; no guest path can emit `MKT`. The
   user may leave that limit resting—it is not required to cross the book.
3. The bridge validates the strike and expiry against the exact discovered
   resource before constructing an option contract.
4. Guest state is scoped by browser identity, exact `{symbol, conId}` resource,
   and resource generation. A late or foreign packet is discarded.
5. One distinct guest resource is the current market-data capacity. Several tabs
   may share that exact resource; a different one receives `CAPACITY`.
6. While guest market-data startup/streaming is active, the line-heavy SPXW
   chain pauses for every browser. SPX/ES/VIX, account truth, and basis fallbacks
   keep running.
7. Never test this feature by casually sending an order. Builds/unit tests are
   safe; bridge restarts and PAPER orders require their own authorization.

## Browser identity and protocol

`src/feed.js` creates a random per-tab client identity in `sessionStorage`. On a
socket connection it sends `clientHello`; the bridge acknowledges before guest
senders become available. A duplicated tab initially inherits the same storage,
so the registry rotates colliding live identities rather than merging two sockets.

The main client messages are:

- `clientHello {clientId}`
- `symbolSearch {q}`
- `activateSymbol {requestId, symbol, conId}`
- `deactivateSymbol {requestId}`
- guest `order`, `quote`, and `optHistory` requests carrying the selected symbol
  (and exact conId where that request shape supports it)

An active resource has an exact key such as `SPY|756733` and a monotonically new
`resourceGeneration`. Targeted guest envelopes carry both. `src/feed-model.js`
accepts them only when they match the tab's acknowledged resource and generation.
This fences callbacks that arrive after a deactivate/reactivate or reconnect.

## Registry ownership

`server/guest-registry.js` is the single owner of:

- socket ↔ client identity and handshake generation;
- exact resource keys, owners, refcounts, startup state, and capacity;
- activation request correlation and targeted acknowledgments/errors;
- a 2.5-second disconnected-tab grace lease for ordinary reloads;
- final resource teardown after the last owner releases;
- tests that reject stale generations and foreign publication.

Two tabs that request the same `{symbol, conId}` share subscriptions and receive
their own targeted messages. Releasing one does not tear down the other's resource.
If a tab requests a different exact guest while capacity is occupied, its current
cockpit is not silently stolen or replaced.

## Resource lifecycle

After an accepted activation, `server/ibkr-server.js`:

1. resolves the exact stock contract;
2. requests stock ticks and two days of 1-minute history into a guest candle
   series with its own generation guards and watchdog;
3. requests option parameters for the exact underlying conId;
4. chooses the nearest **listed** non-expired option date (not necessarily a
   weekly), derives the real strike step, and streams a narrow near-ATM window;
5. recenters the window as the stock moves;
6. targets guest snapshots/ticks/greeks/history only to current owners.

The globally shared SPXW chain is paused once the first guest's exact stock
contract resolves and guest subscriptions begin, then restored only after the
final guest resource stops. Overnight this can temporarily remove the
options-implied basis input; `basisSource` honestly falls through to the
frozen/estimated ladder.

## Frontend state

`App.jsx` keeps SPX as the default. It persists only a confirmed exact guest intent
in `sessionStorage`, then restores it after the socket hello and bridge-live
readiness signals. During activation, guest ordering is unavailable; the SPX
cockpit is not relabelled as if the new resource were already ready.

When confirmed, the active instrument supplies its own:

- symbol, underlying price, tick timestamp, candles, expiry, and strike step;
- option greeks/quotes and premium-history keys;
- exact conId, resource key, and generation for frozen ticket identity.

Ticket identity is captured when the modal opens. A later symbol/expiry/resource
switch cannot retarget it. Execution rechecks the current exact resource and asks
the user to reopen a stale ticket.

Guest mode hides or disables SPX-only behavior: replay, bus stops, rung, day
levels, armed SPX triggers, and naked-MKT lightning. It does calculate a guest
expected-move band from that guest's prior close and near-ATM straddle; unlike
SPX 0DTE, the width is priced to the selected listed expiry. The ⚡ control
cycles `off ↔ amber` for a guest, so red is unreachable. Amber still needs a
fresh ask and sends a marketable `LMT`; the ordinary guest ticket accepts any
valid positive limit. Current behavior does not add a separate toast merely for
skipping red in that cycle.

Positions, marks, fills, chart overlays, and premium-history keys include symbol
and expiry so visually identical contracts do not collide. Inactive guest
positions remain visible in the portfolio, but their close/add/exit actions fail
visibly until the matching guest session and expiry are active; no SPX fallback
is allowed.

## Watchlist

The watchlist UI is frontend-owned, persisted in `localStorage`, normalized by
`server/watchlist.js`, and refreshed with slow one-shot stock snapshots. It does
not allocate a second streamed option chain and does not grant order authority.

Its bridge-side polling state is **not per tab**: the bridge currently keeps one
process-wide list, the latest wholesale `watchlist` message replaces that list,
and `watchlistQuotes` is broadcast. Tabs on the same origin normally share the
same persisted list, but two devices with different lists can overwrite one
another's bridge poll set. This is separate from the exact guest registry and is
a deliberate current limitation, not an order-routing authority leak.

## Verification

Automated coverage includes guest expiry/strike math, registry capacity/refcounts,
duplicate identities, reload grace, stale-generation rejection, history ownership,
feed reducer fencing, exact ticket persistence, and order validation. The standard
checks are:

```text
npm test
npm run build
node --check server/ibkr-server.js
```

Manual two-browser checks, when a bridge window is authorized:

1. Open the same exact guest in two tabs; both stream one shared resource.
2. Release one tab; the other continues without a generation change.
3. While SPY is owned, request a different guest from another tab; it receives
   `CAPACITY` and neither cockpit is silently mutated.
4. Reload a guest tab inside the grace window; it resumes the exact resource.
5. Rapidly switch away and back; delayed packets from the old generation do not
   alter price, greeks, history, or ticket identity.
6. Return the final tab to SPX; the home chain restores once, without duplicate
   subscriptions.

A separately authorized PAPER order check should use a small positive guest LMT,
verify the exact symbol/conId/expiry at IBKR, and confirm fills/positions remain
symbol-scoped. This spec itself does not authorize that order.

## Deliberate limits

- one distinct streamed guest resource at a time (same-resource sharing allowed);
- US-stock underlyings only;
- no guest replay, bus stops, rung, day levels, armed SPX triggers, or naked MKT;
- guest option streaming yields the global SPXW chain while active;
- one process-wide watchlist poll set (latest wholesale update wins);
- phone search remains secondary to the desktop cockpit.
