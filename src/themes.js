// Theme presets. Each theme defines chart + UI colors.
// All four themes share the same dark surface palette so the layout is consistent
// while accent + candle hues swap.

export const THEMES = {
  kisa: {
    name: 'Kisa',
    bg: '#131722',
    surface: '#171b27',
    surfaceAlt: '#1b2030',
    border: '#252a3a',
    grid: '#1c2030',
    text: '#d1d5e0',
    muted: '#565a6e',
    accent: '#76718a',
    accentSoft: 'rgba(118, 113, 138, 0.18)',
    up: '#76718a',
    upFilled: true,
    down: '#b6b9c2',
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
    text: '#d6deea',
    muted: '#5a6478',
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
    text: '#d8dfd5',
    muted: '#5a6760',
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
    text: '#d1d4dc',
    muted: '#5b6478',
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
    text: '#ccd2db', muted: '#58606d',
    accent: '#6f8fb0', accentSoft: 'rgba(111, 143, 176, 0.18)',
    up: '#6f8fb0', upFilled: true, down: '#c0896a', downFilled: true,
    volUp: 'rgba(111, 143, 176, 0.32)', volDown: 'rgba(192, 137, 106, 0.32)',
    callLine: '#6f8fb0', putLine: '#c0896a', profit: '#6f8fb0', loss: '#c0896a'
  },
  sage: {
    name: 'Sage',
    bg: '#12150f', surface: '#171b13', surfaceAlt: '#1c2118', border: '#2b3325', grid: '#191e15',
    text: '#d3dac8', muted: '#5f6655',
    accent: '#8caa7e', accentSoft: 'rgba(140, 170, 126, 0.18)',
    up: '#8caa7e', upFilled: true, down: '#c2899a', downFilled: true,
    volUp: 'rgba(140, 170, 126, 0.32)', volDown: 'rgba(194, 137, 154, 0.32)',
    callLine: '#8caa7e', putLine: '#c2899a', profit: '#8caa7e', loss: '#c2899a'
  },
  lagoon: {
    name: 'Lagoon',
    bg: '#0f1618', surface: '#141d1f', surfaceAlt: '#182427', border: '#243a3c', grid: '#16282a',
    text: '#cdd9d8', muted: '#56676a',
    accent: '#4fa0a0', accentSoft: 'rgba(79, 160, 160, 0.18)',
    up: '#4fa0a0', upFilled: true, down: '#cf8472', downFilled: true,
    volUp: 'rgba(79, 160, 160, 0.32)', volDown: 'rgba(207, 132, 114, 0.32)',
    callLine: '#4fa0a0', putLine: '#cf8472', profit: '#4fa0a0', loss: '#cf8472'
  },
  indigo: {
    name: 'Indigo',
    bg: '#121320', surface: '#181a28', surfaceAlt: '#1d2031', border: '#2c2f48', grid: '#1a1d2e',
    text: '#d2d4e6', muted: '#5e6178',
    accent: '#7d86c6', accentSoft: 'rgba(125, 134, 198, 0.18)',
    up: '#7d86c6', upFilled: true, down: '#c99a6f', downFilled: true,
    volUp: 'rgba(125, 134, 198, 0.32)', volDown: 'rgba(201, 154, 111, 0.32)',
    callLine: '#7d86c6', putLine: '#c99a6f', profit: '#7d86c6', loss: '#c99a6f'
  },
  plum: {
    name: 'Plum',
    bg: '#16121a', surface: '#1c1722', surfaceAlt: '#221b29', border: '#332a3b', grid: '#1e1925',
    text: '#dad2de', muted: '#685f6d',
    accent: '#a07cb0', accentSoft: 'rgba(160, 124, 176, 0.18)',
    up: '#a07cb0', upFilled: true, down: '#bd7d68', downFilled: true,
    volUp: 'rgba(160, 124, 176, 0.32)', volDown: 'rgba(189, 125, 104, 0.32)',
    callLine: '#a07cb0', putLine: '#bd7d68', profit: '#a07cb0', loss: '#bd7d68'
  },
  moss: {
    name: 'Moss',
    bg: '#14140d', surface: '#1a1a11', surfaceAlt: '#201f15', border: '#313022', grid: '#1c1b12',
    text: '#d8d6c2', muted: '#646150',
    accent: '#97a35f', accentSoft: 'rgba(151, 163, 95, 0.18)',
    up: '#97a35f', upFilled: true, down: '#b98aa6', downFilled: true,
    volUp: 'rgba(151, 163, 95, 0.32)', volDown: 'rgba(185, 138, 166, 0.32)',
    callLine: '#97a35f', putLine: '#b98aa6', profit: '#97a35f', loss: '#b98aa6'
  },
  harbor: {
    name: 'Harbor',
    bg: '#0f131a', surface: '#141a23', surfaceAlt: '#18202c', border: '#233040', grid: '#15202c',
    text: '#cdd5e0', muted: '#566273',
    accent: '#5b96c4', accentSoft: 'rgba(91, 150, 196, 0.18)',
    up: '#5b96c4', upFilled: true, down: '#cf8d79', downFilled: true,
    volUp: 'rgba(91, 150, 196, 0.32)', volDown: 'rgba(207, 141, 121, 0.32)',
    callLine: '#5b96c4', putLine: '#cf8d79', profit: '#5b96c4', loss: '#cf8d79'
  },
  ember: {
    name: 'Ember',
    bg: '#17130f', surface: '#1d1813', surfaceAlt: '#241d16', border: '#352a1f', grid: '#201913',
    text: '#ded4c6', muted: '#6b6052',
    accent: '#cf9b66', accentSoft: 'rgba(207, 155, 102, 0.18)',
    up: '#cf9b66', upFilled: true, down: '#7e93a6', downFilled: true,
    volUp: 'rgba(207, 155, 102, 0.32)', volDown: 'rgba(126, 147, 166, 0.32)',
    callLine: '#cf9b66', putLine: '#7e93a6', profit: '#cf9b66', loss: '#7e93a6'
  }
};

export const THEME_KEYS = Object.keys(THEMES);
