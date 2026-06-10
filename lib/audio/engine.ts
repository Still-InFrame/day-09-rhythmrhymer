// Audio engine: lazy AudioContext singleton + the master bus.
//
// Graph:
//   synth voices -> padGain[i] (x16) -> masterGain -> analyser -> destination
//                                                  -> streamDest (recording tap)
//
// streamDest is wired up front so recording is a pure consumer of the bus;
// swapping the export format later never touches this file.

export interface Engine {
  ctx: AudioContext;
  masterGain: GainNode;
  // Performance sweep filter after the master gain; speakers, recorder, and
  // visualizer all hear it.
  masterFilter: BiquadFilterNode;
  analyser: AnalyserNode;
  streamDest: MediaStreamAudioDestinationNode;
  padGains: GainNode[];
  // Per-pad soft-clip stage feeding the pad gain; null curve = bypass.
  padShapers: WaveShaperNode[];
}

// DJ-style bipolar filter knob: 0.5 = open/neutral, toward 0 = lowpass
// closing down to 80Hz, toward 1 = highpass rising to 8kHz.
export function applyFilterPosition(filter: BiquadFilterNode, pos: number): void {
  if (pos < 0.5) {
    filter.type = "lowpass";
    const t = pos / 0.5; // 0 -> fully closed, 1 -> open
    filter.frequency.value = 80 * Math.pow(20000 / 80, t);
  } else {
    filter.type = "highpass";
    const t = (pos - 0.5) / 0.5; // 0 -> open, 1 -> fully thinned
    filter.frequency.value = 20 * Math.pow(8000 / 20, t);
  }
}

// tanh soft-clip, normalized so the peak stays at 1 regardless of drive.
// Cached per 2-decimal drive value — a knob drag reuses ~100 curves at most.
const curveCache = new Map<number, Float32Array<ArrayBuffer>>();

export function distortionCurve(drive: number): Float32Array<ArrayBuffer> | null {
  if (drive <= 0.001) return null;
  const key = Math.round(drive * 100) / 100;
  let curve = curveCache.get(key);
  if (!curve) {
    const k = 1 + key * 24;
    const n = 257;
    curve = new Float32Array(n);
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / norm;
    }
    curveCache.set(key, curve);
  }
  return curve;
}

const PAD_COUNT = 16;

let engine: Engine | null = null;

// Must be called from a user gesture the first time (autoplay policy).
export function getEngine(): Engine {
  if (!engine) {
    const ctx = new AudioContext();

    const masterGain = ctx.createGain();
    masterGain.gain.value = 0.9;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;

    const streamDest = ctx.createMediaStreamDestination();

    const masterFilter = ctx.createBiquadFilter();
    masterFilter.Q.value = 0.9;
    applyFilterPosition(masterFilter, 0.5);

    masterGain.connect(masterFilter);
    masterFilter.connect(analyser);
    analyser.connect(ctx.destination);
    masterFilter.connect(streamDest);

    const padGains: GainNode[] = [];
    const padShapers: WaveShaperNode[] = [];
    for (let i = 0; i < PAD_COUNT; i++) {
      const g = ctx.createGain();
      g.connect(masterGain);
      const s = ctx.createWaveShaper();
      s.oversample = "2x";
      s.connect(g);
      padGains.push(g);
      padShapers.push(s);
    }

    engine = { ctx, masterGain, masterFilter, analyser, streamDest, padGains, padShapers };
  }

  // Safari/iOS suspend the context aggressively; resume on every entry gesture.
  if (engine.ctx.state === "suspended") {
    void engine.ctx.resume();
  }

  return engine;
}
