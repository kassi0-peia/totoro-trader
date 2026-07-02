# Spec — decision replay ("watch my decision-making, with the trades I actually took")

**Goal:** replay a past day with kisa's *real* fills overlaid on the tape at their true
timestamps — so she can re-live the day's context bar by bar and judge her execution
without hindsight. Requested 2026-07-01; builds directly on the journal + replay.

## Data (already shipping)
- The **journal archive** (`server/.journal.json`, ws `{type:'journal'}` →
  `journalResult.days`): every fill with `ts, action, strike, right, expiry, qty, price`,
  keyed by trade date. Archiving is live from 2026-07-02 — the 16:15 blotter roll no
  longer discards history. Older days have no fills to overlay (say so in the UI).
- The **replay tape** (`replayDayResult`): the day's 1-min RTH bars, already trimmed to
  the requested ET date.
- Both already reach the client — v1 is client-only, no bridge changes.

## v1 — ghost fills (passive overlay), ~1–2 h
- When the loaded replay day has journal fills, show a `👣 N fills` toggle in the
  ReplayBar (default ON when fills exist).
- A fill renders only once the replay clock passes its `ts` — no future leakage. Reuse
  the chart's chevron machinery (same bucket math as live markers / `tToIdx`); premium
  and side in the marker tooltip.
- Add a small "tape log" list (fills revealed so far, newest first) beside the replay bar.
- Ghosts are **annotations, not positions**: the replay position simulator stays
  independent, so she can re-trade the day her new way while her old self trades beside her.
- Fills whose `ts` falls outside the session bars (overnight fills on that trade date)
  are footnoted in the tape log as "outside session", not drawn.
- **Blind mystery days: ghosts disabled** — her own fills would date the tape instantly.

## v1.1 — decision points (active mode), ~2 h more
- Toggle "pause at my trades": playback auto-pauses N bars (default 3) **before** each
  historical fill with the ghost still masked, and asks: *what would you do here?*
  (nothing / buy call / buy put — one tap, logged.)
- Resume → reveal the actual fill at its bar; running agreement score in the bar.
- End-of-day recap card: her replayed answers vs the historical actions vs each leg's
  outcome (reuse `dayStats` from `src/Journal.jsx` for the leg P/L math).

## Edge cases
- Multiple execs per order (partials): one ghost per fill row, same as live markers.
- Days with positions recovered but no blotter (pre-journal): no ghosts, honest note.
- Trade date vs calendar date: journal keys roll at 16:15 ET like the blotter; the
  replay day is an RTH session, so match `journal[date]` where `date` = the replayed ymd.

## Test plan
1. Trade a few contracts live, then replay the same day: ghost timing must match the
   blotter times; nothing visible before its bar.
2. v1.1: verify the pause lands N bars before the fill with the ghost masked, and the
   recap card's leg P/L matches the Journal's numbers for that day.
3. Blind mystery day: confirm no ghosts and no fill-count hint leak.

Desktop-only (replay already is). No new persistence, no order-path surface.
