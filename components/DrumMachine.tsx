"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyFilterPosition,
  distortionCurve,
  getEngine,
  type Engine,
} from "@/lib/audio/engine";
import { KITS, type SynthParams } from "@/lib/audio/kits";
import { Sequencer, STEPS } from "@/lib/audio/sequencer";
import { Recorder, extensionFor } from "@/lib/audio/recorder";
import { MicSampler } from "@/lib/audio/sampler";
import { Pad } from "./Pad";
import { Knob } from "./Knob";
import { Fader } from "./Fader";
import { StepGrid } from "./StepGrid";
import { Visualizer } from "./Visualizer";

const PAD_COUNT = 16;
// Hardware layout: pad 1 bottom-left, pad 13 top-left (render order is rows
// top-to-bottom, so start with the top row indices).
const RENDER_ORDER = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3];
const BANK_LABELS = ["A", "B", "C", "D", "E", "F"];

// One step layer and one params set PER KIT: banks stack additively, so a
// beat programmed on A keeps looping while you build on B-D.
// Keyboard play: a 4x4 block on the right of the keyboard mirrors the pad
// grid spatially (top row "7890" = top pad row), so the left hand stays free
// for kit keys 1-6 and Space (play/stop).
const KEY_TO_PAD: Record<string, number> = {
  "7": 12, "8": 13, "9": 14, "0": 15,
  u: 8, i: 9, o: 10, p: 11,
  h: 4, j: 5, k: 6, l: 7,
  n: 0, m: 1, ",": 2, ".": 3,
};

const PAD_KEY_HINT: string[] = (() => {
  const hints = Array<string>(PAD_COUNT).fill("");
  for (const [key, pad] of Object.entries(KEY_TO_PAD)) hints[pad] = key.toUpperCase();
  return hints;
})();

// Four independent project slots plus a pointer to the active one. The
// pre-slots key is migrated into slot 1 on first load.
const LEGACY_STORAGE_KEY = "rhythmrhymer-v1";
const SLOT_COUNT = 4;
const slotKey = (n: number) => `rhythmrhymer-v1-slot${n}`;
const SLOT_POINTER_KEY = "rhythmrhymer-active-slot";
const SCENE_COUNT = 4;

// Share-by-URL: deflate the project JSON and pack it base64url into ?beat=.
// A mostly-empty project compresses to a few hundred bytes.
function bufToBase64Url(buf: ArrayBuffer): string {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBuf(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function encodeShare(obj: unknown): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(JSON.stringify(obj))])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return bufToBase64Url(await new Response(stream).arrayBuffer());
}

