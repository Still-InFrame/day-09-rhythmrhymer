"use client";

import { useVerticalDrag } from "./useVerticalDrag";

export function Fader({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const handlers = useVerticalDrag({ value, min, max, onChange, sweepPx: 96 });
  const normalized = (value - min) / (max - min);

  return (
    <div className="flex flex-col items-center gap-1 select-none">
      <div
        {...handlers}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 100) / 100}
        tabIndex={0}
        onKeyDown={(e) => {
          const step = (max - min) / 50;
          if (e.key === "ArrowUp") onChange(Math.min(max, value + step));
          if (e.key === "ArrowDown") onChange(Math.max(min, value - step));
        }}
        className="relative h-28 w-9 cursor-ns-resize"
        style={{ touchAction: "none" }}
      >
        {/* slot */}
        <div className="absolute left-1/2 top-0 h-full w-[6px] -translate-x-1/2 rounded-full bg-chassis-deep shadow-[inset_0_1px_3px_rgba(0,0,0,0.9)]" />
        {/* thumb */}
        <div
          className="absolute left-1/2 h-5 w-9 -translate-x-1/2 -translate-y-1/2 rounded-[4px] border border-chassis-edge bg-gradient-to-b from-[#33363c] via-[#1c1e22] to-[#33363c] shadow-[0_2px_5px_rgba(0,0,0,0.7)]"
          style={{ top: `${(1 - normalized) * 100}%` }}
        >
          <div className="absolute left-1 right-1 top-1/2 h-[2px] -translate-y-1/2 rounded bg-zinc-300/80" />
        </div>
      </div>
      <span className="font-mono text-[9px] tracking-widest text-zinc-400">{label}</span>
    </div>
  );
}
