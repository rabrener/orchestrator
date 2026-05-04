import { useEffect, useState } from "react";
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
import { DirectoryPickerDialog } from "./DirectoryPickerDialog.js";

interface Props {
  preferences: Preferences;
  onChange: (next: Preferences) => void;
  onClose: () => void;
}

export function SettingsPanel({ preferences, onChange, onClose }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The picker installs its own Escape handler that should win when open;
      // only collapse the settings overlay when no nested dialog is up.
      if (e.key === "Escape" && !pickerOpen) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pickerOpen]);

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
  const setDefaultCwd = (default_cwd: string | null) => {
    onChange({ ...preferences, default_cwd });
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

        <section className="settings-section">
          <h3>Default working directory</h3>
          <div className="settings-cwd-row">
            <code className="settings-cwd-value">
              {preferences.default_cwd ?? "(workspace root)"}
            </code>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setPickerOpen(true)}
            >
              choose…
            </button>
            {preferences.default_cwd && (
              <button
                type="button"
                className="btn-tertiary"
                onClick={() => setDefaultCwd(null)}
                title="Fall back to the orchestrator's workspace root"
              >
                reset
              </button>
            )}
          </div>
          <p className="settings-hint">
            New agents start here unless a to-do has its own override. Already-running
            sessions keep the cwd they were launched with.
          </p>
        </section>

        <p className="settings-hint settings-footer">
          Stored at <code>~/.config/orchestrator-ui/preferences.json</code> — not in git.
        </p>
      </div>
      {pickerOpen && (
        <DirectoryPickerDialog
          title="Default working directory"
          initialPath={preferences.default_cwd ?? "~"}
          confirmLabel="Use as default"
          onCancel={() => setPickerOpen(false)}
          onConfirm={(path) => {
            setDefaultCwd(path);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}
