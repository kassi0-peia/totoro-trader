# Spec — splitting Chart.jsx (the god-file), the SAFE way

**Goal:** carve `src/Chart.jsx` (~1640 lines after bus stop) into small, pure modules
without changing a single rendered pixel or interaction. This is a refactor where the
cost is **verification, not code** — a passing build does NOT prove the canvas paints.
Agreed with kisa 2026-06-22 (the prune session); planned in detail 2026-07-05.

## Ground rules (non-negotiable)
1. **One extraction per commit.** Small steps, trivially revertable, bisectable.
2. **Eyeball the RUNNING chart after every step** — candles, grid, labels, markers,
   hover, click. Build success proves imports resolve, nothing more.
3. **Zero behavior change.** No renames of props, no "while I'm here" cleanups, no
   logic fixes. If a bug is found mid-split, note it, finish the step, fix separately.
4. **Painters become pure functions that RETURN hit-lists** instead of mutating the
   component's refs. The draw effect assigns `markerHitsRef.current = ...` from the
   return value. This is the one allowed shape change — it's what makes the modules
   testable and is invisible from outside.
5. Schedule: a focused **2–3 h block, ideally during market hours** (live candles,
   an open position, streaming chain = everything paints). Off-hours fallback:
   **replay mode is the test harness** — a loaded replay day gives candles, sim
   positions, markers, and ghosts without real money. Overnight GTH works too
   (ES-proxy bars + live chain exercise the dimming and axis-chain paths).

## Current anatomy of Chart.jsx (line refs at commit 0d03870)
- **1–68** module constants + pure formatters (`fmtPrice`, `fmtTimeTf`, `fmtTime`,
  `niceStep`, `priceDecimals`, `niceTimeStep`, `fmtVol`, step tables, zoom constants)
- **70–235** component state/refs, `tfCandles` memo, resize observer
- **236–337** `view` (slots/range/pan/zoom) + `layout` (pixel boxes) + `priceToY` /
  `yToPrice` / `indexToX`
- **338–891** THE DRAW EFFECT (~550 lines): grid+axes → ITM shading → candles →
  ES-proxy badge → volume → live price line → expected move → axis-as-chain →
  position lines (+ hit boxes for `+`/`✕`/label) → trade markers (`tToIdx`,
  `drawChevron`) → decision-replay ghosts → bus stops 🚏
- **893–1003** wheel zoom, touch/pinch, timeframe reset, screen-record clip
- **1004–1240** `updateHover` (hit-tests, crosshair, quote nudging), drag/momentum/
  pan/zoom (`handleDragMove`, `startDrag`, `endDrag`, `snapToNow`), pointer handlers
- **1241–1330** `handleClick` (hit-test cascade → trade click / bus drop)
- **1331–1637** JSX: OHLC legend, canvas, tooltips (bus / ghost / position / strike
  hover), crosshair readouts, overlay buttons

## Target structure
```
src/chart/
  format.js        pure formatters + step tables (no canvas, no React)
  coords.js        tToIdx factory + (phase 2) buildView / buildLayout
  draw/
    grid.js        h/v gridlines, price + time axis labels (axisChain label mode too)
    candles.js     ITM shading, candle bodies/wicks, ES-proxy dimming + badge, volume
    priceline.js   dashed live price + axis chip, expected-move band
    axisChain.js   right-gutter call/put premiums
    positions.js   position dashed lines + label/+/✕ chips → returns {close,add,label} hits
    markers.js     drawChevron, trade entry/exit markers + connectors, ghosts → returns hits
    busstops.js    🚏 markers + guide lines → returns hits
Chart.jsx          state, view/layout, the (thin) draw effect, interaction, JSX
```
Every painter has the same signature shape:
`draw<Thing>(ctx, env) → hits?` where `env` is a plain object of exactly what it
reads (`{ view, layout, theme, priceToY, indexToX, ... }`). No painter imports React.

