import { useEffect } from "react";
import {
  applyPreferences,
  FONT_SIZES,
  THEMES,
  type FontSize,
  type PermissionMode,
  type Preferences,
  type Theme,
} from "../api.js";
import { ModePicker } from "./ModePicker.js";

interface Props {
  preferences: Preferences;
  onChange: (next: Preferences) => void;
  onClose: () => void;
}

export function SettingsPanel({ preferences, onChange, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setTheme = (theme: Theme) => {
    const next = { ...preferences, theme };
    applyPreferences(next);
    onChange(next);
  };
  const setFontSize = (font_size: FontSize) => {
    const next = { ...preferences, font_size };
    applyPreferences(next);
    onChange(next);
  };
  const setDefaultMode = (default_permission_mode: PermissionMode) => {
    onChange({ ...preferences, default_permission_mode });
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <header className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <section className="settings-section">
          <h3>Theme</h3>
          <div className="theme-grid">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`theme-card${preferences.theme === t.id ? " active" : ""}`}
                onClick={() => setTheme(t.id)}
                data-theme-preview={t.id}
              >
                <div className="theme-swatch">
                  <span className="theme-swatch-bg" />
                  <span className="theme-swatch-elev" />
                  <span className="theme-swatch-accent" />
                  <span className="theme-swatch-text" />
                </div>
                <span className="theme-label">{t.label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3>Font size</h3>
          <div className="font-size-row">
            {FONT_SIZES.map((f) => (
              <button
                key={f.id}
                className={`font-chip${preferences.font_size === f.id ? " active" : ""}`}
                onClick={() => setFontSize(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3>Default permission mode</h3>
          <ModePicker
            value={preferences.default_permission_mode}
            onChange={setDefaultMode}
            size="md"
          />
          <p className="settings-hint">
            Applied to every newly started agent. You can still change the mode per session.
          </p>
        </section>

        <p className="settings-hint settings-footer">
          Stored at <code>~/.config/orchestrator-ui/preferences.json</code> — not in git.
        </p>
      </div>
    </div>
  );
}
