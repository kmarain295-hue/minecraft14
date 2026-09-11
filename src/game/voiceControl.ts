/* ============================================================================
 * voiceControl.ts — BUZZ VOICE LINK ("say it — BUZZ does it").
 *
 * The player talks; the drone listens CONTINUOUSLY and obeys. Pure browser
 * pipeline (no assets, no third-party SDK on the client):
 *
 *   mic (getUserMedia)
 *     → energy VAD with adaptive noise floor + rolling pre-roll
 *     → spoken segment buffered, downsampled to 16 kHz mono WAV
 *     → POST /api/voice/asr        → { text }   (speech → words)
 *     → POST /api/voice/command    → { intent, params, reply }
 *                                    (the LLM brain turns words into an order)
 *     → the page maps the intent onto the drone brain (droneAi.ts)
 *
 * RELIABILITY CONTRACT (why the player always SEES the ears working):
 *   - the VAD gate opens LOW (quiet laptop mics open it too) and keeps
 *     adapting down while the room is quiet, so soft speech is caught
 *   - the mic is NEVER muted while a command is being understood: speech
 *     that arrives mid-request keeps buffering and is processed right after
 *   - the instant the gate opens the page is told (onSpeechStart) so the
 *     HUD shows "hearing you" BEFORE the transcript exists — no dead air
 *   - a live mic level (meter) lets the HUD draw a moving level bar
 *   - one client-side ASR retry rides out transient 429/502s
 * `inject()` feeds a transcript straight into the command brain — the
 * debug/test path (headless verification, no mic).
 * Zero DOM, zero game imports: the page wires the callbacks.
 * ==========================================================================*/

/** One parsed order from the command brain (see /api/voice/command).
 *  The brain may answer with a SEQUENCE (`commands`, max 3) for chained
 *  requests like "come to me and then attack". */
export interface VoiceCommand {
  intent: string;
  params: Record<string, unknown>;
  reply: string;
  commands?: VoiceCommand[];
}

export type VoiceLinkState = 'off' | 'listening' | 'thinking';

export interface VoiceControlHandlers {
  /** Mic state changed (off / listening / thinking). */
  onState: (s: VoiceLinkState) => void;
  /** The VAD gate JUST opened — speech is being captured right now.
   *  Fire instantly so the HUD can show live feedback before any text. */
  onSpeechStart: () => void;
  /** ASR produced a transcript for the player chip. */
  onHeard: (text: string) => void;
  /** BUZZ's confirmation line (from the command brain). */
  onReply: (text: string) => void;
  /** User-facing problem line (mic blocked, network, …). */
  onError: (message: string) => void;
  /** A validated command is ready — the page executes it. */
  onCommand: (cmd: VoiceCommand) => void;
  /** Live drone telemetry merged into the command-brain prompt. */
  buildContext: () => Record<string, unknown>;
}

export interface VoiceControl {
  toggle(): void;
  isEnabled(): boolean;
  /** Debug/test path: run a transcript through the command brain. */
  inject(text: string): Promise<void>;
  /** Smoothed mic level 0..1 — the HUD's live "ears" bar. */
  meter(): number;
  status(): {
    enabled: boolean;
    listening: boolean;
    processing: boolean;
    /** True while the VAD gate is open (speech being captured). */
    speechOpen: boolean;
    lastTranscript: string | null;
  };
  dispose(): void;
}

/* ----- pipeline tuning ----- */
const SR_OUT = 16000; // ASR-friendly sample rate for the uploaded WAV
const PRE_ROLL_S = 0.55; // speech onset context kept before the gate opens
const MIN_SPEECH_S = 0.3; // shorter than this → blip, discarded
const MAX_UTT_S = 12; // runaway cap on one segment (long sentences OK)
const HANGOVER_S = 0.7; // trailing silence that closes a segment
const COOLDOWN_S = 0.28; // brief pause before the ears re-open after a command
// VAD thresholds — tuned LOW so quiet laptop/phone mics still open the
// gate (the old absolute floor of 0.0045 left soft speech unheard forever)
const FLOOR_MIN = 0.0012; // absolute noise-floor clamp (was 0.0045)
const OPEN_FLOOR = 2.6; // open when rms > floor × this
const CLOSE_FLOOR = 1.55; // stay open while rms > floor × this
const LEVEL_ATTACK = 0.35; // level meter smoothing (visual only)
const FETCH_TIMEOUT_S = 25;

