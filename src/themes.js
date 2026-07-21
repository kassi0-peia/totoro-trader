// Theme presets. Each theme defines chart + UI colors.
// All four themes share the same dark surface palette so the layout is consistent
// while accent + candle hues swap.

// Reading text is NEUTRAL in every theme, on purpose. Each palette used to tint
// its own greys — forest's #5a6760 is green-dominant, classic's #5a6478 blue —
// so every label in the cockpit shifted hue with the theme. Themes still own the
// candles, call/put lines, accent, and profit/loss; only the text you read is
// pinned, and lifted enough that small labels hold up on a dark surface.
const TEXT = '#f2f4f6';
const MUTED = '#8b9096';

export const THEMES = {
  kisa: {
    name: 'Kisa',
    bg: '#131722',
    surface: '#171b27',
    surfaceAlt: '#1b2030',
    border: '#252a3a',
    grid: '#1c2030',
    text: TEXT,
    muted: MUTED,
    accent: '#76718a',
    accentSoft: 'rgba(118, 113, 138, 0.18)',
    up: '#b6b9c2',
    upFilled: true,
    down: '#76718a',
    downFilled: true,
    volUp: 'rgba(42, 110, 78, 0.55)',
    volDown: 'rgba(110, 42, 42, 0.55)',
    callLine: '#76718a',
    putLine: '#e08aa8',
    profit: '#7dd4a0',
    loss: '#e07d8a'
  },
  midnight: {
    name: 'Midnight',
    bg: '#0d1117',
    surface: '#141a24',
    surfaceAlt: '#1a2030',
    border: '#243046',
    grid: '#162033',
    text: TEXT,
    muted: MUTED,
    accent: '#4a9eff',
    accentSoft: 'rgba(74, 158, 255, 0.18)',
    up: '#4a9eff',
    upFilled: true,
    down: '#ff6b6b',
    downFilled: true,
    volUp: 'rgba(74, 158, 255, 0.35)',
    volDown: 'rgba(255, 107, 107, 0.35)',
    callLine: '#4a9eff',
    putLine: '#ff6b6b',
    profit: '#4a9eff',
    loss: '#ff6b6b'
  },
  forest: {
    name: 'Forest',
    bg: '#11181a',
    surface: '#161f22',
    surfaceAlt: '#1b262a',
    border: '#26353a',
    grid: '#1a2528',
    text: TEXT,
    muted: MUTED,
    accent: '#5cb85c',
    accentSoft: 'rgba(92, 184, 92, 0.18)',
    up: '#5cb85c',
    upFilled: true,
    down: '#d4a574',
    downFilled: true,
    volUp: 'rgba(92, 184, 92, 0.35)',
    volDown: 'rgba(212, 165, 116, 0.35)',
    callLine: '#5cb85c',
    putLine: '#d4a574',
    profit: '#5cb85c',
    loss: '#d4a574'
  },
  classic: {
    name: 'Classic',
    bg: '#131722',
    surface: '#1a1f2e',
    surfaceAlt: '#1e2435',
    border: '#2a324a',
    grid: '#1c2030',
    text: TEXT,
    muted: MUTED,
    accent: '#26a69a',
    accentSoft: 'rgba(38, 166, 154, 0.18)',
    up: '#26a69a',
    upFilled: true,
    down: '#ef5350',
    downFilled: true,
    volUp: 'rgba(38, 166, 154, 0.35)',
    volDown: 'rgba(239, 83, 80, 0.35)',
    callLine: '#26a69a',
    putLine: '#ef5350',
    profit: '#26a69a',
    loss: '#ef5350'
  },
  slate: {
    name: 'Slate',
    bg: '#11141a', surface: '#161b23', surfaceAlt: '#1b212b', border: '#2a323f', grid: '#181e28',
    text: TEXT, muted: MUTED,
    accent: '#6f8fb0', accentSoft: 'rgba(111, 143, 176, 0.18)',
    up: '#6f8fb0', upFilled: true, down: '#c0896a', downFilled: true,
    volUp: 'rgba(111, 143, 176, 0.32)', volDown: 'rgba(192, 137, 106, 0.32)',
    callLine: '#6f8fb0', putLine: '#c0896a', profit: '#6f8fb0', loss: '#c0896a'
  },
  sage: {
    name: 'Sage',
    bg: '#12150f', surface: '#171b13', surfaceAlt: '#1c2118', border: '#2b3325', grid: '#191e15',
    text: TEXT, muted: MUTED,
    accent: '#8caa7e', accentSoft: 'rgba(140, 170, 126, 0.18)',
    up: '#8caa7e', upFilled: true, down: '#c2899a', downFilled: true,
    volUp: 'rgba(140, 170, 126, 0.32)', volDown: 'rgba(194, 137, 154, 0.32)',
    callLine: '#8caa7e', putLine: '#c2899a', profit: '#8caa7e', loss: '#c2899a'
  },
  lagoon: {
    name: 'Lagoon',
    bg: '#0f1618', surface: '#141d1f', surfaceAlt: '#182427', border: '#243a3c', grid: '#16282a',
    text: TEXT, muted: MUTED,
    accent: '#4fa0a0', accentSoft: 'rgba(79, 160, 160, 0.18)',
    up: '#4fa0a0', upFilled: true, down: '#cf8472', downFilled: true,
    volUp: 'rgba(79, 160, 160, 0.32)', volDown: 'rgba(207, 132, 114, 0.32)',
    callLine: '#4fa0a0', putLine: '#cf8472', profit: '#4fa0a0', loss: '#cf8472'
  },
  indigo: {
    name: 'Indigo',
    bg: '#121320', surface: '#181a28', surfaceAlt: '#1d2031', border: '#2c2f48', grid: '#1a1d2e',
    text: TEXT, muted: MUTED,
    accent: '#7d86c6', accentSoft: 'rgba(125, 134, 198, 0.18)',
    up: '#7d86c6', upFilled: true, down: '#c99a6f', downFilled: true,
    volUp: 'rgba(125, 134, 198, 0.32)', volDown: 'rgba(201, 154, 111, 0.32)',
    callLine: '#7d86c6', putLine: '#c99a6f', profit: '#7d86c6', loss: '#c99a6f'
  },
  plum: {
    name: 'Plum',
    bg: '#16121a', surface: '#1c1722', surfaceAlt: '#221b29', border: '#332a3b', grid: '#1e1925',
    text: TEXT, muted: MUTED,
    accent: '#a07cb0', accentSoft: 'rgba(160, 124, 176, 0.18)',
    up: '#a07cb0', upFilled: true, down: '#bd7d68', downFilled: true,
    volUp: 'rgba(160, 124, 176, 0.32)', volDown: 'rgba(189, 125, 104, 0.32)',
    callLine: '#a07cb0', putLine: '#bd7d68', profit: '#a07cb0', loss: '#bd7d68'
  },
  moss: {
    name: 'Moss',
    bg: '#14140d', surface: '#1a1a11', surfaceAlt: '#201f15', border: '#313022', grid: '#1c1b12',
    text: TEXT, muted: MUTED,
    accent: '#97a35f', accentSoft: 'rgba(151, 163, 95, 0.18)',
    up: '#97a35f', upFilled: true, down: '#b98aa6', downFilled: true,
    volUp: 'rgba(151, 163, 95, 0.32)', volDown: 'rgba(185, 138, 166, 0.32)',
    callLine: '#97a35f', putLine: '#b98aa6', profit: '#97a35f', loss: '#b98aa6'
  },
  harbor: {
    name: 'Harbor',
    bg: '#0f131a', surface: '#141a23', surfaceAlt: '#18202c', border: '#233040', grid: '#15202c',
    text: TEXT, muted: MUTED,
    accent: '#5b96c4', accentSoft: 'rgba(91, 150, 196, 0.18)',
    up: '#5b96c4', upFilled: true, down: '#cf8d79', downFilled: true,
    volUp: 'rgba(91, 150, 196, 0.32)', volDown: 'rgba(207, 141, 121, 0.32)',
    callLine: '#5b96c4', putLine: '#cf8d79', profit: '#5b96c4', loss: '#cf8d79'
  },
  ember: {
    name: 'Ember',
    bg: '#17130f', surface: '#1d1813', surfaceAlt: '#241d16', border: '#352a1f', grid: '#201913',
    text: TEXT, muted: MUTED,
    accent: '#cf9b66', accentSoft: 'rgba(207, 155, 102, 0.18)',
    up: '#cf9b66', upFilled: true, down: '#7e93a6', downFilled: true,
    volUp: 'rgba(207, 155, 102, 0.32)', volDown: 'rgba(126, 147, 166, 0.32)',
    callLine: '#cf9b66', putLine: '#7e93a6', profit: '#cf9b66', loss: '#7e93a6'
  },

  // ── Extras (second tab): departures from the house dark-muted family.
  // The cockpit pins its chrome to one neutral near-black (useCockpitSettings),
  // so a theme here is really a candle/accent/text palette — a light theme
  // cannot exist without unpinning that chrome first. Direction/P-L must stay
  // legible in every one — Mono codes it purely by brightness (bright =
  // up/profit, dim = down/loss), the rest keep two clearly separated hues.
  mono: {
    name: 'Mono',
    bg: '#101010', surface: '#161616', surfaceAlt: '#1c1c1c', border: '#2b2b2b', grid: '#1a1a1a',
    text: TEXT, muted: MUTED,
    accent: '#9e9e9e', accentSoft: 'rgba(158, 158, 158, 0.18)',
    up: '#e4e4e4', upFilled: true, down: '#616161', downFilled: true,
    volUp: 'rgba(228, 228, 228, 0.22)', volDown: 'rgba(97, 97, 97, 0.35)',
    callLine: '#cfcfcf', putLine: '#787878', profit: '#f0f0f0', loss: '#6b6b6b'
  },
  noir: {
    name: 'Noir',
    bg: '#121110', surface: '#181614', surfaceAlt: '#1e1b18', border: '#2e2a25', grid: '#1a1815',
    text: TEXT, muted: MUTED,
    accent: '#b3aa9c', accentSoft: 'rgba(179, 170, 156, 0.18)',
    up: '#d2ccc2', upFilled: true, down: '#a35555', downFilled: true,
    volUp: 'rgba(210, 204, 194, 0.22)', volDown: 'rgba(163, 85, 85, 0.32)',
    callLine: '#c4bdb1', putLine: '#a35555', profit: '#d2ccc2', loss: '#c25b5b'
  },
  synth: {
    name: 'Synth',
    bg: '#0d0916', surface: '#140e1f', surfaceAlt: '#191228', border: '#2c2140', grid: '#170f24',
    text: TEXT, muted: MUTED,
    accent: '#e05fbc', accentSoft: 'rgba(224, 95, 188, 0.18)',
    up: '#5fe0d0', upFilled: true, down: '#e05fbc', downFilled: true,
    volUp: 'rgba(95, 224, 208, 0.28)', volDown: 'rgba(224, 95, 188, 0.28)',
    callLine: '#5fe0d0', putLine: '#e05fbc', profit: '#5fe0d0', loss: '#e05fbc'
  },
  arctic: {
    name: 'Arctic',
    bg: '#0e141c', surface: '#131a24', surfaceAlt: '#18202c', border: '#263242', grid: '#151d29',
    text: TEXT, muted: MUTED,
    accent: '#9fc6e0', accentSoft: 'rgba(159, 198, 224, 0.18)',
    up: '#cfe6f5', upFilled: true, down: '#5e7285', downFilled: true,
    volUp: 'rgba(207, 230, 245, 0.22)', volDown: 'rgba(94, 114, 133, 0.35)',
    callLine: '#b9d8ec', putLine: '#6e849a', profit: '#cfe6f5', loss: '#8296aa'
  }
};

export const THEME_KEYS = Object.keys(THEMES);

// Theme-picker tabs: the house family first, departures second.
export const THEME_TABS = [
  { id: 'house', name: 'HOUSE', keys: ['kisa', 'midnight', 'forest', 'classic', 'slate', 'sage', 'lagoon', 'indigo', 'plum', 'moss', 'harbor', 'ember'] },
  { id: 'extras', name: 'EXTRAS', keys: ['mono', 'noir', 'synth', 'arctic'] },
];
