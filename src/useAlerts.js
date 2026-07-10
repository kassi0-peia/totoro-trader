import { useEffect, useRef, useState } from 'react';
import { crossed } from './alerts.js';
import { chimeAlert } from './sounds.js';

// ⏰ one-shot price alerts (kisa, 2026-07-09): armed from the chart's
// right-click menu, drawn as dashed lines only while armed, removed the
// moment the live tape crosses (toast + chime). Zero resting chrome — the
// line IS the feature. Persisted so a reload doesn't disarm the night's
// levels; SPX alerts watch the SPX-equiv price, so they work overnight too.
//
// Owns the alerts array (+ its localStorage persistence) and the crossing
// effect; returns [alerts, setAlerts] so the cockpit can draw them and arm/
// disarm from the chart menu. The live tape (feedPrice/guestPrice), the active
// symbol/guest flags, and showToast come in as parameters.
export default function useAlerts({ feedPrice, guestPrice, guestActive, activeSymbol, showToast }) {
  const [alerts, setAlerts] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem('tt.alerts') || '[]');
      if (Array.isArray(v)) return v.filter((a) => a && typeof a.symbol === 'string' && Number.isFinite(a.price));
    } catch {}
    return [];
  });
  useEffect(() => {
    try { localStorage.setItem('tt.alerts', JSON.stringify(alerts)); } catch {}
  }, [alerts]);

  // Fire ⏰ alerts on a live crossing. SPX alerts check feedPrice (the
  // SPX-equiv proxy overnight — "ping when SPX-equiv crosses X"); a guest's
  // alerts can only fire while that guest is active (its price only streams
  // then). First tick after load primes the previous price without firing.
  const alertPrevRef = useRef({});
  useEffect(() => {
    const tapes = [['SPX', feedPrice]];
    if (guestActive && guestPrice != null) tapes.push([activeSymbol, guestPrice]);
    for (const [sym, px] of tapes) {
      if (px == null) continue;
      const prev = alertPrevRef.current[sym];
      alertPrevRef.current[sym] = px;
      if (prev == null || prev === px) continue;
      const hits = alerts.filter((a) => a.symbol === sym && crossed(prev, px, a.price));
      if (!hits.length) continue;
      setAlerts((list) => list.filter((a) => !hits.some((h) => h.id === a.id)));
      for (const h of hits) showToast(`⏰ ${sym} crossed ${h.price.toFixed(2)}`, 'ok');
      chimeAlert(); // the dedicated alert blip — one soft low note, not the fill chime
    }
  }, [feedPrice, guestPrice, guestActive, activeSymbol, alerts]); // eslint-disable-line react-hooks/exhaustive-deps

  return [alerts, setAlerts];
}
