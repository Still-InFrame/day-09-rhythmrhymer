"use client";

import { useCallback, useRef } from "react";

// Shared drag behavior for Knob and Fader: vertical pointer drag maps to a
// value delta. Pointer capture keeps the drag alive outside the element;
// callers must set `touch-action: none` so touch drags don't scroll the page.
export function useVerticalDrag(opts: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  // Pixels of drag for a full min->max sweep.
  sweepPx?: number;
}) {
  const { value, min, max, onChange, sweepPx = 150 } = opts;
  const drag = useRef<{ startY: number; startValue: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Capture is best-effort; the drag still works while the pointer
        // stays over the element.
      }
      drag.current = { startY: e.clientY, startValue: value };
    },
    [value],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!drag.current) return;
      const delta = drag.current.startY - e.clientY;
      const next = drag.current.startValue + (delta * (max - min)) / sweepPx;
      onChange(Math.min(max, Math.max(min, next)));
    },
    [min, max, onChange, sweepPx],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Pointer was never captured — nothing to release.
    }
    drag.current = null;
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}
