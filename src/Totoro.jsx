import React from 'react';

// Totoro mascot. Mood and ear state drive small attribute swaps; CSS handles breathing + pulse.
export default function Totoro({ mood = 'calm', earsUp = false, pulse = false, theme }) {
  const body = '#6b7280';
  const bodyDark = '#4b5563';
  const belly = '#e9e9ec';
  const eyeWhite = '#f5f5f7';
  const eyeDark = '#1a1a22';

  // mouth path
  let mouth;
  if (mood === 'happy') {
    mouth = 'M 26 48 Q 32 55 38 48';
  } else if (mood === 'sad') {
    mouth = 'M 27 52 Q 32 46 37 52';
  } else {
    mouth = 'M 29 50 Q 32 51 35 50';
  }

  // worried eyes: lower position, narrower verticals
  const eyeY = mood === 'sad' ? 40 : 38;
  const eyeRy = mood === 'sad' ? 1.8 : 2.8;
  const eyeRx = mood === 'sad' ? 3.0 : 2.6;

  // ears perk: more visible tilt, narrower stance
  const earTransform = earsUp ? 'translate(0,-3) rotate(-10 32 18)' : 'rotate(0 32 18)';

  return (
    <div className={`totoro-wrap${pulse ? ' pulse' : ''}`} aria-label="Totoro mascot">
      <svg
        className="totoro-svg"
        viewBox="0 0 64 64"
        width="44"
        height="44"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <radialGradient id="bellyG" cx="50%" cy="55%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="100%" stopColor={belly} stopOpacity="1" />
          </radialGradient>
          <radialGradient id="bodyG" cx="50%" cy="40%" r="65%">
            <stop offset="0%" stopColor={body} />
            <stop offset="100%" stopColor={bodyDark} />
          </radialGradient>
        </defs>

        {/* ears */}
        <g transform={earTransform} style={{ transition: 'transform 280ms ease' }}>
          <path d="M 22 18 L 19 8 L 27 16 Z" fill={bodyDark} />
          <path d="M 42 18 L 45 8 L 37 16 Z" fill={bodyDark} />
        </g>

        {/* body */}
        <ellipse cx="32" cy="36" rx="22" ry="22" fill="url(#bodyG)" />

        {/* belly */}
        <ellipse cx="32" cy="40" rx="14" ry="15" fill="url(#bellyG)" />

        {/* belly chevrons */}
        <path d="M 28 36 l 1.5 2 -1.5 2" stroke={bodyDark} strokeWidth="0.6" fill="none" opacity="0.45" />
        <path d="M 32 38 l 1.5 2 -1.5 2" stroke={bodyDark} strokeWidth="0.6" fill="none" opacity="0.45" />
        <path d="M 36 36 l 1.5 2 -1.5 2" stroke={bodyDark} strokeWidth="0.6" fill="none" opacity="0.45" />

        {/* worried brows */}
        {mood === 'sad' && (
          <>
            <path d="M 22.5 34.5 L 29 36" stroke={eyeDark} strokeWidth="1.1" strokeLinecap="round" />
            <path d="M 41.5 34.5 L 35 36" stroke={eyeDark} strokeWidth="1.1" strokeLinecap="round" />
          </>
        )}

        {/* eyes */}
        <ellipse cx="26" cy={eyeY} rx={eyeRx} ry={eyeRy} fill={eyeWhite} />
        <ellipse cx="38" cy={eyeY} rx={eyeRx} ry={eyeRy} fill={eyeWhite} />
        <circle cx="26.3" cy={eyeY + 0.2} r="1.1" fill={eyeDark} />
        <circle cx="38.3" cy={eyeY + 0.2} r="1.1" fill={eyeDark} />
        <circle cx="26.6" cy={eyeY - 0.3} r="0.35" fill="#fff" />
        <circle cx="38.6" cy={eyeY - 0.3} r="0.35" fill="#fff" />

        {/* happy cheeks */}
        {mood === 'happy' && (
          <>
            <ellipse cx="22" cy="46" rx="2.2" ry="1.4" fill="#e07d8a" opacity="0.55" />
            <ellipse cx="42" cy="46" rx="2.2" ry="1.4" fill="#e07d8a" opacity="0.55" />
          </>
        )}

        {/* nose */}
        <path d="M 31 45 L 33 45 L 32 46.5 Z" fill={eyeDark} />

        {/* mouth */}
        <path d={mouth} stroke={eyeDark} strokeWidth="1" fill={mood === 'happy' ? eyeDark : 'none'} fillOpacity={mood === 'happy' ? 0.18 : 0} strokeLinecap="round" />

        {/* whiskers */}
        <path d="M 21 46 L 16 45" stroke={bodyDark} strokeWidth="0.5" opacity="0.6" />
        <path d="M 21 47.5 L 16 48" stroke={bodyDark} strokeWidth="0.5" opacity="0.6" />
        <path d="M 43 46 L 48 45" stroke={bodyDark} strokeWidth="0.5" opacity="0.6" />
        <path d="M 43 47.5 L 48 48" stroke={bodyDark} strokeWidth="0.5" opacity="0.6" />

        {/* accent dot — picks up theme accent */}
        <circle cx="32" cy="20" r="1.2" fill={theme?.accent || '#9b7dd4'} opacity="0.85" />
      </svg>
    </div>
  );
}
