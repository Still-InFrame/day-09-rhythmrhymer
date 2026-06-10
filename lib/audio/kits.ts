// Drum kits: every sound is synthesized at trigger time from throwaway nodes.
// `pitch` scales frequencies, `decay` scales envelope times; `volume` is NOT
// applied here — it lives on the per-pad gain node in the engine.

export type SynthParams = {
  volume: number;
  pitch: number;
  decay: number;
  drive: number; // 0 = clean, 1 = max distortion (applied on the pad's shaper)
};

type SynthFn = (
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  p: SynthParams,
) => void;

export type PadColor = "red" | "purple" | "blue" | "cyan" | "amber";

interface PadSound {
  label: string;
  color: PadColor;
  play: SynthFn;
}

export interface Kit {
  id: string;
  name: string;
  pads: PadSound[]; // exactly 16, index 0 = hardware pad 1 (bottom-left)
}

// ---------------------------------------------------------------------------
// Shared bits

let noiseBuf: AudioBuffer | null = null;

function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) {
    const len = ctx.sampleRate * 2;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

// Exponential ramps can't reach 0.
const SILENT = 0.001;

function decayGain(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  peak: number,
  dur: number,
): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, when);
  g.gain.exponentialRampToValueAtTime(SILENT, when + dur);
  g.connect(dest);
  return g;
}

function noiseSource(ctx: AudioContext, when: number, dur: number): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.start(when);
  src.stop(when + dur + 0.05);
  return src;
}

function osc(
  ctx: AudioContext,
  type: OscillatorType,
  freq: number,
  when: number,
  dur: number,
): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, when);
  o.start(when);
  o.stop(when + dur + 0.05);
  return o;
}

// ---------------------------------------------------------------------------
// Synth factories — each returns a SynthFn with baked-in character.

function kick(opts: {
  start: number;
  end: number;
  drop: number; // pitch-drop time
  decay: number;
  peak?: number;
  click?: number; // click loudness, 0 = none
  wave?: OscillatorType;
}): SynthFn {
  return (ctx, dest, when, p) => {
    const dur = opts.decay * p.decay;
    const o = osc(ctx, opts.wave ?? "sine", opts.start * p.pitch, when, dur);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.end * p.pitch), when + opts.drop);
    o.connect(decayGain(ctx, dest, when, opts.peak ?? 1.0, dur));

    if (opts.click) {
      const c = noiseSource(ctx, when, 0.01);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 1500;
      c.connect(hp);
      hp.connect(decayGain(ctx, dest, when, opts.click, 0.012));
    }
  };
}

function snare(opts: {
  noiseFreq: number;
  noiseDecay: number;
  bodyFreq: number;
  bodyDecay: number;
  bodyWave?: OscillatorType;
}): SynthFn {
  return (ctx, dest, when, p) => {
    const nDur = opts.noiseDecay * p.decay;
    const n = noiseSource(ctx, when, nDur);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = opts.noiseFreq * p.pitch;
    bp.Q.value = 0.9;
    n.connect(bp);
    bp.connect(decayGain(ctx, dest, when, 0.8, nDur));

    const bDur = opts.bodyDecay * p.decay;
    const o = osc(ctx, opts.bodyWave ?? "triangle", opts.bodyFreq * p.pitch, when, bDur);
    o.connect(decayGain(ctx, dest, when, 0.5, bDur));
  };
}

function hat(opts: { decay: number; freq?: number; metallic?: boolean }): SynthFn {
  return (ctx, dest, when, p) => {
    const dur = opts.decay * p.decay;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = (opts.freq ?? 7000) * p.pitch;
    const out = decayGain(ctx, dest, when, 0.5, dur);
    hp.connect(out);

    const n = noiseSource(ctx, when, dur);
    n.connect(hp);

    if (opts.metallic) {
      // A couple of detuned squares under the noise reads as metal.
      for (const f of [4200, 5561]) {
        const o = osc(ctx, "square", f * p.pitch, when, dur);
        const g = ctx.createGain();
        g.gain.value = 0.12;
        o.connect(g);
        g.connect(hp);
      }
    }
  };
}

