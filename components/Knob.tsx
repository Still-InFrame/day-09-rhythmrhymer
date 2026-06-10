"use client";

import { useVerticalDrag } from "./useVerticalDrag";

// Hand-rolled knob (react-knob-headless doesn't support React 19).
// Vertical drag changes the value; double-click resets to defaultValue.
export function Knob({
  label,
  value,
  min,
  max,
  defaultValue,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  const handlers = useVerticalDrag({ value, min, max, onChange });
  const normalized = (value - min) / (max - min);
  const angle = -135 + normalized * 270;

  return (
    <div className="flex flex-col items-center gap-1 select-none">
      <div
        {...handlers}
        onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 100) / 100}
        tabIndex={0}
        onKeyDown={(e) => {
          const step = (max - min) / 50;
          if (e.key === "ArrowUp" || e.key === "ArrowRight")
            onChange(Math.min(max, value + step));
          if (e.key === "ArrowDown" || e.key === "ArrowLeft")
            onChange(Math.max(min, value - step));
        }}
        className="relative h-12 w-12 cursor-ns-resize rounded-full border border-chassis-edge bg-gradient-to-b from-[#2e3137] to-[#191b1f] shadow-[0_3px_6px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.08)]"
        style={{ touchAction: "none" }}
      >
        {/* knurled cap */}
        <div className="absolute inset-[5px] rounded-full bg-gradient-to-b from-[#22252a] to-[#101113]" />
        {/* indicator */}
        <div
          className="absolute inset-0"
          style={{ transform: `rotate(${angle}deg)` }}
        >
          <div className="absolute left-1/2 top-[6px] h-3 w-[3px] -translate-x-1/2 rounded-full bg-cyan-300 shadow-[0_0_5px_var(--pad-cyan)]" />
        </div>
      </div>
      <span className="font-mono text-[9px] tracking-widest text-zinc-400">{label}</span>
      <span className="font-mono text-[9px] text-zinc-500 tabular-nums">
        {format ? format(value) : value.toFixed(2)}
      </span>
    </div>
  );
}