export function createVoiceControl(
  h: VoiceControlHandlers
): VoiceControl {
  let enabled = false;
  let listening = false; // mic pipeline live
  let processing = false; // a segment is being understood
  let speechOpen = false; // VAD gate currently open
  let lastTranscript: string | null = null;
  let cooldownUntil = 0; // performance.now()/1000
  let level = 0; // smoothed mic level for the HUD meter

  /* ----- audio graph ----- */
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let node: ScriptProcessorNode | null = null;
  let sink: GainNode | null = null;

  /* ----- VAD state ----- */
  let srcRate = 48000;
  let noiseFloor = FLOOR_MIN;
  let speech = false;
  let silentFor = 0;
  let preRoll: Float32Array[] = [];
  let clip: Float32Array[] = [];
  let clipLen = 0; // samples in `clip`

  const setState = (s: VoiceLinkState): void => h.onState(s);

  /* ---------- audio graph lifecycle ---------- */

  function stopStream(): void {
    if (node) {
      node.onaudioprocess = null;
      node.disconnect();
      node = null;
    }
    if (sink) {
      sink.disconnect();
      sink = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (ctx) {
      void ctx.close().catch(() => undefined);
      ctx = null;
    }
    listening = false;
    speech = false;
    speechOpen = false;
    preRoll = [];
    clip = [];
    clipLen = 0;
  }

  async function start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      enabled = false;
      h.onError('No mic API here — use Chrome/Edge.');
      setState('off');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      enabled = false;
      h.onError('Mic blocked — allow microphone access.');
      setState('off');
      return;
    }
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) {
      enabled = false;
      h.onError('Web Audio unavailable here.');
      setState('off');
      stopStream();
      return;
    }
    ctx = new AC();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    srcRate = ctx.sampleRate;
    const src = ctx.createMediaStreamSource(stream);
    node = ctx.createScriptProcessor(4096, 1, 1);
    sink = ctx.createGain();
    sink.gain.value = 0; // silent sink — only keeps the node pulled
    node.onaudioprocess = onAudio;
    src.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    noiseFloor = FLOOR_MIN;
    listening = true;
    setState('listening');
  }

  /* ---------- VAD core (runs on every audio block) ---------- */

  function onAudio(e: AudioProcessingEvent): void {
    if (!enabled) return;
    const input = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    const nowS = performance.now() / 1000;
    // live level for the HUD meter (attack fast, release slow)
    const inst = Math.min(1, rms * 14);
    level += (inst - level) * (inst > level ? LEVEL_ATTACK : 0.06);

    const open = Math.max(FLOOR_MIN * 3, noiseFloor * OPEN_FLOOR);
    const close = Math.max(FLOOR_MIN * 2, noiseFloor * CLOSE_FLOOR);

    if (!speech) {
      // rolling pre-roll keeps the onset of the utterance
      preRoll.push(new Float32Array(input));
      const preMax = Math.ceil((PRE_ROLL_S * srcRate) / input.length);
      while (preRoll.length > preMax) preRoll.shift();
      // adaptive floor follows the quiet room
      if (rms < close) noiseFloor = noiseFloor * 0.96 + rms * 0.04;
      // during cooldown the gate stays shut but the floor + pre-roll keep
      // tracking, so a command spoken right after the last one is caught
      if (nowS < cooldownUntil) return;
      if (rms > open) {
        speech = true;
        speechOpen = true;
        silentFor = 0;
        clip = preRoll;
        clipLen = 0;
        for (const c of clip) clipLen += c.length;
        preRoll = [];
        clip.push(new Float32Array(input));
        clipLen += input.length;
        h.onSpeechStart(); // instant HUD feedback — before any text exists
      }
      return;
    }

    // mid-utterance: buffer everything, watch for the trailing silence.
    // NOTE: this keeps running WHILE a previous segment is being understood
    // (processing) — nothing the player says is ever dropped.
    clip.push(new Float32Array(input));
    clipLen += input.length;
    if (rms > close) {
      silentFor = 0;
    } else {
      silentFor += input.length / srcRate;
      noiseFloor = noiseFloor * 0.99 + rms * 0.01;
    }
    if (silentFor >= HANGOVER_S || clipLen / srcRate >= MAX_UTT_S) {
      speech = false;
      speechOpen = false;
      void finalize();
    }
  }

  /* ---------- segment → words → order ---------- */

  async function finalize(): Promise<void> {
    if (processing) return; // already working — clip keeps buffering
    const chunks = clip;
    const total = clipLen;
    clip = [];
    clipLen = 0;
    preRoll = [];
    if (total / srcRate < MIN_SPEECH_S) return; // door slam, breath, blip

    processing = true;
    setState('thinking');
    try {
      const pcm = mixDown(chunks, total);
      const b64 = toB64(encodeWav(pcm, SR_OUT));
      const text = await transcribe(b64);
      if (!text) {
        lastTranscript = '';
        h.onError('Heard nothing — try again.');
        return;
      }
      lastTranscript = text;
      h.onHeard(text);
      const cmd = await parseCommand(text);
      if (cmd) {
        h.onReply(cmd.reply);
        h.onCommand(cmd);
      } else {
        h.onError('No copy — rephrase that.');
      }
    } catch {
      h.onError('Voice link hiccup — say it again.');
    } finally {
      processing = false;
      cooldownUntil = performance.now() / 1000 + COOLDOWN_S;
      setState(enabled ? 'listening' : 'off');
      // speech that arrived while this command was being understood is
      // already buffered — process it immediately (chained orders work)
      if (enabled && clipLen / srcRate >= MIN_SPEECH_S) void finalize();
    }
  }

  /** Concatenate the segment's blocks into one Float32 buffer. */
  function mixDown(chunks: Float32Array[], total: number): Float32Array {
    const out = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  /** Linear-interpolation downsample to the ASR sample rate. */
  function resample(pcm: Float32Array): Float32Array {
    if (Math.abs(srcRate - SR_OUT) < 1) return pcm;
    const ratio = srcRate / SR_OUT;
    const outLen = Math.floor(pcm.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const x = i * ratio;
      const i0 = Math.floor(x);
      const i1 = Math.min(i0 + 1, pcm.length - 1);
      const f = x - i0;
      out[i] = pcm[i0] * (1 - f) + pcm[i1] * f;
    }
    return out;
  }

  /** 16-bit PCM mono RIFF/WAVE encoder. */
  function encodeWav(pcmIn: Float32Array, rate: number): ArrayBuffer {
    const pcm = resample(pcmIn);
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buf);
    const str = (off: number, s: string): void => {
      for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    str(0, 'RIFF');
    v.setUint32(4, 36 + pcm.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, pcm.length * 2, true);
    let off = 44;
    for (let i = 0; i < pcm.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  /** Chunked base64 (avoids call-stack limits on long utterances). */
  function toB64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let out = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      out += String.fromCharCode(
        ...bytes.subarray(i, Math.min(i + CH, bytes.length))
      );
    }
    return btoa(out);
  }

  async function postJson<T>(
    url: string,
    body: unknown,
    timeoutS: number
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutS * 1000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** ASR with ONE client-side retry — the server already backs off on
   *  429s; this second attempt rides out the rare leftover failure. */
  async function transcribe(b64: string): Promise<string> {
    try {
      return await transcribeOnce(b64);
    } catch {
      await new Promise((r) => setTimeout(r, 700));
      return await transcribeOnce(b64);
    }
  }

  function transcribeOnce(b64: string): Promise<string> {
    return postJson<{ text?: string }>('/api/voice/asr', { audio: b64 },
      FETCH_TIMEOUT_S).then((r) => (r.text ?? '').trim());
  }

  async function parseCommand(text: string): Promise<VoiceCommand | null> {
    return postJson<VoiceCommand | null>(
      '/api/voice/command',
      { text, context: h.buildContext() },
      FETCH_TIMEOUT_S
    );
  }

  /* ---------- public surface ---------- */

  function toggle(): void {
    if (enabled) {
      enabled = false;
      stopStream();
      setState('off');
    } else {
      enabled = true;
      void start();
    }
  }

  async function inject(text: string): Promise<void> {
    if (processing || !text.trim()) return;
    processing = true;
    setState('thinking');
    try {
      h.onSpeechStart();
      h.onHeard(text.trim());
      const cmd = await parseCommand(text.trim());
      if (cmd) {
        h.onReply(cmd.reply);
        h.onCommand(cmd);
      } else {
        h.onError('No copy — rephrase that.');
      }
    } catch {
      h.onError('Voice brain unreachable.');
    } finally {
      processing = false;
      setState(enabled ? 'listening' : 'off');
    }
  }

  return {
    toggle,
    isEnabled: () => enabled,
    inject,
    meter: () => (enabled ? level : 0),
    status: () => ({
      enabled,
      listening,
      processing,
      speechOpen,
      lastTranscript,
    }),
    dispose: () => {
      enabled = false;
      stopStream();
      setState('off');
    },
  };
}
