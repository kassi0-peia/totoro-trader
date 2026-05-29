import React from 'react';
import totoroUrl from './totoro.png';

// Totoro mascot from totoro.png. CSS tints it with the theme accent (a masked
// blend layer) and handles the breathing + trade pulse.
export default function Totoro({ pulse = false }) {
  return (
    <div
      className={`totoro-wrap${pulse ? ' pulse' : ''}`}
      style={{ '--totoro-src': `url(${totoroUrl})` }}
      aria-label="Totoro mascot"
    >
      <img className="totoro-img" src={totoroUrl} alt="Totoro mascot" draggable="false" />
    </div>
  );
}
