import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PERMISSION_MODES, type PermissionMode } from "../api.js";

interface Props {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  label?: string;
  size?: "sm" | "md";
}

interface MenuPos {
  left: number;
  top: number;
  width: number;
  placement: "top" | "bottom";
}

const MENU_GAP = 6;
const MENU_MAX_HEIGHT = 320;

export function ModePicker({ value, onChange, label, size = "sm" }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const current = PERMISSION_MODES.find((m) => m.id === value) ?? PERMISSION_MODES[0];

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const placement: MenuPos["placement"] =
      spaceBelow >= MENU_MAX_HEIGHT || spaceBelow >= spaceAbove ? "bottom" : "top";
    const minWidth = size === "md" ? 440 : 380;
    const desiredWidth = Math.max(rect.width, minWidth);
    const maxWidth = window.innerWidth - 24;
    const width = Math.min(desiredWidth, maxWidth);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    setPos({
      left,
      top: placement === "bottom" ? rect.bottom + MENU_GAP : rect.top - MENU_GAP,
      width,
      placement,
    });
  }, [open, size]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScrollOrResize = () => setOpen(false);
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  const select = (mode: PermissionMode) => {
    onChange(mode);
    setOpen(false);
  };

  return (
    <div className={`mode-picker mode-picker-${size}`}>
      {label && <span className="mode-picker-label">{label}</span>}
      <button
        ref={triggerRef}
        type="button"
        className="mode-picker-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="mode-picker-current">{current.label}</span>
        <span className="mode-picker-chevron">▾</span>
      </button>
      {open && pos &&
        createPortal(
          <ul
            ref={menuRef}
            className={`mode-picker-menu mode-picker-menu-${pos.placement}`}
            role="listbox"
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.placement === "bottom" ? pos.top : undefined,
              bottom:
                pos.placement === "top" ? window.innerHeight - pos.top : undefined,
              width: pos.width,
              maxHeight: MENU_MAX_HEIGHT,
            }}
          >
            {PERMISSION_MODES.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className={`mode-picker-option${m.id === value ? " active" : ""}`}
                  onClick={() => select(m.id)}
                  role="option"
                  aria-selected={m.id === value}
                >
                  <span className="mode-picker-option-label">{m.label}</span>
                  <span className="mode-picker-option-desc">{m.description}</span>
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