function clap(opts: { freq: number; decay: number }): SynthFn {
  return (ctx, dest, when, p) => {
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = opts.freq * p.pitch;
    bp.Q.value = 1.2;
    bp.connect(dest);
    // Three bursts ~10ms apart, then a longer tail.
    for (let i = 0; i < 3; i++) {
      const t = when + i * 0.011;
      const n = noiseSource(ctx, t, 0.012);
      n.connect(decayGain(ctx, bp, t, 0.7, 0.012));
    }
    const tail = noiseSource(ctx, when + 0.033, opts.decay * p.decay);
    tail.connect(decayGain(ctx, bp, when + 0.033, 0.6, opts.decay * p.decay));
  };
}

function tom(opts: { freq: number; decay: number }): SynthFn {
  return (ctx, dest, when, p) => {
    const dur = opts.decay * p.decay;
    const o = osc(ctx, "sine", opts.freq * p.pitch, when, dur);
    o.frequency.exponentialRampToValueAtTime(opts.freq * p.pitch * 0.55, when + dur);
    o.connect(decayGain(ctx, dest, when, 0.9, dur));
  };
}

function bell(opts: { f1: number; f2: number; decay: number; freq?: number }): SynthFn {
  return (ctx, dest, when, p) => {
    const dur = opts.decay * p.decay;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = (opts.freq ?? 1200) * p.pitch;
    bp.Q.value = 1.5;
    bp.connect(decayGain(ctx, dest, when, 0.8, dur));
    for (const f of [opts.f1, opts.f2]) {
      const o = osc(ctx, "square", f * p.pitch, when, dur);
      o.connect(bp);
    }
  };
}

function blip(opts: { freq: number; decay: number; wave?: OscillatorType }): SynthFn {
  return (ctx, dest, when, p) => {
    const dur = opts.decay * p.decay;
    const o = osc(ctx, opts.wave ?? "square", opts.freq * p.pitch, when, dur);
    o.connect(decayGain(ctx, dest, when, 0.6, dur));
  };
}

// FX ------------------------------------------------------------------------

function laser(opts: { from: number; to: number; dur: number; wave?: OscillatorType }): SynthFn {
  return (ctx, dest, when, p) => {
    const dur = opts.dur * p.decay;
    const o = osc(ctx, opts.wave ?? "sawtooth", opts.from * p.pitch, when, dur);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to * p.pitch), when + dur);
    o.connect(decayGain(ctx, dest, when, 0.5, dur));
  };
}

function riser(opts: { from: number; to: number; dur: number }): SynthFn {
  return (ctx, dest, when, p) => {
    const dur = opts.dur * p.decay;
    const n = noiseSource(ctx, when, dur);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(opts.from * p.pitch, when);
    bp.frequency.exponentialRampToValueAtTime(opts.to * p.pitch, when + dur);
    bp.Q.value = 2;
    n.connect(bp);
    const g = ctx.createGain();
    g.gain.setValueAtTime(SILENT, when);
    g.gain.exponentialRampToValueAtTime(0.7, when + dur);
    g.gain.setTargetAtTime(SILENT, when + dur, 0.05);
    bp.connect(g);
    g.connect(dest);
  };
}

function vinylStop(): SynthFn {
  return (ctx, dest, when, p) => {
    const dur = 0.45 * p.decay;
    // Tone and noise both falling in pitch/level sells the "power down".
    const o = osc(ctx, "triangle", 400 * p.pitch, when, dur);
    o.frequency.exponentialRampToValueAtTime(30, when + dur);
    o.connect(decayGain(ctx, dest, when, 0.6, dur));

    const n = noiseSource(ctx, when, dur);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(4000 * p.pitch, when);
    lp.frequency.exponentialRampToValueAtTime(100, when + dur);
    n.connect(lp);
    lp.connect(decayGain(ctx, dest, when, 0.3, dur));
  };
}

