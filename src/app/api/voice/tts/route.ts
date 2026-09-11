import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BUZZ's VOICE — text-to-speech for the drone's radio replies.
 * POST { text } → audio/wav binary.
 * The page plays it through a band-pass "radio" filter so BUZZ answers
 * OUT LOUD, not just in the HUD chip. Replies are short (≤ 12 words) so
 * one request per line is cheap; identical lines are served from a small
 * in-memory cache (the greetings/acks repeat a lot).
 */

const VOICE = "jam"; // clipped British gentleman — reads as comms audio
const SPEED = 1.06; // hair fast, radio-operator cadence

const cache = new Map<string, Buffer>();
const CACHE_MAX = 32;

export async function POST(req: NextRequest) {
  let text = "";
  try {
    const body = (await req.json()) as { text?: unknown };
    if (typeof body?.text === "string") text = body.text;
  } catch {
    text = "";
  }
  text = text.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!text) {
    return NextResponse.json({ error: "no text" }, { status: 400 });
  }

  const hit = cache.get(text);
  if (hit) {
    return new NextResponse(new Uint8Array(hit), {
      status: 200,
      headers: { "Content-Type": "audio/wav", "X-Cache": "hit" },
    });
  }

  try {
    const zai = await ZAI.create();
    // two quick backoff retries — the TTS API occasionally 429s under
    // bursts; a miss just means BUZZ stays silent for that one line
    const waits = [0, 1200, 2600];
    let lastErr: unknown = null;
    for (const w of waits) {
      if (w) await new Promise((r) => setTimeout(r, w));
      try {
        const res = await zai.audio.tts.create({
          input: text,
          voice: VOICE,
          speed: SPEED,
          response_format: "wav",
          stream: false,
        });
        const buf = Buffer.from(new Uint8Array(await res.arrayBuffer()));
        if (buf.length < 100) throw new Error("tts empty");
        cache.set(text, buf);
        if (cache.size > CACHE_MAX) {
          cache.delete(cache.keys().next().value as string);
        }
        return new NextResponse(new Uint8Array(buf), {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        });
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("tts failed");
  } catch (err) {
    console.error("[voice/tts]", err);
    return NextResponse.json({ error: "tts failed" }, { status: 502 });
  }
}
