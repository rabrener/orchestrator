import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import type { FsListing } from "../types.js";

interface Props {
  title: string;
  // Path to land on when the dialog opens. Defaults to ~ when missing.
  initialPath?: string | null;
  // Free-text label for the confirm button (e.g. "Use as default", "Set cwd").
  confirmLabel?: string;
  // Called with the absolute path the user picked. Picker stays open until
  // onConfirm resolves so the parent can show validation errors inline.
  onConfirm: (path: string) => void | Promise<void>;
  onCancel: () => void;
  // Optional override path the user can clear (only relevant for per-todo
  // overrides); when present, a "Clear override" button appears.
  onClear?: () => void | Promise<void>;
}

interface State {
  loading: boolean;
  listing: FsListing | null;
  error: string | null;
}

function prettyPath(path: string, home: string): string {
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

// Walk a path into ancestors so the breadcrumb can render every level. "/" is
// included as the leading anchor; the final segment is the current dir.
function breadcrumbSegments(path: string): Array<{ label: string; path: string }> {
  if (path === "/") return [{ label: "/", path: "/" }];
  const parts = path.split("/").filter(Boolean);
  const out: Array<{ label: string; path: string }> = [{ label: "/", path: "/" }];
  let acc = "";
  for (const p of parts) {
    acc += "/" + p;
    out.push({ label: p, path: acc });
  }
  return out;
}

export function DirectoryPickerDialog({
  title,
  initialPath,
  confirmLabel = "Select",
  onConfirm,
  onCancel,
  onClear,
}: Props) {
  const [state, setState] = useState<State>({ loading: true, listing: null, error: null });
  const [pathInput, setPathInput] = useState(initialPath ?? "");
  const [submitting, setSubmitting] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Resolve the initial directory: per-prop seed → home shortcut. Done once
  // on mount; the input is the source of truth thereafter.
  useEffect(() => {
    let cancelled = false;
    const seed = initialPath?.trim() || "~";
    const resolveSeed = async (): Promise<string> => {
      if (seed === "~" || seed.startsWith("~/")) {
        // We don't know homedir client-side; hit /api/fs/list with "/" once
        // just to learn it from the response, then re-list at the resolved
        // home path. One extra round-trip on first open.
        try {
          const root = await api.listDirectory("/");
          return seed === "~"
            ? root.home
            : root.home + seed.slice(1);
        } catch {
          return "/";
        }
      }
      return seed;
    };
    void (async () => {
      const target = await resolveSeed();
      if (cancelled) return;
      setPathInput(target);
      await loadPath(target);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close on Escape, confirm on Cmd/Ctrl+Enter — keyboard-first feels right
  // for a power-user picker even though the dialog is mouse-driven by default.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        void handleConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.listing]);

  const loadPath = async (target: string) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const listing = await api.listDirectory(target);
      setState({ loading: false, listing, error: null });
      setPathInput(listing.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, loading: false, error: humanizeFsError(msg) }));
    }
  };

  const handleConfirm = async () => {
    const target = state.listing?.path ?? pathInput.trim();
    if (!target) return;
    setSubmitting(true);
    try {
      await onConfirm(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, error: humanizeFsError(msg) }));
    } finally {
      setSubmitting(false);
    }
  };

  const handleClear = async () => {
    if (!onClear) return;
    setSubmitting(true);
    try {
      await onClear();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, error: humanizeFsError(msg) }));
    } finally {
      setSubmitting(false);
    }
  };

  const breadcrumb = useMemo(
    () => (state.listing ? breadcrumbSegments(state.listing.path) : []),
    [state.listing],
  );

  return (
    <div
      ref={overlayRef}
      className="picker-overlay"
      onClick={(e) => {
        // Backdrop click closes the picker; clicks inside the panel are kept
        // from bubbling so a parent modal (e.g. SettingsPanel) doesn't also
        // treat them as a backdrop dismiss.
        if (e.target === overlayRef.current) onCancel();
        e.stopPropagation();
      }}
    >
      <div className="picker-panel" role="dialog" aria-label={title}>
        <header className="picker-header">
          <h2>{title}</h2>
          <button className="picker-close" onClick={onCancel} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="picker-toolbar">
          <button
            type="button"
            className="picker-chip"
            onClick={() => state.listing && loadPath(state.listing.home)}
            title="Jump to home directory"
            disabled={!state.listing}
          >
            ~ home
          </button>
          <button
            type="button"
            className="picker-chip"
            onClick={() => state.listing?.parent && loadPath(state.listing.parent)}
            disabled={!state.listing?.parent}
            title="Go up one level"
          >
            ↑ up
          </button>
          <input
            className="picker-path-input"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void loadPath(pathInput.trim());
              }
            }}
            placeholder="/absolute/path"
            spellCheck={false}
            aria-label="Path"
          />
          <button
            type="button"
            className="picker-chip"
            onClick={() => void loadPath(pathInput.trim())}
            disabled={!pathInput.trim()}
          >
            go
          </button>
        </div>

        {state.listing && (
          <nav className="picker-breadcrumb" aria-label="Path breadcrumb">
            {breadcrumb.map((seg, i) => (
              <span key={seg.path} className="picker-crumb">
                {i > 0 && <span className="picker-crumb-sep">/</span>}
                <button
                  type="button"
                  className="picker-crumb-btn"
                  onClick={() => loadPath(seg.path)}
                  disabled={i === breadcrumb.length - 1}
                >
                  {seg.label}
                </button>
              </span>
            ))}
          </nav>
        )}

        <div ref={listRef} className="picker-list">
          {state.loading && <div className="picker-empty">loading…</div>}
          {!state.loading && state.error && (
            <div className="picker-error">{state.error}</div>
          )}
          {!state.loading && !state.error && state.listing?.entries.length === 0 && (
            <div className="picker-empty">no subdirectories here</div>
          )}
          {!state.loading &&
            !state.error &&
            state.listing?.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="picker-entry"
                onDoubleClick={() => loadPath(entry.path)}
                onClick={() => setPathInput(entry.path)}
                title={entry.path}
              >
                <span className="picker-entry-icon" aria-hidden="true">📁</span>
                <span className="picker-entry-name">{entry.name}</span>
              </button>
            ))}
        </div>

        <footer className="picker-footer">
          <div className="picker-footer-info">
            {state.listing && (
              <span className="picker-current" title={state.listing.path}>
                will use: <code>{prettyPath(state.listing.path, state.listing.home)}</code>
              </span>
            )}
          </div>
          <div className="picker-footer-actions">
            {onClear && (
              <button
                type="button"
                className="btn-tertiary"
                onClick={() => void handleClear()}
                disabled={submitting}
              >
                clear override
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={onCancel} disabled={submitting}>
              cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleConfirm()}
              disabled={submitting || !state.listing}
            >
              {submitting ? "…" : confirmLabel}
            </button>
          </div>
        </footer>

        <p className="picker-hint">
          double-click a folder to enter it · single-click to select · Cmd/Ctrl+Enter to confirm
        </p>
      </div>
    </div>
  );
}

// Map server error tokens (cwd_must_be_absolute / not_found / etc.) to plain
// English. Falls through to the raw message if the token isn't recognized.
function humanizeFsError(message: string): string {
  if (/not_absolute|cwd_must_be_absolute/.test(message))
    return "Path must be absolute (start with /).";
  if (/not_found|cwd_does_not_exist/.test(message))
    return "That path doesn't exist.";
  if (/not_a_directory|cwd_not_a_directory/.test(message))
    return "That path isn't a directory.";
  if (/permission_denied/.test(message))
    return "Permission denied — server can't read that folder.";
  return message;
}
