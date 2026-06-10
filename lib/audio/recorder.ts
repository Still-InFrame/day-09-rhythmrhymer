// Master-bus recorder. Consumes the engine's MediaStreamAudioDestinationNode
// stream only — upgrading the export format (WAV/MP3) replaces this file and
// nothing else.

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4", // Safari
];

function pickMimeType(): string {
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return ""; // let the browser choose
}

export function extensionFor(mime: string): string {
  return mime.includes("mp4") ? "m4a" : "webm";
}

export class Recorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  readonly mimeType: string;

  constructor() {
    this.mimeType = pickMimeType();
  }

  get recording(): boolean {
    return this.recorder?.state === "recording";
  }

  start(stream: MediaStream): void {
    this.chunks = [];
    this.recorder = new MediaRecorder(
      stream,
      this.mimeType ? { mimeType: this.mimeType } : undefined,
    );
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const rec = this.recorder;
      if (!rec || rec.state === "inactive") {
        reject(new Error("not recording"));
        return;
      }
      rec.onstop = () => {
        resolve(new Blob(this.chunks, { type: rec.mimeType || "audio/webm" }));
        this.recorder = null;
      };
      rec.stop();
    });
  }
}