function sweep(opts: { from: number; to: number; dur: number }): SynthFn {
  return (ctx, dest, when, p) => {
    const dur = opts.dur * p.decay;
    const o = osc(ctx, "sawtooth", 110 * p.pitch, when, dur);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 8;
    lp.frequency.setValueAtTime(opts.from * p.pitch, when);
    lp.frequency.exponentialRampToValueAtTime(opts.to * p.pitch, when + dur);
    o.connect(lp);
    lp.connect(decayGain(ctx, dest, when, 0.45, dur));
  };
}

function zap(opts: { freq: number; dur: number }): SynthFn {
  return (ctx, dest, when, p) => {
    const dur = opts.dur * p.decay;
    const o = osc(ctx, "square", opts.freq * p.pitch, when, dur);
    // Fast vibrato reads as "zap".
    const lfo = osc(ctx, "sine", 35, when, dur);
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = opts.freq * 0.6;
    lfo.connect(lfoGain);
    lfoGain.connect(o.frequency);
    o.connect(decayGain(ctx, dest, when, 0.4, dur));
  };
}

// 303-style squelch: saw through a resonant lowpass that sweeps down.
function acid(opts: { freq: number; decay: number }): SynthFn {
  return (ctx, dest, when, p) => {
    const dur = opts.decay * p.decay;
    const f = opts.freq * p.pitch;
    const o = osc(ctx, "sawtooth", f, when, dur);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 14;
    lp.frequency.setValueAtTime(f * 9, when);
    lp.frequency.exponentialRampToValueAtTime(f * 1.2, when + dur * 0.7);
    o.connect(lp);
    lp.connect(decayGain(ctx, dest, when, 0.7, dur));
  };
}

// Two-operator FM: modulator drives the carrier's frequency.
function fm(opts: { freq: number; ratio: number; index: number; decay: number }): SynthFn {
  return (ctx, dest, when, p) => {
    const dur = opts.decay * p.decay;
    const f = opts.freq * p.pitch;
    const carrier = osc(ctx, "sine", f, when, dur);
    const mod = osc(ctx, "sine", f * opts.ratio, when, dur);
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(f * opts.index, when);
    modGain.gain.exponentialRampToValueAtTime(SILENT, when + dur);
    mod.connect(modGain);
    modGain.connect(carrier.frequency);
    carrier.connect(decayGain(ctx, dest, when, 0.7, dur));
  };
}

// Dubstep-ish wobble: saw with an LFO shaking a lowpass.
function wobble(opts: { freq: number; rate: number; decay: number }): SynthFn {
  return (ctx, dest, when, p) => {
    const dur = opts.decay * p.decay;
    const o = osc(ctx, "sawtooth", opts.freq * p.pitch, when, dur);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 6;
    lp.frequency.value = 700;
    const lfo = osc(ctx, "sine", opts.rate, when, dur);
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 550;
    lfo.connect(lfoGain);
    lfoGain.connect(lp.frequency);
    o.connect(lp);
    lp.connect(decayGain(ctx, dest, when, 0.6, dur));
  };
}

// Plucky synth-lead note: two detuned saws through a closing lowpass.
function leadNote(freq: number): SynthFn {
  return (ctx, dest, when, p) => {
    const dur = 0.4 * p.decay;
    const f = freq * p.pitch;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 3;
    lp.frequency.setValueAtTime(f * 6, when);
    lp.frequency.exponentialRampToValueAtTime(f * 1.5, when + dur);
    lp.connect(decayGain(ctx, dest, when, 0.55, dur));
    for (const cents of [-6, 6]) {
      const o = osc(ctx, "sawtooth", f, when, dur);
      o.detune.value = cents;
      o.connect(lp);
    }
  };
}

function crash(opts: { decay: number }): SynthFn {
  return (ctx, dest, when, p) => {
    const dur = opts.decay * p.decay;
    const n = noiseSource(ctx, when, dur);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 4500 * p.pitch;
    n.connect(hp);
    hp.connect(decayGain(ctx, dest, when, 0.6, dur));
  };
}