async function decodeShare(s: string): Promise<unknown> {
  const stream = new Blob([base64UrlToBuf(s) as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return JSON.parse(await new Response(stream).text());
}

// Restore helpers tolerate saves written by older versions (fewer kits,
// missing fields, corrupted JSON) by merging into fresh defaults.
function clampNum(x: unknown, min: number, max: number, fallback: number): number {
  return typeof x === "number" && Number.isFinite(x)
    ? Math.min(max, Math.max(min, x))
    : fallback;
}

function restoreSteps(saved: unknown): boolean[][][] {
  const out = emptySteps();
  if (!Array.isArray(saved)) return out;
  for (let k = 0; k < Math.min(saved.length, out.length); k++) {
    const layer = saved[k];
    if (!Array.isArray(layer)) continue;
    for (let p = 0; p < Math.min(layer.length, PAD_COUNT); p++) {
      const row = layer[p];
      if (!Array.isArray(row)) continue;
      for (let s = 0; s < Math.min(row.length, STEPS); s++) {
        out[k][p][s] = row[s] === true;
      }
    }
  }
  return out;
}

function restoreParams(saved: unknown): SynthParams[][] {
  const out = neutralParams();
  if (!Array.isArray(saved)) return out;
  for (let k = 0; k < Math.min(saved.length, out.length); k++) {
    const layer = saved[k];
    if (!Array.isArray(layer)) continue;
    for (let p = 0; p < Math.min(layer.length, PAD_COUNT); p++) {
      const v = layer[p] as Partial<SynthParams> | null;
      if (!v || typeof v !== "object") continue;
      out[k][p] = {
        volume: clampNum(v.volume, 0, 2, 1),
        pitch: clampNum(v.pitch, 0.5, 2, 1),
        decay: clampNum(v.decay, 0.25, 2, 1),
        drive: clampNum(v.drive, 0, 1, 0),
      };
    }
  }
  return out;
}

const emptySteps = () =>
  Array.from({ length: KITS.length }, () =>
    Array.from({ length: PAD_COUNT }, () => Array<boolean>(STEPS).fill(false)),
  );

const neutralParams = (): SynthParams[][] =>
  Array.from({ length: KITS.length }, () =>
    Array.from({ length: PAD_COUNT }, () => ({ volume: 1, pitch: 1, decay: 1, drive: 0 })),
  );

export function DrumMachine() {
  // --- state (UI source of truth) ------------------------------------------
  const [steps, _setSteps] = useState<boolean[][][]>(emptySteps);
  const [bpm, _setBpm] = useState(120);
  const [padParams, _setPadParams] = useState<SynthParams[][]>(neutralParams);
  const [kitIndex, _setKitIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [selectedPad, setSelectedPad] = useState(0);
  const [flashSeq, setFlashSeq] = useState<number[]>(() => Array(PAD_COUNT).fill(0));
  const [masterVolume, setMasterVolume] = useState(0.9);
  const [swing, _setSwing] = useState(0.5); // 0.5 straight .. 0.75 shuffle
  const [filterPos, setFilterPos] = useState(0.5); // bipolar sweep, 0.5 = open
  const [muted, _setMuted] = useState<boolean[]>(() => KITS.map(() => false));
  const [recording, setRecording] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [tapViz, setTapViz] = useState(false);
  // Mic samples override a pad's synth; buffers live in a ref (not state),
  // the boolean map mirrors them for UI.
  const [sampled, setSampled] = useState<boolean[][]>(() =>
    KITS.map(() => Array<boolean>(PAD_COUNT).fill(false)),
  );
  const [micState, setMicState] = useState<"idle" | "recording" | "blocked">("idle");
  // A finished take waiting for the user to pick its pad ("assign mode").
  const [pendingSample, setPendingSample] = useState<AudioBuffer | null>(null);
  // Two-tap confirm for pattern clear; disarms after a beat or on bank switch.
  const [clearArmed, setClearArmed] = useState(false);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Live loop recording: while armed and playing, taps quantize into steps.
  const [liveArmed, setLiveArmed] = useState(false);
  const liveArmedRef = useRef(false);
  // Count-in beats remaining before live recording starts (null = inactive).
  const [countIn, setCountIn] = useState<number | null>(null);
  const countTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Undo ring for pattern mutations (toggles, live taps, clears).
  const historyRef = useRef<boolean[][][][]>([]);
  const [undoCount, setUndoCount] = useState(0);
  // Project slots + share feedback.
  const [currentSlot, setCurrentSlot] = useState(0);
  const [shareState, setShareState] = useState<"idle" | "copied" | "failed">("idle");
  // A beat imported from a share URL stays UNSAVED (autosave suspended,
  // slot switching locked) until the user places it in a slot or discards it.
  const [importPending, setImportPending] = useState(false);
  const [importEmpty, setImportEmpty] = useState<boolean[]>(() =>
    Array(SLOT_COUNT).fill(true),
  );
  const [importArmed, setImportArmed] = useState<number | null>(null);
  const importArmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Scenes: 4 full pattern sets (all banks). `steps` is always the ACTIVE
  // scene's working copy; the others wait in scenesRef. While playing, a
  // scene change is queued and committed exactly on the next bar boundary.
  const [activeScene, setActiveScene] = useState(0);
  const activeSceneRef = useRef(0);
  const [pendingScene, setPendingScene] = useState<number | null>(null);
  const pendingSceneRef = useRef<number | null>(null);
  const scenesRef = useRef<boolean[][][][]>(
    Array.from({ length: SCENE_COUNT }, () => emptySteps()),
  );
  // Render-safe mirror of which INACTIVE scenes hold content (the active
  // scene's dot derives from `steps` state directly).
  const [sceneDots, setSceneDots] = useState<boolean[]>(() =>
    Array(SCENE_COUNT).fill(false),
  );
  const computeSceneDots = () =>
    scenesRef.current.map((sc) => sc.some((l) => l.some((r) => r.some(Boolean))));
  // Steps written by a forward-quantized tap whose first scheduled hit must
  // be swallowed (the tap itself already sounded). Keys: "kit:pad:step".
  const suppressRef = useRef<Set<string>>(new Set());

  // --- refs mirrored from state: the scheduler reads these, never closures --
  const stepsRef = useRef(steps);
  const bpmRef = useRef(bpm);
  const padParamsRef = useRef(padParams);
  const kitIndexRef = useRef(kitIndex);
  const masterVolumeRef = useRef(masterVolume);
  const swingRef = useRef(swing);
  const filterPosRef = useRef(filterPos);
  const mutedRef = useRef(muted);

  const setSteps = useCallback((updater: (prev: boolean[][][]) => boolean[][][]) => {
    _setSteps((prev) => {
      const next = updater(prev);
      stepsRef.current = next;
      return next;
    });
  }, []);
  const setBpm = useCallback((v: number) => {
    bpmRef.current = v;
    _setBpm(v);
  }, []);
  const setPadParams = useCallback((updater: (prev: SynthParams[][]) => SynthParams[][]) => {
    _setPadParams((prev) => {
      const next = updater(prev);
      padParamsRef.current = next;
      return next;
    });
  }, []);
  const setSwing = useCallback((v: number) => {
    swingRef.current = v;
    _setSwing(v);
  }, []);
  const setMuted = useCallback((updater: (prev: boolean[]) => boolean[]) => {
    _setMuted((prev) => {
      const next = updater(prev);
      mutedRef.current = next;
      return next;
    });
  }, []);
  const setKitIndex = useCallback((v: number) => {
    kitIndexRef.current = v;
    _setKitIndex(v);
    // An armed clear must not carry over to a different bank.
    setClearArmed(false);
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
  }, []);

  // --- audio objects ---------------------------------------------------------
  const engineRef = useRef<Engine | null>(null);
  const seqRef = useRef<Sequencer | null>(null);
  const recRef = useRef<Recorder | null>(null);
  const vizTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const samplerRef = useRef<MicSampler | null>(null);
  // Note repeat: pads held down retrigger on 16ths. Map of pad -> next
  // scheduled trigger time on the audio clock; one shared lookahead timer.
  const heldPadsRef = useRef<Map<number, number>>(new Map());
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const overridesRef = useRef<(AudioBuffer | null)[][]>(
    KITS.map(() => Array<AudioBuffer | null>(PAD_COUNT).fill(null)),
  );

  const ensureEngine = useCallback((): Engine => {
    const eng = getEngine();
    if (!engineRef.current) {
      engineRef.current = eng;
      eng.masterGain.gain.value = masterVolumeRef.current;
      applyFilterPosition(eng.masterFilter, filterPosRef.current);
      setAnalyser(eng.analyser);
    }
    return eng;
  }, []);

  const markAudible = useCallback(() => {
    setTapViz(true);
    if (vizTimerRef.current) clearTimeout(vizTimerRef.current);
    vizTimerRef.current = setTimeout(() => setTapViz(false), 2000);
  }, []);

  // Swap the working pattern for another scene's. Refs are updated
  // synchronously so the scheduler (which may be mid-tick) reads the new
  // scene immediately; React state follows for the UI. Undo history is
  // cleared — its snapshots belong to the outgoing scene.
  const commitScene = useCallback((next: number) => {
    if (next === activeSceneRef.current) {
      pendingSceneRef.current = null;
      setPendingScene(null);
      return;
    }
    scenesRef.current[activeSceneRef.current] = stepsRef.current;
    stepsRef.current = scenesRef.current[next];
    activeSceneRef.current = next;
    pendingSceneRef.current = null;
    _setSteps(stepsRef.current);
    setActiveScene(next);
    setPendingScene(null);
    setSceneDots(computeSceneDots());
    historyRef.current = [];
    setUndoCount(0);
  }, []);

  const requestScene = useCallback(
    (next: number) => {
      if (seqRef.current?.playing) {
        // Toggle off a queued request; otherwise queue (or re-target).
        if (pendingSceneRef.current === next || next === activeSceneRef.current) {
          pendingSceneRef.current = null;
          setPendingScene(null);
        } else {
          pendingSceneRef.current = next;
          setPendingScene(next);
        }
      } else {
        commitScene(next);
      }
    },
    [commitScene],
  );

  // Snapshot the pattern state before a mutation so it can be undone.
  const pushHistory = useCallback(() => {
    const stack = historyRef.current;
    stack.push(stepsRef.current);
    if (stack.length > 30) stack.shift();
    setUndoCount(stack.length);
  }, []);

  const undo = useCallback(() => {
    const prev = historyRef.current.pop();
    setUndoCount(historyRef.current.length);
    if (prev) setSteps(() => prev);
  }, [setSteps]);

  // Metronome click — wired straight to the speakers, NOT the master bus,
  // so count-ins and live-record clicks never end up in recordings.
  const click = useCallback((when: number, accent: boolean) => {
    const eng = engineRef.current;
    if (!eng) return;
    const o = eng.ctx.createOscillator();
    o.type = "square";
    o.frequency.value = accent ? 1800 : 1200;
    const g = eng.ctx.createGain();
    g.gain.setValueAtTime(0.22, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.04);
    o.connect(g);
    g.connect(eng.ctx.destination);
    o.start(when);
    o.stop(when + 0.06);
  }, []);

  const flash = useCallback((pad: number) => {
    setFlashSeq((prev) => {
      const next = [...prev];
      next[pad]++;
      return next;
    });
  }, []);

  // Reads refs only — safe to call from the scheduler.
  const triggerPad = useCallback(
    (kit: number, pad: number, when?: number) => {
      const eng = ensureEngine();
      const params = padParamsRef.current[kit][pad];
      eng.padGains[pad].gain.value = params.volume;
      // Voices feed the shaper (soft-clip), which feeds the pad gain.
      eng.padShapers[pad].curve = distortionCurve(params.drive);
      const dest = eng.padShapers[pad];
      const t = when ?? eng.ctx.currentTime;

      // A mic sample on this pad replaces the synth voice; pitch bends the
      // playback rate and decay shortens the tail.
      const sample = overridesRef.current[kit][pad];
      if (sample) {
        const src = eng.ctx.createBufferSource();
        src.buffer = sample;
        src.playbackRate.value = params.pitch;
        const dur = sample.duration * Math.min(1, params.decay);
        const g = eng.ctx.createGain();
        g.gain.setValueAtTime(1, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        src.connect(g);
        g.connect(dest);
        src.start(t);
        src.stop(t + dur + 0.02);
        return;
      }

      KITS[kit].pads[pad].play(eng.ctx, dest, t, params);
    },
    [ensureEngine],
  );

  const ensureSequencer = useCallback((): Sequencer => {
    if (!seqRef.current) {
      const eng = ensureEngine();
      seqRef.current = new Sequencer({
        ctx: eng.ctx,
        getBpm: () => bpmRef.current,
        getSwing: () => swingRef.current,
        getSteps: () => stepsRef.current,
        onSchedule: (kit, pad, when, step) => {
          // Muted layers keep their pattern but stay silent.
          if (mutedRef.current[kit]) return;
          // A just-recorded live tap already sounded; skip its first pass.
          const skey = `${kit}:${pad}:${step}`;
          if (suppressRef.current.has(skey)) {
            suppressRef.current.delete(skey);
            return;
          }
          triggerPad(kit, pad, when);
          // Only flash pads belonging to the layer currently on screen.
          if (kit === kitIndexRef.current) {
            const delay = Math.max(0, (when - eng.ctx.currentTime) * 1000);
            setTimeout(() => {
              if (kit === kitIndexRef.current) flash(pad);
            }, delay);
          }
        },
        onStepUI: (step, when) => {
          // Quarter-note metronome while live recording is armed.
          if (liveArmedRef.current && step % 4 === 0) click(when, step === 0);
          const delay = Math.max(0, (when - eng.ctx.currentTime) * 1000);
          setTimeout(() => setCurrentStep(step), delay);
        },
        onBarStart: () => {
          // Quantized scene change: swap before the bar's steps schedule.
          const next = pendingSceneRef.current;
          if (next !== null) commitScene(next);
        },
      });
    }
    return seqRef.current;
  }, [ensureEngine, triggerPad, flash, click, commitScene]);

  // Reads refs only — repeats stay in time with live BPM changes.
  // A normal tap keeps the finger down ~100-200ms, which is longer than one
  // 16th at most tempos — so the FIRST repeat waits out a hold threshold to
  // keep taps single hits. Subsequent repeats run at straight 16ths.
  const HOLD_THRESHOLD = 0.2;
  // Unlike the sequencer, repeats are committed only moments before they
  // sound: a release can't cancel audio that's already scheduled, so a long
  // lookahead here would replay hits after the finger lifts. 30ms still
  // covers the 25ms tick cadence.
  const HOLD_LOOKAHEAD = 0.03;
  const startHold = useCallback(
    (pad: number) => {
      const eng = ensureEngine();
      const stepSec = () => 60 / bpmRef.current / 4;
      heldPadsRef.current.set(
        pad,
        eng.ctx.currentTime + Math.max(stepSec(), HOLD_THRESHOLD),
      );
      if (holdTimerRef.current) return;
      holdTimerRef.current = setInterval(() => {
        const now = eng.ctx.currentTime;
        heldPadsRef.current.forEach((next, p) => {
          let n = next;
          while (n < now + HOLD_LOOKAHEAD) {
            triggerPad(kitIndexRef.current, p, n);
            const delay = Math.max(0, (n - now) * 1000);
            setTimeout(() => flash(p), delay);
            n += stepSec();
          }
          heldPadsRef.current.set(p, n);
        });
        markAudible();
      }, 25);
    },
    [ensureEngine, triggerPad, flash, markAudible],
  );

  const endHold = useCallback((pad: number) => {
    heldPadsRef.current.delete(pad);
    if (heldPadsRef.current.size === 0 && holdTimerRef.current) {
      clearInterval(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      seqRef.current?.stop();
      if (vizTimerRef.current) clearTimeout(vizTimerRef.current);
      if (holdTimerRef.current) clearInterval(holdTimerRef.current);
      countTimersRef.current.forEach(clearTimeout);
    };
  }, []);

  // --- handlers --------------------------------------------------------------
  const handlePadDown = (pad: number) => {
    // Assign mode: tapping a free pad claims the pending take for it (and the
    // trigger below previews it). Occupied pads keep playing normally.
    let didAssign = false;
    if (pendingSample && !sampled[kitIndex][pad]) {
      overridesRef.current[kitIndex][pad] = pendingSample;
      setSampled((prev) =>
        prev.map((row, k) =>
          k === kitIndex ? row.map((v, i) => (i === pad ? true : v)) : row,
        ),
      );
      setPendingSample(null);
      didAssign = true;
    }
    triggerPad(kitIndex, pad);
    flash(pad);
    setSelectedPad(pad);
    markAudible();
    startHold(pad); // note repeat while held; released by handlePadUp

    // Live recording: snap this tap to the nearest 16th and write it into
    // the loop (assignment taps are placement, not performance).
    const seq = seqRef.current;
    const eng = engineRef.current;
    if (liveArmed && !didAssign && seq?.playing && eng) {
      const { step, nextNoteTime, secondsPerStep } = seq.getCurrentStepInfo();
      const toNext = nextNoteTime - eng.ctx.currentTime;
      let target: number;
      if (toNext <= secondsPerStep / 2) {
        // Early tap: snap forward; swallow the imminent scheduled hit since
        // the tap itself was the performance.
        target = step;
        suppressRef.current.add(`${kitIndex}:${pad}:${target}`);
      } else {
        target = (step + STEPS - 1) % STEPS;
      }
      pushHistory();
      setSteps((prev) =>
        prev.map((layer, k) =>
          k === kitIndex
            ? layer.map((row, p) =>
                p === pad ? row.map((on, s) => (s === target ? true : on)) : row,
              )
            : layer,
        ),
      );
    }
  };

  const handlePadUp = (pad: number) => {
    endHold(pad);
  };

  const togglePlay = () => {
    if (playing) {
      seqRef.current?.stop();
      setPlaying(false);
      setCurrentStep(-1);
      // A queued scene change dies with the transport — less surprising than
      // it silently committing on the next play.
      pendingSceneRef.current = null;
      setPendingScene(null);
    } else {
      ensureSequencer().start();
      setPlaying(true);
    }
  };

  // Tap tempo: average the gaps between recent taps (2s window, last 5).
  const tapTimesRef = useRef<number[]>([]);
  const handleTapTempo = () => {
    const now = performance.now();
    const taps = [...tapTimesRef.current.filter((t) => now - t < 2000), now].slice(-5);
    tapTimesRef.current = taps;
    if (taps.length >= 2) {
      const avgMs = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      setBpm(Math.min(220, Math.max(40, Math.round(60000 / avgMs))));
    }
  };

  // Re-registered every render so the handlers always see fresh state —
  // cheap, and avoids a second ref-mirroring layer just for the keyboard.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      // Shift+1-4 queues a scene (e.key is "!" etc. with shift, so use code).
      if (e.shiftKey) {
        if (e.code.startsWith("Digit")) {
          const n = Number(e.code.slice(5));
          if (n >= 1 && n <= SCENE_COUNT) requestScene(n - 1);
        }
        return;
      }
      if (key === " ") {
        e.preventDefault(); // don't scroll the page
        togglePlay();
        return;
      }
      if (key >= "1" && key <= "6") {
        const idx = Number(key) - 1;
        if (idx < KITS.length) setKitIndex(idx);
        return;
      }
      if (key === "t") {
        handleTapTempo();
        return;
      }
      const pad = KEY_TO_PAD[key];
      if (pad !== undefined) handlePadDown(pad);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const pad = KEY_TO_PAD[e.key.toLowerCase()];
      if (pad !== undefined) handlePadUp(pad);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  });

  const toggleRecord = async () => {
    if (!recording) {
      const eng = ensureEngine();
      recRef.current = new Recorder();
      recRef.current.start(eng.streamDest.stream);
      setRecording(true);
    } else {
      try {
        const blob = await recRef.current!.stop();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `rhythmrhymer.${extensionFor(blob.type)}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } finally {
        setRecording(false);
      }
    }
  };

  const toggleStep = (step: number) => {
    pushHistory();
    setSteps((prev) =>
      prev.map((layer, k) =>
        k === kitIndex
          ? layer.map((row, p) =>
              p === selectedPad ? row.map((on, s) => (s === step ? !on : on)) : row,
            )
          : layer,
      ),
    );
  };

  const toggleLive = () => {
    if (!liveArmed) {
      setLiveArmed(true);
      liveArmedRef.current = true;
      // Arming while stopped: one bar of count-in clicks, then the loop rolls.
      if (!seqRef.current?.playing) {
        const eng = ensureEngine();
        const beat = 60 / bpmRef.current;
        const t0 = eng.ctx.currentTime + 0.05;
        for (let k = 0; k < 4; k++) click(t0 + k * beat, k === 0);
        setCountIn(4);
        countTimersRef.current = [1, 2, 3].map((k) =>
          setTimeout(() => setCountIn(4 - k), k * beat * 1000),
        );
        countTimersRef.current.push(
          setTimeout(() => {
            setCountIn(null);
            ensureSequencer().start();
            setPlaying(true);
          }, (t0 + 4 * beat - eng.ctx.currentTime) * 1000),
        );
      }
    } else {
      setLiveArmed(false);
      liveArmedRef.current = false;
      suppressRef.current.clear();
      // Cancel a count-in in progress.
      countTimersRef.current.forEach(clearTimeout);
      countTimersRef.current = [];
      setCountIn(null);
    }
  };

  const handleClearPattern = () => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    if (!clearArmed) {
      setClearArmed(true);
      clearTimerRef.current = setTimeout(() => setClearArmed(false), 2000);
      return;
    }
    setClearArmed(false);
    // Steps only: knob settings and voice samples on this bank survive.
    pushHistory();
    setSteps((prev) =>
      prev.map((layer, k) =>
        k === kitIndex
          ? Array.from({ length: PAD_COUNT }, () => Array<boolean>(STEPS).fill(false))
          : layer,
      ),
    );
  };

  const updateSelectedParam = (key: "pitch" | "decay" | "drive", v: number) => {
    setPadParams((prev) =>
      prev.map((layer, k) =>
        k === kitIndex
          ? layer.map((p, i) => (i === selectedPad ? { ...p, [key]: v } : p))
          : layer,
      ),
    );
  };

  const handleSampleButton = async () => {
    // In assign mode the button is a cancel.
    if (pendingSample) {
      setPendingSample(null);
      return;
    }
    if (micState !== "recording") {
      const eng = ensureEngine();
      const sampler = new MicSampler();
      try {
        await sampler.start(eng.ctx);
        samplerRef.current = sampler;
        setMicState("recording");
      } catch {
        setMicState("blocked");
      }
    } else {
      const buf = samplerRef.current?.stop() ?? null;
      samplerRef.current = null;
      setMicState("idle");
      // Hold the take and let the user pick its pad — free pads start pulsing.
      if (buf) setPendingSample(buf);
    }
  };

  const clearSample = () => {
    overridesRef.current[kitIndex][selectedPad] = null;
    setSampled((prev) =>
      prev.map((row, k) =>
        k === kitIndex ? row.map((v, i) => (i === selectedPad ? false : v)) : row,
      ),
    );
  };

  const handleMasterVolume = (v: number) => {
    masterVolumeRef.current = v;
    setMasterVolume(v);
    if (engineRef.current) engineRef.current.masterGain.gain.value = v;
  };

  const handleFilter = (v: number) => {
    filterPosRef.current = v;
    setFilterPos(v);
    if (engineRef.current) applyFilterPosition(engineRef.current.masterFilter, v);
  };

  const toggleMute = (kit: number) => {
    setMuted((prev) => prev.map((m, k) => (k === kit ? !m : m)));
  };

  // --- persistence: restore once on mount, then save (debounced) on change --
  const loadedRef = useRef(false);

  // Applies a (possibly partial or hostile) save object with full defaults
  // for anything missing. Also resets undo history — snapshots from another
  // project would be nonsense.
  const restoreFromObject = (s: Record<string, unknown>) => {
    // Scenes: 4 pattern sets; legacy saves (pre-scenes) load into scene 1.
    const savedScenes = Array.isArray(s.scenes) ? (s.scenes as unknown[]) : null;
    const scenes = Array.from({ length: SCENE_COUNT }, (_, i) =>
      restoreSteps(savedScenes ? savedScenes[i] : i === 0 ? s.steps : undefined),
    );
    const active = savedScenes ? Math.floor(clampNum(s.activeScene, 0, SCENE_COUNT - 1, 0)) : 0;
    scenesRef.current = scenes;
    activeSceneRef.current = active;
    pendingSceneRef.current = null;
    setActiveScene(active);
    setPendingScene(null);
    setSceneDots(computeSceneDots());
    setSteps(() => scenes[active]);
    setPadParams(() => restoreParams(s.padParams));
    setBpm(clampNum(s.bpm, 40, 220, 120));
    setKitIndex(Math.floor(clampNum(s.kitIndex, 0, KITS.length - 1, 0)));
    setSelectedPad(Math.floor(clampNum(s.selectedPad, 0, PAD_COUNT - 1, 0)));
    handleMasterVolume(clampNum(s.masterVolume, 0, 1, 0.9));
    setSwing(clampNum(s.swing, 0.5, 0.75, 0.5));
    handleFilter(clampNum(s.filterPos, 0, 1, 0.5));
    const m = Array.isArray(s.muted) ? (s.muted as unknown[]) : [];
    setMuted(() => KITS.map((_, k) => m[k] === true));
    historyRef.current = [];
    setUndoCount(0);
  };

  const serializeProject = () => ({
    v: 1,
    bpm,
    kitIndex,
    selectedPad,
    masterVolume,
    swing,
    filterPos,
    muted,
    steps,
    // The working copy IS the active scene — merge it in when writing.
    scenes: scenesRef.current.map((sc, i) => (i === activeScene ? steps : sc)),
    activeScene,
    padParams,
  });

  // Restoring saved state belongs in an effect: localStorage is unavailable
  // during SSR, and lazy useState initializers would render different HTML on
  // the client than the server sent (hydration mismatch). A one-shot
  // mount-effect restore is the standard Next.js pattern.
  useEffect(() => {
    const load = async () => {
      try {
        // A shared beat in the URL wins over local saves.
        const param = new URLSearchParams(window.location.search).get("beat");
        if (param) {
          try {
            const obj = await decodeShare(param);
            restoreFromObject(obj as Record<string, unknown>);
            window.history.replaceState(null, "", window.location.pathname);
            // Don't claim a slot — the user picks one (or discards) via the
            // banner. Until then autosave stays off. Legacy single-key saves
            // count slot 1 as occupied.
            setImportEmpty(
              Array.from(
                { length: SLOT_COUNT },
                (_, i) =>
                  localStorage.getItem(slotKey(i)) === null &&
                  !(i === 0 && localStorage.getItem(LEGACY_STORAGE_KEY) !== null),
              ),
            );
            setImportPending(true);
            return;
          } catch {
            // Malformed link — fall through to the local save.
          }
        }
        const slot = Math.min(
          SLOT_COUNT - 1,
          Math.max(0, parseInt(localStorage.getItem(SLOT_POINTER_KEY) ?? "0", 10) || 0),
        );
        setCurrentSlot(slot);
        // Legacy pre-slots save migrates into slot 1.
        const raw =
          localStorage.getItem(slotKey(slot)) ??
          (slot === 0 ? localStorage.getItem(LEGACY_STORAGE_KEY) : null);
        if (raw) restoreFromObject(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // Corrupted save: start fresh rather than crash; it gets overwritten
        // by the next change.
      } finally {
        loadedRef.current = true;
      }
    };
    void load();
    // Mount-only restore; the setters it uses are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Don't let the initial default state clobber the save before restore,
    // and never autosave an imported beat the user hasn't placed in a slot.
    if (!loadedRef.current || importPending) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(slotKey(currentSlot), JSON.stringify(serializeProject()));
        localStorage.setItem(SLOT_POINTER_KEY, String(currentSlot));
      } catch {
        // Quota exceeded or storage unavailable — the app still works, the
        // session just won't survive a refresh.
      }
    }, 300);
    return () => clearTimeout(t);
    // serializeProject reads exactly these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, bpm, padParams, kitIndex, selectedPad, masterVolume, swing, filterPos, muted, currentSlot, activeScene, importPending]);

  // Place the imported beat: write it into the chosen slot (overwriting
  // whatever was there) and resume normal autosaving against that slot.
  const placeImport = (n: number) => {
    try {
      localStorage.setItem(slotKey(n), JSON.stringify(serializeProject()));
      localStorage.setItem(SLOT_POINTER_KEY, String(n));
    } catch {
      // Storage unavailable — the beat stays usable for this session.
    }
    setCurrentSlot(n);
    setImportPending(false);
    setImportArmed(null);
    if (importArmTimerRef.current) clearTimeout(importArmTimerRef.current);
  };

  // Occupied slots need a second tap to confirm the overwrite.
  const handleImportSlotTap = (n: number) => {
    if (importEmpty[n] || importArmed === n) {
      placeImport(n);
      return;
    }
    if (importArmTimerRef.current) clearTimeout(importArmTimerRef.current);
    setImportArmed(n);
    importArmTimerRef.current = setTimeout(() => setImportArmed(null), 2000);
  };

  // Drop the imported beat and return to whatever was active before.
  const discardImport = () => {
    setImportPending(false);
    setImportArmed(null);
    if (importArmTimerRef.current) clearTimeout(importArmTimerRef.current);
    try {
      const slot = Math.min(
        SLOT_COUNT - 1,
        Math.max(0, parseInt(localStorage.getItem(SLOT_POINTER_KEY) ?? "0", 10) || 0),
      );
      setCurrentSlot(slot);
      const raw =
        localStorage.getItem(slotKey(slot)) ??
        (slot === 0 ? localStorage.getItem(LEGACY_STORAGE_KEY) : null);
      restoreFromObject(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
    } catch {
      restoreFromObject({});
    }
  };

  const switchSlot = (n: number) => {
    if (n === currentSlot) return;
    try {
      // Flush the outgoing project immediately — don't trust the debounce.
      localStorage.setItem(slotKey(currentSlot), JSON.stringify(serializeProject()));
    } catch {
      // Storage unavailable; switching still works for this session.
    }
    setCurrentSlot(n);
    try {
      localStorage.setItem(SLOT_POINTER_KEY, String(n));
      const raw = localStorage.getItem(slotKey(n));
      restoreFromObject(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
    } catch {
      restoreFromObject({});
    }
  };

  const handleShare = async () => {
    try {
      const encoded = await encodeShare(serializeProject());
      const url = `${window.location.origin}${window.location.pathname}?beat=${encoded}`;
      await navigator.clipboard.writeText(url);
      setShareState("copied");
    } catch {
      setShareState("failed");
    }
    setTimeout(() => setShareState("idle"), 1500);
  };

  const kit = KITS[kitIndex];
  const vizActive = playing || tapViz;

  // --- render ------------------------------------------------------------------
  return (
    <div className="flex w-full flex-col items-center">
      <Visualizer analyser={analyser} active={vizActive} />

      <div className="w-full max-w-[760px] rounded-[28px] border border-chassis-edge bg-gradient-to-b from-[#212429] to-[#16181c] p-6 shadow-[0_24px_60px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.06)]">
        {/* header */}
        <div className="mb-5 flex items-center justify-between">
          <span className="font-mono text-sm font-bold tracking-[0.35em] text-zinc-300">
            RHYTHMRHYMER
          </span>
          <div className="flex items-center gap-3">
            {/* project slots */}
            <div className="flex items-center gap-1">
              {Array.from({ length: SLOT_COUNT }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => switchSlot(i)}
                  disabled={importPending}
                  aria-label={`project slot ${i + 1}`}
                  aria-pressed={i === currentSlot}
                  className={`h-6 w-6 rounded border font-mono text-[9px] transition-colors ${
                    importPending
                      ? "cursor-default border-chassis-edge bg-[#1c1f24] text-zinc-700"
                      : i === currentSlot
                        ? "border-cyan-300/70 bg-cyan-400/15 text-cyan-300"
                        : "border-chassis-edge bg-[#1c1f24] text-zinc-600 hover:text-zinc-400"
                  }`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={undo}
              disabled={undoCount === 0}
              aria-label="undo pattern change"
              className={`h-6 rounded border border-chassis-edge bg-[#1c1f24] px-2 font-mono text-[9px] transition-colors ${
                undoCount === 0
                  ? "cursor-default text-zinc-700"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              UNDO
            </button>
            <button
              type="button"
              onClick={handleShare}
              aria-label="copy share link"
              className={`h-6 rounded border px-2 font-mono text-[9px] transition-colors ${
                shareState === "copied"
                  ? "border-emerald-400/70 bg-emerald-400/15 text-emerald-300"
                  : shareState === "failed"
                    ? "border-red-500/70 bg-red-500/15 text-red-400"
                    : "border-chassis-edge bg-[#1c1f24] text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {shareState === "copied" ? "COPIED" : shareState === "failed" ? "FAILED" : "SHARE"}
            </button>
            {recording && (
              <span className="rec-pulse font-mono text-xs font-bold text-red-500">
                ● REC
              </span>
            )}
            <span className="font-mono text-xs text-zinc-500 tabular-nums">
              {Math.round(bpm)} BPM
            </span>
          </div>
        </div>

        {/* imported-beat placement banner */}
        {importPending && (
          <div className="mb-4 rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="font-mono text-[10px] font-bold tracking-wider text-cyan-200">
                SHARED BEAT LOADED
              </span>
              <span className="font-mono text-[9px] text-zinc-400">
                {importEmpty.some(Boolean)
                  ? "unsaved — pick an empty slot to keep it (saving replaces anything in that slot)"
                  : "unsaved — all slots are full. Overwrite one? This permanently replaces that slot's beat"}
              </span>
              <div className="flex items-center gap-1.5">
                {Array.from({ length: SLOT_COUNT }, (_, i) => {
                  if (importEmpty.some(Boolean) && !importEmpty[i]) return null;
                  const empty = importEmpty[i];
                  const armed = importArmed === i;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => handleImportSlotTap(i)}
                      aria-label={
                        empty
                          ? `save to empty slot ${i + 1}`
                          : `overwrite slot ${i + 1}`
                      }
                      className={`h-6 rounded border px-2 font-mono text-[9px] transition-colors ${
                        armed
                          ? "rec-pulse border-red-500/80 bg-red-500/25 text-red-300"
                          : empty
                            ? "border-cyan-300/60 bg-cyan-400/15 text-cyan-200 hover:bg-cyan-400/25"
                            : "border-red-500/50 bg-red-500/10 text-red-300/90 hover:bg-red-500/20"
                      }`}
                    >
                      {armed ? "SURE?" : `SLOT ${i + 1}`}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={discardImport}
                  aria-label="discard imported beat"
                  className="h-6 rounded border border-chassis-edge bg-[#1c1f24] px-2 font-mono text-[9px] text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  ✕ DISCARD
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="flex gap-6">
          {/* left column: controls */}
          <div className="flex w-44 shrink-0 flex-col gap-5">
            <div className="flex justify-around">
              <Knob
                label="BPM"
                value={bpm}
                min={40}
                max={220}
                defaultValue={120}
                onChange={setBpm}
                format={(v) => `${Math.round(v)}`}
              />
              <Knob
                label="SWING"
                value={swing}
                min={0.5}
                max={0.75}
                defaultValue={0.5}
                onChange={setSwing}
                format={(v) => `${Math.round(v * 100)}%`}
              />
              <Knob
                label="FILTER"
                value={filterPos}
                min={0}
                max={1}
                defaultValue={0.5}
                onChange={handleFilter}
                format={(v) =>
                  v < 0.48 ? "LP" : v > 0.52 ? "HP" : "OPEN"
                }
              />
            </div>

            <div className="flex justify-around">
              <div className="flex flex-col items-center gap-1 select-none">
                <button
                  type="button"
                  onClick={handleTapTempo}
                  aria-label="tap tempo"
                  title="key T"
                  className="h-12 w-12 rounded-full border border-chassis-edge bg-gradient-to-b from-[#2e3137] to-[#191b1f] font-mono text-[10px] text-zinc-300 shadow-[0_3px_6px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.08)] transition-transform active:scale-95"
                >
                  TAP
                </button>
                <span className="font-mono text-[9px] tracking-widest text-zinc-400">TEMPO</span>
                <span className="font-mono text-[9px] text-zinc-500 tabular-nums">{Math.round(bpm)}</span>
              </div>
              <Knob
                label="PITCH"
                value={padParams[kitIndex][selectedPad].pitch}
                min={0.5}
                max={2}
                defaultValue={1}
                onChange={(v) => updateSelectedParam("pitch", v)}
                format={(v) => `x${v.toFixed(2)}`}
              />
              <Knob
                label="DIST"
                value={padParams[kitIndex][selectedPad].drive}
                min={0}
                max={1}
                defaultValue={0}
                onChange={(v) => updateSelectedParam("drive", v)}
                format={(v) => `${Math.round(v * 100)}%`}
              />
            </div>

            <div className="flex justify-around">
              <Fader
                label="MASTER"
                value={masterVolume}
                min={0}
                max={1}
                onChange={handleMasterVolume}
              />
              <Fader
                label="DECAY"
                value={padParams[kitIndex][selectedPad].decay}
                min={0.25}
                max={2}
                onChange={(v) => updateSelectedParam("decay", v)}
              />
            </div>

            {/* transport */}
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={togglePlay}
                aria-label={playing ? "stop" : "play"}
                className={`h-10 rounded-lg border font-mono text-sm transition-colors ${
                  playing
                    ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-300 shadow-[0_0_10px_rgba(52,211,153,0.4)]"
                    : "border-chassis-edge bg-[#202329] text-emerald-400 hover:bg-[#262a31]"
                }`}
              >
                {playing ? "■" : "▶"}
              </button>
              <button
                type="button"
                onClick={toggleRecord}
                aria-label={recording ? "stop recording and download" : "record"}
                className={`h-10 rounded-lg border font-mono text-sm transition-colors ${
                  recording
                    ? "rec-pulse border-red-500/70 bg-red-500/20 text-red-400 shadow-[0_0_10px_rgba(239,68,68,0.5)]"
                    : "border-chassis-edge bg-[#202329] text-red-500 hover:bg-[#262a31]"
                }`}
              >
                ●
              </button>
              <button
                type="button"
                onClick={toggleLive}
                aria-label={liveArmed ? "disarm live recording" : "arm live recording"}
                className={`h-10 rounded-lg border font-mono text-[9px] tracking-wider transition-colors ${
                  liveArmed
                    ? "rec-pulse border-amber-400/70 bg-amber-400/15 text-amber-300 shadow-[0_0_10px_rgba(245,166,35,0.5)]"
                    : "border-chassis-edge bg-[#202329] text-zinc-400 hover:bg-[#262a31]"
                }`}
              >
                {countIn !== null ? `· ${countIn} ·` : "LIVE"}
              </button>
              <button
                type="button"
                onClick={handleClearPattern}
                aria-label={clearArmed ? "confirm clear pattern" : "clear pattern"}
                className={`h-10 rounded-lg border font-mono text-[9px] tracking-wider transition-colors ${
                  clearArmed
                    ? "rec-pulse border-red-500/70 bg-red-500/20 text-red-400 shadow-[0_0_10px_rgba(239,68,68,0.5)]"
                    : "border-chassis-edge bg-[#202329] text-zinc-400 hover:bg-[#262a31]"
                }`}
              >
                {clearArmed ? "SURE?" : "CLEAR"}
              </button>
            </div>

            {/* banks */}
            <div>
              <div className="grid grid-cols-6 gap-1">
                {BANK_LABELS.map((label, i) => {
                  const hasBeats = steps[i].some((row) => row.some(Boolean));
                  return (
                    <button
                      key={label}
                      type="button"
                      title={`key ${i + 1}`}
                      onClick={() => setKitIndex(i)}
                      className={`relative h-8 rounded-md border font-mono text-xs transition-colors ${
                        i === kitIndex
                          ? "border-cyan-300/70 bg-cyan-400/15 text-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.4)]"
                          : hasBeats
                            ? "border-amber-400/50 bg-[#202329] text-amber-300/90 shadow-[0_0_6px_rgba(245,166,35,0.3)] hover:bg-[#262a31]"
                            : "border-chassis-edge bg-[#202329] text-zinc-500 hover:bg-[#262a31]"
                      }`}
                    >
                      <span className={muted[i] ? "opacity-40 line-through" : ""}>{label}</span>
                      {hasBeats && (
                        <span className="absolute right-1 top-1 h-1 w-1 rounded-full bg-amber-400 shadow-[0_0_4px_var(--pad-amber)]" />
                      )}
                    </button>
                  );
                })}
              </div>
              {/* per-layer mutes: silence a bank's loop without losing it */}
              <div className="mt-1 grid grid-cols-6 gap-1">
                {BANK_LABELS.map((label, i) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => toggleMute(i)}
                    aria-label={muted[i] ? `unmute bank ${label}` : `mute bank ${label}`}
                    aria-pressed={muted[i]}
                    className={`h-5 rounded border font-mono text-[8px] transition-colors ${
                      muted[i]
                        ? "border-red-500/70 bg-red-500/20 text-red-400 shadow-[0_0_6px_rgba(239,68,68,0.4)]"
                        : "border-chassis-edge bg-[#1c1f24] text-zinc-600 hover:text-zinc-400"
                    }`}
                  >
                    M
                  </button>
                ))}
              </div>
              <div className="mt-1.5 text-center font-mono text-[10px] tracking-widest text-zinc-500">
                {kit.name.toUpperCase()} KIT
              </div>
              <div className="mt-0.5 text-center font-mono text-[8px] tracking-wider text-zinc-600">
                KEYS 1-6 · SPACE ▶ · T TAP
              </div>
            </div>

            {/* mic sampling: record a take, then tap a pulsing pad to place it */}
            <div className="flex items-stretch gap-1.5">
              <button
                type="button"
                onClick={handleSampleButton}
                className={`h-9 flex-1 rounded-md border font-mono text-[10px] tracking-wider transition-colors ${
                  micState === "recording"
                    ? "rec-pulse border-red-500/70 bg-red-500/20 text-red-400 shadow-[0_0_10px_rgba(239,68,68,0.5)]"
                    : pendingSample
                      ? "border-emerald-400/70 bg-emerald-400/15 text-emerald-300 shadow-[0_0_10px_rgba(52,211,153,0.4)]"
                      : "border-chassis-edge bg-[#202329] text-zinc-400 hover:bg-[#262a31]"
                }`}
              >
                {micState === "recording"
                  ? "● STOP SAMPLE"
                  : pendingSample
                    ? "TAP A PAD · ✕ CANCEL"
                    : "🎤 RECORD SAMPLE"}
              </button>
              {sampled[kitIndex][selectedPad] && micState !== "recording" && !pendingSample && (
                <button
                  type="button"
                  onClick={clearSample}
                  aria-label="clear sample"
                  className="h-9 w-12 rounded-md border border-chassis-edge bg-[#202329] font-mono text-[10px] text-zinc-500 transition-colors hover:bg-[#262a31] hover:text-zinc-300"
                >
                  CLR
                </button>
              )}
            </div>
            {micState === "blocked" && (
              <span className="-mt-3 text-center font-mono text-[9px] text-red-400/80">
                mic access blocked
              </span>
            )}
          </div>

          {/* pad grid */}
          <div className="grid flex-1 grid-cols-4 gap-3">
            {RENDER_ORDER.map((i) => (
              <Pad
                key={i}
                label={kit.pads[i].label}
                color={kit.pads[i].color}
                lit={steps[kitIndex][i].some(Boolean)}
                selected={i === selectedPad}
                sampled={sampled[kitIndex][i]}
                assignable={pendingSample !== null && !sampled[kitIndex][i]}
                keyHint={PAD_KEY_HINT[i]}
                flashSeq={flashSeq[i]}
                onTrigger={() => handlePadDown(i)}
                onRelease={() => handlePadUp(i)}
              />
            ))}
          </div>
        </div>

        {/* step row */}
        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[9px] tracking-widest text-zinc-500">SCENE</span>
              <div className="flex gap-1">
                {Array.from({ length: SCENE_COUNT }, (_, i) => {
                  const isActive = i === activeScene;
                  const isPending = i === pendingScene;
                  const hasContent = isActive
                    ? steps.some((layer) => layer.some((row) => row.some(Boolean)))
                    : sceneDots[i];
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => requestScene(i)}
                      aria-label={`scene ${i + 1}`}
                      aria-pressed={isActive}
                      className={`relative h-6 w-9 rounded border font-mono text-[9px] transition-colors ${
                        isPending
                          ? "rec-pulse border-amber-400/70 bg-amber-400/15 text-amber-300"
                          : isActive
                            ? "border-cyan-300/70 bg-cyan-400/15 text-cyan-300"
                            : "border-chassis-edge bg-[#1c1f24] text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      S{i + 1}
                      {hasContent && !isActive && !isPending && (
                        <span className="absolute right-0.5 top-0.5 h-1 w-1 rounded-full bg-amber-400/80" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
            <span className="font-mono text-[8px] tracking-wider text-zinc-600">
              SHIFT+1-4 · SWITCHES ON THE BAR
            </span>
          </div>
          <StepGrid
            padLabel={kit.pads[selectedPad].label}
            color={kit.pads[selectedPad].color}
            steps={steps[kitIndex][selectedPad]}
            currentStep={currentStep}
            onToggle={toggleStep}
          />
        </div>
      </div>
    </div>
  );
}
