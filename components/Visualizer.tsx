"use client";

import { useEffect, useRef } from "react";

// Frequency bars "projected" upward from the machine: bars rise from the
// bottom edge and fade toward the top. The rAF loop only runs while `active`
// — the parent flips it off a couple of seconds after the last sound.
const BAR_COUNT = 48;
const COLORS = ["#ff3b4d", "#f5a623", "#22d3ee", "#4d6bff", "#8b5cf6"];

export function Visualizer({
  analyser,
  active,
}: {
  analyser: AnalyserNode | null;
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analyser || !active) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(data);

      const { width: w, height: h } = canvas;
      ctx.clearRect(0, 0, w, h);

      const barW = w / BAR_COUNT;
      for (let i = 0; i < BAR_COUNT; i++) {
        // Skew sampling toward the lower bins where drums live.
        const bin = Math.floor((i / BAR_COUNT) ** 1.4 * data.length);
        const v = data[bin] / 255;
        if (v < 0.01) continue;
        const barH = v * h * 0.92;
        const color = COLORS[i % COLORS.length];

        const grad = ctx.createLinearGradient(0, h, 0, h - barH);
        grad.addColorStop(0, color + "cc");
        grad.addColorStop(1, color + "00");
        ctx.fillStyle = grad;
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.fillRect(i * barW + barW * 0.18, h - barH, barW * 0.64, barH);
      }
      ctx.shadowBlur = 0;
    };

    draw();
    return () => {
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [analyser, active]);

  return (
    <canvas
      ref={canvasRef}
      width={760}
      height={150}
      className={`h-[110px] w-full max-w-[760px] transition-opacity duration-700 ${
        active ? "opacity-100" : "opacity-25"
      }`}
      aria-hidden
    />
  );
}
