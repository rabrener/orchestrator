import { useCallback, useEffect, useRef, useState } from "react";

export function usePersistedWidth(
  key: string,
  initial: number,
  min: number,
  max: number,
): readonly [number, (delta: number) => void] {
  const [width, setWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        const n = Number(stored);
        if (!Number.isNaN(n)) return Math.max(min, Math.min(max, n));
      }
    } catch {
      // localStorage unavailable
    }
    return initial;
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, String(width));
    } catch {
      // ignore
    }
  }, [key, width]);

  const adjust = useCallback(
    (delta: number) => {
      setWidth((prev) => Math.max(min, Math.min(max, prev + delta)));
    },
    [min, max],
  );

  return [width, adjust] as const;
}

export function ResizeHandle({
  onDelta,
  ariaLabel,
}: {
  onDelta: (deltaX: number) => void;
  ariaLabel: string;
}) {
  const [dragging, setDragging] = useState(false);
  const lastXRef = useRef<number | null>(null);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    lastXRef.current = e.clientX;
    setDragging(true);

    const onMove = (ev: MouseEvent) => {
      if (lastXRef.current === null) return;
      const delta = ev.clientX - lastXRef.current;
      if (delta !== 0) {
        lastXRef.current = ev.clientX;
        onDelta(delta);
      }
    };
    const onUp = () => {
      lastXRef.current = null;
      setDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className={`resize-handle ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onMouseDown={onMouseDown}
    />
  );
}
