import { useEffect, useMemo, useState } from 'react';
import { THEMES } from '../themes.js';

function storedBool(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : value === '1';
  } catch {
    return fallback;
  }
}

export default function useCockpitSettings() {
  const [themeKey, setThemeKey] = useState(() => {
    try {
      const key = localStorage.getItem('tt.theme');
      if (key && THEMES[key]) return key;
    } catch {}
    return 'forest';
  });
  const [neutralChrome, setNeutralChrome] = useState(() => storedBool('tt.neutralChrome', false));
  const [axisChain, setAxisChain] = useState(() => storedBool('tt.axischain', false));
  const [rungButton, setRungButton] = useState(() => storedBool('tt.rung', false));
  const [showOvn, setShowOvn] = useState(() => storedBool('tt.showOvn', true));
  const [showPositions, setShowPositions] = useState(() => storedBool('tt.showPositions', true));
  const [showMarkers, setShowMarkers] = useState(() => storedBool('tt.showMarkers', true));
  const [dayLevelsOn, setDayLevelsOn] = useState(() => storedBool('tt.dayLevels', false));

  const theme = THEMES[themeKey];
  const chartTheme = useMemo(
    () => (neutralChrome ? { ...theme, bg: '#0a0a0c', grid: '#17171a' } : theme),
    [theme, neutralChrome],
  );

  useEffect(() => {
    const root = document.documentElement;
    Object.entries(theme).forEach(([key, value]) => {
      if (typeof value === 'string') root.style.setProperty(`--c-${key}`, value);
    });
    if (neutralChrome) {
      root.style.setProperty('--c-bg', '#0a0a0b');
      root.style.setProperty('--c-surface', '#101012');
      root.style.setProperty('--c-surfaceAlt', '#161618');
      root.style.setProperty('--c-border', '#242427');
    }
  }, [theme, neutralChrome]);

  useEffect(() => {
    try {
      localStorage.setItem('tt.theme', themeKey);
      localStorage.setItem('tt.neutralChrome', neutralChrome ? '1' : '0');
    } catch {}
  }, [themeKey, neutralChrome]);

  useEffect(() => {
    try {
      localStorage.setItem('tt.axischain', axisChain ? '1' : '0');
      localStorage.setItem('tt.rung', rungButton ? '1' : '0');
      localStorage.setItem('tt.showOvn', showOvn ? '1' : '0');
      localStorage.setItem('tt.showPositions', showPositions ? '1' : '0');
      localStorage.setItem('tt.showMarkers', showMarkers ? '1' : '0');
      localStorage.setItem('tt.dayLevels', dayLevelsOn ? '1' : '0');
    } catch {}
  }, [axisChain, rungButton, showOvn, showPositions, showMarkers, dayLevelsOn]);

  return {
    themeKey,
    setThemeKey,
    neutralChrome,
    setNeutralChrome,
    theme,
    chartTheme,
    axisChain,
    setAxisChain,
    rungButton,
    setRungButton,
    showOvn,
    setShowOvn,
    showPositions,
    setShowPositions,
    showMarkers,
    setShowMarkers,
    dayLevelsOn,
    setDayLevelsOn,
  };
}