// ---------------------------------------------------------------------------
// Kits — pad index 0 is hardware pad 1 (bottom-left of the 4x4 grid).

const C = {
  red: "red",
  purple: "purple",
  blue: "blue",
  cyan: "cyan",
  amber: "amber",
} as const;

const KIT_808: Kit = {
  id: "eight08",
  name: "808",
  pads: [
    { label: "KICK", color: C.red, play: kick({ start: 150, end: 45, drop: 0.08, decay: 0.45, click: 0.4 }) },
    { label: "KICK 2", color: C.amber, play: kick({ start: 200, end: 60, drop: 0.06, decay: 0.3, click: 0.5 }) },
    { label: "SNARE", color: C.cyan, play: snare({ noiseFreq: 1800, noiseDecay: 0.2, bodyFreq: 180, bodyDecay: 0.1 }) },
    { label: "CLAP", color: C.blue, play: clap({ freq: 1200, decay: 0.18 }) },
    { label: "HAT", color: C.cyan, play: hat({ decay: 0.05 }) },
    { label: "OPEN HAT", color: C.amber, play: hat({ decay: 0.4 }) },
    { label: "SNAP", color: C.purple, play: snare({ noiseFreq: 2400, noiseDecay: 0.08, bodyFreq: 240, bodyDecay: 0.04 }) },
    { label: "RIM", color: C.blue, play: blip({ freq: 1700, decay: 0.04 }) },
    { label: "TOM LO", color: C.blue, play: tom({ freq: 100, decay: 0.32 }) },
    { label: "TOM MID", color: C.purple, play: tom({ freq: 140, decay: 0.28 }) },
    { label: "TOM HI", color: C.purple, play: tom({ freq: 200, decay: 0.24 }) },
    { label: "COWBELL", color: C.amber, play: bell({ f1: 540, f2: 800, decay: 0.12, freq: 700 }) },
    { label: "BASS", color: C.red, play: kick({ start: 80, end: 50, drop: 0.3, decay: 0.5, wave: "triangle" }) },
    { label: "SHAKER", color: C.cyan, play: hat({ decay: 0.09, freq: 5500 }) },
    { label: "CRASH", color: C.amber, play: crash({ decay: 1.1 }) },
    { label: "PERC", color: C.red, play: blip({ freq: 880, decay: 0.07, wave: "triangle" }) },
  ],
};

const KIT_ACOUSTIC: Kit = {
  id: "acoustic",
  name: "Acoustic",
  pads: [
    { label: "KICK", color: C.red, play: kick({ start: 220, end: 55, drop: 0.04, decay: 0.22, click: 0.7, wave: "triangle" }) },
    { label: "KICK 2", color: C.amber, play: kick({ start: 180, end: 50, drop: 0.05, decay: 0.28, click: 0.6 }) },
    { label: "SNARE", color: C.cyan, play: snare({ noiseFreq: 2200, noiseDecay: 0.25, bodyFreq: 200, bodyDecay: 0.12 }) },
    { label: "SIDE STK", color: C.blue, play: blip({ freq: 1400, decay: 0.05, wave: "triangle" }) },
    { label: "HAT", color: C.cyan, play: hat({ decay: 0.06, metallic: true }) },
    { label: "OPEN HAT", color: C.amber, play: hat({ decay: 0.5, metallic: true }) },
    { label: "GHOST SN", color: C.purple, play: snare({ noiseFreq: 2000, noiseDecay: 0.1, bodyFreq: 190, bodyDecay: 0.06 }) },
    { label: "RIDE", color: C.blue, play: hat({ decay: 0.9, freq: 5000, metallic: true }) },
    { label: "FLOOR TOM", color: C.blue, play: tom({ freq: 85, decay: 0.45 }) },
    { label: "TOM MID", color: C.purple, play: tom({ freq: 130, decay: 0.35 }) },
    { label: "TOM HI", color: C.purple, play: tom({ freq: 190, decay: 0.3 }) },
    { label: "STICKS", color: C.amber, play: blip({ freq: 2200, decay: 0.03 }) },
    { label: "KICK SOFT", color: C.red, play: kick({ start: 160, end: 55, drop: 0.05, decay: 0.18, peak: 0.6 }) },
    { label: "BRUSH", color: C.cyan, play: hat({ decay: 0.16, freq: 3500 }) },
    { label: "CRASH", color: C.amber, play: crash({ decay: 1.6 }) },
    { label: "SPLASH", color: C.red, play: crash({ decay: 0.5 }) },
  ],
};

