"use client";

import { STEPS } from "@/lib/audio/sequencer";
import type { PadColor } from "@/lib/audio/kits";

// 16-step row editing the currently selected pad. Playhead sweeps during
// playback; every 4th step gets a beat accent.
export function StepGrid({
  padLabel,
  color,
  steps,
  currentStep,
  onToggle,
}: {
  padLabel: string;
  color: PadColor;
  steps: boolean[];
  currentStep: number; // -1 when stopped
  onToggle: (step: number) => void;
}) {
  const cv = `var(--pad-${color})`;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[9px] tracking-widest text-zinc-500">
        STEPS <span style={{ color: `color-mix(in srgb, ${cv} 85%, white)` }}>{padLabel}</span>
      </span>
      <div className="grid grid-cols-16 gap-1">
        {Array.from({ length: STEPS }, (_, i) => {
          const active = steps[i];
          const isPlayhead = i === currentStep;
          const isBeat = i % 4 === 0;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onToggle(i)}
              aria-label={`step ${i + 1}`}
              aria-pressed={active}
              className="h-7 rounded-[5px] transition-shadow duration-75"
              style={{
                background: active
                  ? `color-mix(in srgb, ${cv} ${isPlayhead ? 90 : 60}%, #15161a)`
                  : isPlayhead
                    ? "#34373d"
                    : "#1d1f24",
                border: `1px solid ${
                  active
                    ? `color-mix(in srgb, ${cv} 80%, transparent)`
                    : isBeat
                      ? "#3a3d44"
                      : "#26282e"
                }`,
                boxShadow: active
                  ? `0 0 ${isPlayhead ? 12 : 6}px color-mix(in srgb, ${cv} 60%, transparent)`
                  : "none",
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
