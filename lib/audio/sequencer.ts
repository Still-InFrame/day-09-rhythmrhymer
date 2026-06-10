// Lookahead step sequencer (Chris Wilson "A Tale of Two Clocks" pattern).
// A coarse setInterval tick schedules audio-clock-accurate events up to
// SCHEDULE_AHEAD seconds out, so UI jank never affects timing. All mutable
// musical state is read through getters per step — never captured.

export const STEPS = 16;

// 100ms survives normal background-tab timer throttling; bump if gaps appear.
const SCHEDULE_AHEAD = 0.1;
const TICK_MS = 25;

export interface SequencerOptions {
  ctx: AudioContext;
  getBpm: () => number;
  // 0.5 = straight 16ths, up to 0.75 = hard shuffle. Off-16ths land late.
  getSwing: () => number;
  getSteps: () => boolean[][][]; // [kit][pad][step] — every kit layer plays
  onSchedule: (kitIndex: number, padIndex: number, when: number, step: number) => void;
  onStepUI: (step: number, when: number) => void;
  // Fires just before step 0 of each bar is scheduled — the quantized moment
  // to swap patterns (scene changes) so the new bar plays the new material.
  onBarStart?: (when: number) => void;
}

export class Sequencer {
  private opts: SequencerOptions;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private nextNoteTime = 0;
  private step = 0;

  constructor(opts: SequencerOptions) {
    this.opts = opts;
  }

  get playing(): boolean {
    return this.timerId !== null;
  }

  // For live-record quantization: where the playhead is on the audio clock.
  getCurrentStepInfo(): { step: number; nextNoteTime: number; secondsPerStep: number } {
    return {
      step: this.step,
      nextNoteTime: this.nextNoteTime,
      secondsPerStep: 60 / this.opts.getBpm() / 4,
    };
  }

  start(): void {
    if (this.timerId !== null) return;
    this.step = 0;
    this.nextNoteTime = this.opts.ctx.currentTime + 0.05;
    this.timerId = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    if (this.timerId === null) return;
    clearInterval(this.timerId);
    this.timerId = null;
    this.step = 0;
  }

  private tick(): void {
    const { ctx, getBpm, getSwing, getSteps, onSchedule, onStepUI } = this.opts;
    while (this.nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
      if (this.step === 0) this.opts.onBarStart?.(this.nextNoteTime);
      const layers = getSteps();
      for (let kit = 0; kit < layers.length; kit++) {
        for (let pad = 0; pad < layers[kit].length; pad++) {
          if (layers[kit][pad][this.step]) onSchedule(kit, pad, this.nextNoteTime, this.step);
        }
      }
      onStepUI(this.step, this.nextNoteTime);
      // Swing stretches the on-16th -> off-16th gap and shrinks the return
      // gap; each pair of steps still spans exactly two straight 16ths.
      const pair = 2 * (60 / getBpm() / 4);
      const swing = getSwing();
      this.nextNoteTime += this.step % 2 === 0 ? pair * swing : pair * (1 - swing);
      this.step = (this.step + 1) % STEPS;
    }
  }
}