const KIT_SYNTH: Kit = {
  id: "synth",
  name: "Synth",
  pads: [
    { label: "BOOM", color: C.red, play: kick({ start: 120, end: 35, drop: 0.15, decay: 0.7 }) },
    { label: "KNOCK", color: C.amber, play: kick({ start: 300, end: 90, drop: 0.03, decay: 0.12, wave: "triangle" }) },
    { label: "ZAP SN", color: C.cyan, play: snare({ noiseFreq: 1500, noiseDecay: 0.15, bodyFreq: 320, bodyDecay: 0.08, bodyWave: "sawtooth" }) },
    { label: "CLAP", color: C.blue, play: clap({ freq: 1600, decay: 0.25 }) },
    { label: "TICK", color: C.cyan, play: hat({ decay: 0.03, freq: 9000 }) },
    { label: "HISS", color: C.amber, play: hat({ decay: 0.6, freq: 6000 }) },
    { label: "BLEEP", color: C.purple, play: blip({ freq: 660, decay: 0.09 }) },
    { label: "BLOOP", color: C.blue, play: blip({ freq: 330, decay: 0.12, wave: "sine" }) },
    { label: "SUB LO", color: C.blue, play: tom({ freq: 55, decay: 0.5 }) },
    { label: "SUB MID", color: C.purple, play: tom({ freq: 82, decay: 0.4 }) },
    { label: "PLUCK", color: C.purple, play: blip({ freq: 440, decay: 0.15, wave: "sawtooth" }) },
    { label: "CHIME", color: C.amber, play: bell({ f1: 880, f2: 1320, decay: 0.4, freq: 1100 }) },
    { label: "DROP", color: C.red, play: laser({ from: 600, to: 80, dur: 0.25, wave: "square" }) },
    { label: "NOISE", color: C.cyan, play: hat({ decay: 0.2, freq: 2500 }) },
    { label: "WASH", color: C.amber, play: crash({ decay: 0.9 }) },
    { label: "STAB", color: C.red, play: bell({ f1: 220, f2: 277, decay: 0.18, freq: 600 }) },
  ],
};

const KIT_FX: Kit = {
  id: "fx",
  name: "FX",
  pads: [
    { label: "LASER", color: C.red, play: laser({ from: 2000, to: 100, dur: 0.3 }) },
    { label: "LASER 2", color: C.amber, play: laser({ from: 3200, to: 300, dur: 0.18, wave: "square" }) },
    { label: "RISER", color: C.cyan, play: riser({ from: 200, to: 4000, dur: 1.0 }) },
    { label: "RISER 2", color: C.blue, play: riser({ from: 500, to: 8000, dur: 0.5 }) },
    { label: "VINYL STP", color: C.cyan, play: vinylStop() },
    { label: "SWEEP UP", color: C.amber, play: sweep({ from: 200, to: 6000, dur: 0.6 }) },
    { label: "SWEEP DN", color: C.purple, play: sweep({ from: 6000, to: 150, dur: 0.6 }) },
    { label: "ZAP", color: C.blue, play: zap({ freq: 700, dur: 0.2 }) },
    { label: "ZAP 2", color: C.blue, play: zap({ freq: 300, dur: 0.35 }) },
    { label: "FALL", color: C.purple, play: laser({ from: 900, to: 60, dur: 0.7, wave: "triangle" }) },
    { label: "SIREN", color: C.purple, play: zap({ freq: 950, dur: 0.6 }) },
    { label: "CHIME", color: C.amber, play: bell({ f1: 1760, f2: 2640, decay: 0.6, freq: 2000 }) },
    { label: "IMPACT", color: C.red, play: kick({ start: 90, end: 25, drop: 0.2, decay: 0.9, click: 0.6 }) },
    { label: "STATIC", color: C.cyan, play: hat({ decay: 0.35, freq: 1500 }) },
    { label: "BOOM FX", color: C.amber, play: crash({ decay: 2.0 }) },
    { label: "POWER DN", color: C.red, play: laser({ from: 440, to: 28, dur: 1.1, wave: "sawtooth" }) },
  ],
};

