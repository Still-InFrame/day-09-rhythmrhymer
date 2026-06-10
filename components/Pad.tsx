"use client";

import type { PadColor } from "@/lib/audio/kits";

// Lighting layers: idle (dim) -> lit (steady glow when the pad has steps in
// the loop) -> flash (bright 150ms burst on trigger, restarted by key bump).
export function Pad({
  label,
  color,
  lit,
  selected,
  sampled,
  assignable,
  keyHint,
  flashSeq,
  onTrigger,
  onRelease,
}: {
  label: string;
  color: PadColor;
  lit: boolean;
  selected: boolean;
  sampled: boolean;
  assignable: boolean;
  keyHint: string;
  flashSeq: number;
  onTrigger: () => void;
  onRelease: () => void;
}) {
  const cv = `var(--pad-${color})`;

  return (
    <button
      type="button"
      onPointerDown={(e) => {
        // Capture so the release fires here even if the finger slides off —
        // otherwise note repeat would stick on.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Best-effort; pointerleave is not handled, so an uncaptured slide
          // is ended by pointerup anywhere on the captured element.
        }
        onTrigger();
      }}
      onPointerUp={onRelease}
      onPointerCancel={onRelease}
      className={`relative aspect-square w-full select-none rounded-xl text-left transition-shadow duration-150 ${
        selected ? "ring-2 ring-white/35 ring-offset-2 ring-offset-chassis" : ""
      }`}
      style={{
        touchAction: "none",
        background: lit
          ? `linear-gradient(160deg, color-mix(in srgb, ${cv} 26%, #15161a), #131418)`
          : "linear-gradient(160deg, #1c1e23, #131418)",
        border: `1px solid color-mix(in srgb, ${cv} ${lit ? 80 : 45}%, transparent)`,
        boxShadow: lit
          ? `0 0 18px 1px color-mix(in srgb, ${cv} 65%, transparent), inset 0 0 12px color-mix(in srgb, ${cv} 30%, transparent)`
          : `0 0 7px -2px color-mix(in srgb, ${cv} 50%, transparent), inset 0 1px 0 rgba(255,255,255,0.04)`,
      }}
    >
      {flashSeq > 0 && (
        <span
          key={flashSeq}
          className="pad-flash pointer-events-none absolute inset-0 rounded-xl"
          style={{
            background: `color-mix(in srgb, ${cv} 55%, transparent)`,
            boxShadow: `0 0 26px 4px ${cv}`,
          }}
        />
      )}
      <span
        className="absolute left-1.5 top-1.5 font-mono text-[9px] font-semibold tracking-wider"
        style={{ color: `color-mix(in srgb, ${cv} 80%, white)` }}
      >
        {label}
      </span>
      {assignable && (
        <span className="pad-avail pointer-events-none absolute inset-0 rounded-xl border-2" />
      )}
      {keyHint && (
        <span className="absolute bottom-1.5 left-1.5 font-mono text-[8px] text-zinc-500">
          {keyHint}
        </span>
      )}
      {sampled && (
        <span
          className="absolute bottom-1.5 right-1.5 font-mono text-[8px] font-bold tracking-wider text-emerald-300"
          style={{ textShadow: "0 0 5px rgba(52,211,153,0.8)" }}
        >
          SMP
        </span>
      )}
    </button>
  );
}
