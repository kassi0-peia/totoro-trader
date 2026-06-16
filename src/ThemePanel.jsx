import React from 'react';
import { THEMES, THEME_KEYS } from './themes.js';

export default function ThemePanel({ open, current, onPick, onClose, neutralChrome = false, onToggleNeutral, axisChain = false, onToggleAxisChain = null, rungButton = false, onToggleRungButton = null, totoroOn = true, onToggleTotoro = null, showOvn = true, onToggleShowOvn = null, showPositions = true, onToggleShowPositions = null, showMarkers = true, onToggleShowMarkers = null }) {
  if (!open) return null;
  return (
    <div className="theme-panel" onClick={(e) => e.stopPropagation()}>
      <div className="theme-panel-head">
        <span>Theme</span>
        <button className="x-btn" onClick={onClose} aria-label="close">×</button>
      </div>
      <div className="theme-grid">
        {THEME_KEYS.map((k) => {
          const t = THEMES[k];
          const active = k === current;
          return (
            <button
              key={k}
              className={`theme-card${active ? ' active' : ''}`}
              style={{ borderColor: active ? t.accent : t.border, background: t.surface }}
              onClick={() => onPick(k)}
            >
              <div className="swatch-row">
                <span className="swatch" style={{ background: t.up }} />
                <span className="swatch" style={{ background: t.down }} />
                <span className="swatch" style={{ background: t.accent }} />
              </div>
              <div className="theme-name" style={{ color: t.text }}>{t.name}</div>
            </button>
          );
        })}
      </div>
      <div className="theme-toggle-row">
        <span>Neutral chrome</span>
        <button
          className={`toggle-switch${neutralChrome ? ' on' : ''}`}
          role="switch"
          aria-checked={neutralChrome}
          onClick={onToggleNeutral}
          aria-label="Toggle neutral grey chrome"
        >
          <span className="toggle-knob" />
        </button>
      </div>
      {onToggleAxisChain && (
        <div className="theme-toggle-row" data-tip="Paint live call/put premiums beside each strike on the price axis — the chain lives on the chart">
          <span>Axis premiums</span>
          <button
            className={`toggle-switch${axisChain ? ' on' : ''}`}
            role="switch"
            aria-checked={axisChain}
            onClick={onToggleAxisChain}
            aria-label="Toggle premiums on the price axis"
          >
            <span className="toggle-knob" />
          </button>
        </div>
      )}
      {onToggleShowOvn && (
        <div className="theme-toggle-row" data-tip="Show the overnight ES-proxy candles (ES − basis). Off = only real SPX cash bars.">
          <span>Show overnight</span>
          <button
            className={`toggle-switch${showOvn ? ' on' : ''}`}
            role="switch"
            aria-checked={showOvn}
            onClick={onToggleShowOvn}
            aria-label="Toggle showing the overnight ES-proxy candles"
          >
            <span className="toggle-knob" />
          </button>
        </div>
      )}
      {onToggleShowPositions && (
        <div className="theme-toggle-row" data-tip="Show open positions on the chart (strike lines, P/L labels, ITM shading).">
          <span>Show positions</span>
          <button
            className={`toggle-switch${showPositions ? ' on' : ''}`}
            role="switch"
            aria-checked={showPositions}
            onClick={onToggleShowPositions}
            aria-label="Toggle showing positions on the chart"
          >
            <span className="toggle-knob" />
          </button>
        </div>
      )}
      {onToggleShowMarkers && (
        <div className="theme-toggle-row" data-tip="Entry/exit arrows on the chart marking where trades filled.">
          <span>Trade markers</span>
          <button
            className={`toggle-switch${showMarkers ? ' on' : ''}`}
            role="switch"
            aria-checked={showMarkers}
            onClick={onToggleShowMarkers}
            aria-label="Toggle trade markers"
          >
            <span className="toggle-knob" />
          </button>
        </div>
      )}
      {onToggleTotoro && (
        <div className="theme-toggle-row" data-tip="Mark double-top (totoro) / triple-top patterns on the chart as they form">
          <span>Totoro detector</span>
          <button
            className={`toggle-switch${totoroOn ? ' on' : ''}`}
            role="switch"
            aria-checked={totoroOn}
            onClick={onToggleTotoro}
            aria-label="Toggle the totoro pattern detector"
          >
            <span className="toggle-knob" />
          </button>
        </div>
      )}
      {onToggleRungButton && (
        <div className="theme-toggle-row" data-tip="Show the RUNG button: one click buys the next further-OTM strike in your ladder's direction (limit at ask)">
          <span>Rung button</span>
          <button
            className={`toggle-switch${rungButton ? ' on' : ''}`}
            role="switch"
            aria-checked={rungButton}
            onClick={onToggleRungButton}
            aria-label="Toggle the one-click rung button"
          >
            <span className="toggle-knob" />
          </button>
        </div>
      )}
    </div>
  );
}
