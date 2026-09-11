import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BUZZ's ears — backend speech-to-text.
 * POST { audio: base64(WAV) } → { text }
 * The client voice link (src/game/voiceControl.ts) captures mic audio,
 * WAV-encodes each spoken segment and posts it here; the z-ai-web-dev-sdk
 * ASR model returns the transcript. The SDK must stay server-side.
 */
export async function POST(req: NextRequest) {
  let audio = "";
  try {
    const body = (await req.json()) as { audio?: unknown };
    if (typeof body?.audio === "string") audio = body.audio;
  } catch {
    audio = "";
  }
  if (!audio || audio.length > 14_000_000) {
    return NextResponse.json({ error: "no audio" }, { status: 400 });
  }
  try {
    const zai = await ZAI.create();
    // two quick backoff retries — the ASR API occasionally 429s under
    // bursts; a short wait is invisible to a player mid-sentence
    const waits = [0, 1200, 2600];
    let lastErr: unknown = null;
    for (const w of waits) {
      if (w) await new Promise((r) => setTimeout(r, w));
      try {
        const res = await zai.audio.asr.create({ file_base64: audio });
        return NextResponse.json({ text: String(res?.text ?? "").trim() });
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("asr failed");
  } catch (err) {
    console.error("[voice/asr]", err);
    return NextResponse.json({ error: "asr failed" }, { status: 502 });
  }
}