## Extraction order (lowest risk → highest, one commit each)
| # | Move | Verify by eyeballing |
|---|------|----------------------|
| 1 | `format.js` (pure fns + TICK/TIME_STEPS) | axis labels (price decimals, 1h time labels, volume "1.2M") |
| 2 | `draw/grid.js` | gridlines + both label modes (axisChain ON moves prices left onto strike steps) |
| 3 | `draw/candles.js` | candles, ITM tint with an open position, ES-proxy dim + "ES est." badge, volume pane toggle |
| 4 | `draw/priceline.js` | dashed price line + right-axis chip, ±EM lines |
| 5 | `draw/axisChain.js` | premiums beside strikes, model fallback for far strikes |
| 6 | `draw/positions.js` | position lines colored by P/L; `+` adds, `✕` closes, label chip hover-opens the card (hits returned, refs assigned in Chart) |
| 7 | `coords.js` (`makeTToIdx(tfCandles, view, bucketMs)`) + `draw/markers.js` | entry chevrons hug each fill's bar, exit `v`, dotted connector, ghost kites + tooltips, click-to-pin still works **including on the overnight seam** (the binary-search gap fix must survive the move) |
| 8 | `draw/busstops.js` | 🚏 marker + dashed guide, future-space extrapolation, off-edge → arrow, click opens timetable |
| 9 | assert the draw effect is now ~80 lines of `hits = drawX(ctx, env)` calls; final full sweep | everything above once more, then mobile width (buttons hidden, no stray layers) |

Steps 1–5 are pure-paint (no hit-lists) — lowest risk. 6–8 carry the hit-list
conversion — do them fresh, not at the end of a long session.

## Phase 2 (separate session, optional)
- `buildView` / `buildLayout` as pure functions in `coords.js` (they're IIFEs today;
  extraction is mechanical but touches pan/zoom state wiring — keep it out of phase 1).
- `usePanZoom` hook (drag/momentum/pinch/wheel) — the riskiest move; only if Chart.jsx
  still feels too big after phase 1 (~700 lines expected).
- Tooltip JSX → `ChartTooltips.jsx`. Cosmetic; cheap any time.

## Verification harness (objective, not just eyeball)
With the bridge up, replay is deterministic → pixel-diffable:
1. Load a fixed replay day, pause at a fixed bar idx, fixed viewport.
2. Screenshot the canvas before the split starts → `scratchpad` baseline.
3. After each step, re-screenshot, `pixelmatch` against baseline — must be 0 diff
   (same theme, same machine; the canvas is fully deterministic in replay).
4. Live-only paths replay can't cover (axis chain premiums, EM band, bus stops,
   ES-proxy dimming) stay on the eyeball checklist above.

## Traps (learned the hard way / spotted in advance)
- **`tToIdx` closes over `view.baseIdx` and `bucketMs`** — it must be rebuilt per
  draw, not memoized across frames. Factory pattern: `makeTToIdx(tfCandles, view,
  bucketMs)` called inside the effect.
- **Draw order is z-order.** The call sequence in the effect is the layering
  contract (grid under candles under lines under markers). Keep the calls in the
  exact current order; document it with a comment block in the slim effect.
- **Hit-list order matters too**: `updateHover`/`handleClick` test markers → ghosts →
  bus stops → label chips, and click-swallowing depends on it. Don't reorder.
- **`ctx.save()/restore()` hygiene**: several painters set alpha/dash/font and restore.
  When moving code, make sure each module leaves ctx clean — an unbalanced save leaks
  state into the NEXT painter and shows up as "everything after X went dim/dashed".
- The effect's dep array must keep every input the moved painters read (it currently
  lists ~20 deps). Removing one "unused-looking" dep = stale paints that only show
  up live, not in a build.

## Done means
- `npm run build` green, all eyeball checks pass, pixel-diff 0 on the replay baseline.
- Chart.jsx ≤ ~750 lines; no module over ~200; painters import zero React.
- One commit per step already in history (no squash — the trail is the safety net).
