import React from 'react';
import totoroUrl from './totoro.png';

// Totoro mascot rendered from totoro.png. CSS handles the breathing + trade pulse.
export default function Totoro({ pulse = false }) {
  return (
    <div className={`totoro-wrap${pulse ? ' pulse' : ''}`} aria-label="Totoro mascot">
      <img className="totoro-img" src={totoroUrl} alt="Totoro mascot" draggable="false" />
    </div>
  );
}