const KIT_ELECTRO: Kit = {
  id: "electro",
  name: "Electro",
  pads: [
    { label: "E KICK", color: C.red, play: kick({ start: 160, end: 40, drop: 0.05, decay: 0.35, click: 0.6 }) },
    { label: "ZAP KICK", color: C.amber, play: kick({ start: 320, end: 45, drop: 0.04, decay: 0.2, click: 0.3, wave: "square" }) },
    { label: "E SNARE", color: C.cyan, play: snare({ noiseFreq: 2600, noiseDecay: 0.18, bodyFreq: 260, bodyDecay: 0.07, bodyWave: "sawtooth" }) },
    { label: "E CLAP", color: C.blue, play: clap({ freq: 2000, decay: 0.2 }) },
    { label: "ACID LO", color: C.purple, play: acid({ freq: 55, decay: 0.3 }) },
    { label: "ACID MID", color: C.purple, play: acid({ freq: 73.4, decay: 0.28 }) },
    { label: "ACID HI", color: C.purple, play: acid({ freq: 98, decay: 0.26 }) },
    { label: "BUZZ", color: C.blue, play: blip({ freq: 110, decay: 0.14 }) },
    { label: "FM STAB", color: C.red, play: fm({ freq: 220, ratio: 2.01, index: 4, decay: 0.22 }) },
    { label: "FM BELL", color: C.amber, play: fm({ freq: 440, ratio: 3.5, index: 2, decay: 0.45 }) },
    { label: "WOBBLE", color: C.blue, play: wobble({ freq: 65, rate: 8, decay: 0.5 }) },
    { label: "WOBBLE 2", color: C.cyan, play: wobble({ freq: 98, rate: 14, decay: 0.4 }) },
    { label: "E HAT", color: C.cyan, play: hat({ decay: 0.04, freq: 8500 }) },
    { label: "E OPEN", color: C.amber, play: hat({ decay: 0.35, freq: 7500, metallic: true }) },
    { label: "GLITCH", color: C.red, play: zap({ freq: 1800, dur: 0.08 }) },
    { label: "E CRASH", color: C.amber, play: crash({ decay: 0.8 }) },
  ],
};

// A-minor pentatonic across three octaves: the pads become a playable
// synthesizer (low notes bottom-left, like the pad numbering).
const LEAD_NOTES: Array<[string, number]> = [
  ["A2", 110.0], ["C3", 130.81], ["D3", 146.83], ["E3", 164.81],
  ["G3", 196.0], ["A3", 220.0], ["C4", 261.63], ["D4", 293.66],
  ["E4", 329.63], ["G4", 392.0], ["A4", 440.0], ["C5", 523.25],
  ["D5", 587.33], ["E5", 659.26], ["G5", 783.99], ["A5", 880.0],
];
const LEAD_ROW_COLORS: PadColor[] = ["red", "amber", "purple", "cyan"];

const KIT_LEAD: Kit = {
  id: "lead",
  name: "Lead",
  pads: LEAD_NOTES.map(([label, freq], i) => ({
    label,
    color: LEAD_ROW_COLORS[Math.floor(i / 4)],
    play: leadNote(freq),
  })),
};

export const KITS: Kit[] = [KIT_808, KIT_ACOUSTIC, KIT_SYNTH, KIT_FX, KIT_ELECTRO, KIT_LEAD];

