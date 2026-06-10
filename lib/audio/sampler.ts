// Mic sampling: captures raw PCM straight off the mic into an AudioBuffer.
// No MediaRecorder/decodeAudioData round-trip — codec support for decoding
// webm/mp4 blobs varies by browser, raw Float32 capture does not.
// ScriptProcessorNode is deprecated but universally supported and fine for
// a capture tap this short.

const MAX_SECONDS = 4;
const TRIM_THRESHOLD = 0.02;
const TARGET_PEAK = 0.9;

export class MicSampler {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private proc: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private ctx: AudioContext | null = null;

  get recording(): boolean {
    return this.proc !== null;
  }

  async start(ctx: AudioContext): Promise<void> {
    this.ctx = ctx;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    this.chunks = [];
    this.source = ctx.createMediaStreamSource(this.stream);
    this.proc = ctx.createScriptProcessor(4096, 1, 1);
    const maxChunks = Math.ceil((MAX_SECONDS * ctx.sampleRate) / 4096);
    this.proc.onaudioprocess = (e) => {
      if (this.chunks.length < maxChunks) {
        this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      }
    };
    // The processor only runs while pulled toward the destination; a muted
    // sink keeps it alive without the mic feeding back into the speakers.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.proc);
    this.proc.connect(this.sink);
    this.sink.connect(ctx.destination);
  }

  // Returns the trimmed, normalized take — or null if only silence came in.
  stop(): AudioBuffer | null {
    const ctx = this.ctx;
    const chunks = this.chunks;

    this.proc?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.proc = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
    this.chunks = [];

    if (!ctx || chunks.length === 0) return null;

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const data = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
      data.set(c, offset);
      offset += c.length;
    }

    let start = 0;
    let end = data.length - 1;
    while (start < data.length && Math.abs(data[start]) < TRIM_THRESHOLD) start++;
    while (end > start && Math.abs(data[end]) < TRIM_THRESHOLD) end--;
    if (end - start < ctx.sampleRate * 0.03) return null; // <30ms of signal

    // Keep a hair of attack so plosives don't click.
    start = Math.max(0, start - Math.floor(ctx.sampleRate * 0.01));
    const trimmed = data.subarray(start, end + 1);

    let peak = 0;
    for (let i = 0; i < trimmed.length; i++) peak = Math.max(peak, Math.abs(trimmed[i]));
    const scale = peak > 0 ? TARGET_PEAK / peak : 1;

    const buf = ctx.createBuffer(1, trimmed.length, ctx.sampleRate);
    const out = buf.getChannelData(0);
    for (let i = 0; i < trimmed.length; i++) out[i] = trimmed[i] * scale;
    return buf;
  }
}
