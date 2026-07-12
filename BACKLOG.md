# Backlog — pitched, not built

Idea inventory from the July 2026 sprints (kisa: "leave a list somewhere").
Nothing here is committed-to; the roadmap lens is **in-the-moment trading**
(reduce friction/latency during the trade) + the clutter rule (no new resting
cockpit chrome — hover/popover/keyboard/drawer/bridge only). Items graduate
out of this file into commits; strikethrough = rejected, with the why.

## Small (an evening or less)
- **Bracket presets** — one chip arms her standard TP/SL (e.g. +30%/−50%) computed off fill price; stop typing exits per ticket.
- **Fill latency stamp** — send→fill ms in the fill toast (both timestamps already exist client-side); sibling of the shipped fill-quality delta.
- **Kill-switch hotkey** — chord (e.g. Shift+Esc ×2) = cancel all working + close all at marketable limits; keyboard for the shaking-hand moment.
- **Setup tags** — `N` notes parse hashtags (#paw #fade); journal history shows win-rate per tag (Edgewonk's core, one regex away).
- **Close half** — ½ button on position rows: sell floor(qty/2) as marketable limit; ladder traders trim.
- **Theta clock** — position rows show time-in-trade + est. theta burned since entry.
- **Wide-market warning** — quiet amber on the ticket when spread > ~25% of premium ("mid is a guess, the fill won't be").
- **`?` shortcuts overlay** — self-documenting keys/gestures; features stop depending on anyone's memory (proven need: rediscovered own launcher + legend).
- **Post-fill note nudge** — fill toast hints "N: why?" to feed the journal.
- **Equity curve vs buy-and-hold** — one benchmark line on the existing journal curve (TraderVue).
- **Quote size on hover card** — show bid/ask SIZES (IBKR streams them): liquidity read before entry (Bookmap-lite).
- **Basis-confidence tint** — dim/tint the ES/SPX label when basisSource degrades below options-implied; estimates must dress like estimates.
- **Journal → CSV export** — ⤓ in history view; fills + notes, spreadsheet-ready.
- **IV rank chip** — VIX percentile vs trailing months (needs daily VIX history accumulation bridge-side) (thinkorswim).

## Medium (a session)
- **MFE/MAE** — record max favorable/adverse excursion per position from the live mark stream; journal rows show "peaked +45%, exited +12%" (Edgewonk/Tradezella; the exit-tuning stat).
- **R-multiples** — with stops recorded, journal P/L in risk units (+2.1R); needs SL capture per trade (Edgewonk).
- **Risk-based auto-sizing** — ticket mode: enter $risk + stop → qty computed (prop discipline).
- **Replay scorecard** — end-of-replay card: trades, P/L, win rate, and what the day did after you stopped.
- **Film review** — ▶ on any journal day → replay that day with her ACTUAL fills as ghosts (wires existing decision-replay ghosts + journal). High payoff/LOC.
- **Hour-of-day stats** — journal P/L bucketed by hour; "when do I actually make money."
- **Payoff what-if panel** — hover the book: P/L at SPX ±10/±20 from net delta+gamma (thinkorswim Analyze).
- **Event lines on the time axis** — FOMC/CPI as dashed verticals ahead on today's chart (needs a calendar source; manual/env v1).
- **Morning digest** — first connect of the day: fills/alerts/P-L that happened while away (or via Discord webhook).
- **Daily loss guardrail (soft)** — banner/red-glow when day P/L crosses −$X; the truth, loudly, no blocking.
- **Discord webhook** — bridge posts fills to her channel; blocked only on a webhook URL from kisa. (Original roadmap #4.)
- **P/L calendar heatmap** — the journal month view (original roadmap wording; journal shipped without it).
- **Volume profile** — volume-at-price histogram from 1-min SPY-proxy bars, opt-in overlay like EM; right shape/nodes, RTH-only, honest-estimate labeling. (Sierra/Bookmap genre.)
- **Guest replay / bus stops / mobile search** — multi-symbol parity leftovers (spec-multi-symbol out-of-scope list).

## Big (dedicated session, order-path care)
- **Vertical spreads** — click strike + short leg N out → one IBKR combo (BAG) order; defined-risk debit spreads; new position math. The "v2" feature.
- **Drag working orders on the chart** — TP/SL/limit lines grabbable; release = modify at IBKR (Sierra/Ninja chart-trading; the crown jewel; pure chart-as-chain).
- **OCO entry pairs** — two entries, first fill cancels the other; straddle a forming paw (EdgeProX/Ninja server-side OCO).
- ~~Conditional entry release~~ — ✅ shipped 2026-07-11 as **armed orders** (design B, bridge-side: fires a fresh marketable limit at the live ask on crossing; qty-1/max-3/one-shot/never-MKT/10s-mortal). The robot line was crossed knowingly, with rails.
- **Hard lockout** — bridge-enforced max daily loss: flatten + freeze until tomorrow (EdgeProX account-level risk). Before serious live.
- **Auto-flatten at time** — "flatten at 15:55" bridge cron; 0DTE settlement-roulette dodge.
- **PIN (order-path auth)** — typed-once per device, never served with the bundle; before sustained live trading.
- **Phone push for alerts** — PWA Web Push via the bridge. Deprioritized 2026-07-11: kisa trades in the moment, not levels.

## Robot line (auto-acting software — needs its own conversation first)
- **Auto-breakeven / ATM templates** — stop moves to entry at +X automatically (NinjaTrader ATM). Most defensible robot; still a robot.
- **Chase** — reprice an unfilled quick order once before cancelling. v1 shipped as cancel-only on purpose.

## Research
- **Detector report card** — backtest totoro-detector calls over journal/replay days; precision per pattern. The un-shelving evidence (detector SHELVED as inaccurate, kisa 2026-07-10).

## Rejected (the why matters)
- ~~Drawing tools~~ — kisa 2026-07-09: not her style (fast 0DTE momentum, not multi-day lines).
- ~~DOM ladder / order-flow footprints~~ — needs tick data the line budget can't feed; grid-of-numbers is what the chart-as-chain thesis exists to kill.
- ~~Alert descendants (push, level tooling)~~ — kisa 2026-07-11: "i trade in the moment." Alerts stay (zero chrome), nothing builds on them.
- ~~License file~~ — deliberately none: all-rights-reserved protects the trading system.
