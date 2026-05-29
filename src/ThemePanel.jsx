import React from 'react';
import { THEMES, THEME_KEYS } from './themes.js';

export default function ThemePanel({ open, current, onPick, onClose, neutralChrome = false, onToggleNeutral }) {
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
    </div>
  );
}
