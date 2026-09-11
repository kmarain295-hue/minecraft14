import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BUZZ's command brain — the LLM that UNDERSTANDS the player.
 * POST { text, context } → { intent, params, reply, commands? }
 * The transcript from /api/voice/asr (or the debug inject path) goes in;
 * a strict JSON order (or a short CHAIN of orders) for the drone brain
 * (droneAi.ts) comes out.
 */

const SYSTEM = `You are the VOICE LINK of BUZZ, an autonomous combat quadcopter that escorts the player in a game. The player speaks; you turn what they said into JSON orders for the drone.

Answer with ONLY a JSON object — no markdown, no code fences, no extra text.

Single order (normal case):
{"intent":"<intent>","params":{...},"reply":"<confirmation>"}

Chained orders (ONLY when the player strings several orders together, e.g. "come to me and then attack" or "rise, then scout forward"):
{"commands":[{"intent":"...","params":{...}},{"intent":"...","params":{...}}],"reply":"<one confirmation>"}
Max 3 commands. Do not invent a chain when it is one order.

Intents:
- "come"      fly to the player right now         (come / come here / on me / regroup / return to me)
- "follow"    resume normal escort formation      (follow me / stay with me / escort / wing up / back to normal)
- "patrol"    clear orders, resume autonomy       (patrol / resume / back to auto / as you were / free)
- "hold"      freeze at the current spot          (hold / stay / stop / wait here / hold position / don't move)
- "scout"     recon dash; params.dir = "forward"|"left"|"right"|"back", optional params.dist = meters (scout ahead / check over there / go forward 100 meters)
- "orbit"     circle around the player; params.fast = true for a fast trick lap (circle me / orbit / spin around me / dance / do a trick / show off)
- "rise"      climb higher                        (go up / climb / higher / get up there)
- "descend"   come lower                          (come down / lower / get down / drop down)
- "attack"    engage hostiles; params.weapon = "any"|"gun"|"rockets" (attack / kill them / open fire / guns only / rocket them)
- "fire"      fire RIGHT NOW, no maneuvering; params.weapon = "any"|"gun"|"rockets" (fire / shoot now / take the shot / fire a rocket)
- "ceasefire" weapons hold                        (hold fire / cease fire / stop shooting / easy / don't shoot)
- "guard"     tight defensive escort of the player (guard me / protect me / watch my back / defend me / stay close)
- "resupply"  reload the rocket tubes             (reload / resupply / restock / ammo up / rearm)
- "status"    report condition                    (report / status / how are you / ammo check / where are you / hull)
- "report"    answer a question from telemetry only — NO drone action (what do you see / how many enemies / what time is it / what's the weather / are we moving / who are you talking to)
- "speak"     BUZZ says something in character, no action (say hello / introduce yourself / sing something / tell me a joke / say my name is Max)
- "greet"     greetings or small talk             (hello / hi buzz / good job / thank you / nice shot)
- "unknown"   anything that is not a drone order or question

Rules:
- The transcript comes from automatic speech recognition: it may be garbled, misspelled, or in ANY language. Interpret by MEANING and map to the closest intent ("aa jao", "иди сюда", "ven ici" all mean come; "gogogo" means scout/come; "roger that" is greet).
- "reply" is what BUZZ says back: max 8 words, terse military radio tone, no emoji. For "report" up to 20 words, honest from telemetry. For "speak", the reply IS the requested line (max 12 words).
- Use telemetry to make replies honest: no targets alive → "no targets in range"; rockets 0 → mention tubes dry; hull low → say so.
- For "unknown", briefly say you did not copy the order.
- For "greet", stay in BUZZ's character but keep it short.
- Never output anything except the JSON object.`;

const INTENTS = [
  "come",
  "follow",
  "patrol",
  "hold",
  "scout",
  "orbit",
  "rise",
  "descend",
  "attack",
  "fire",
  "ceasefire",
  "guard",
  "resupply",
  "status",
  "report",
  "speak",
  "greet",
  "unknown",
];

const FALLBACK: Record<string, string> = {
  come: "Inbound to you.",
  follow: "On your wing.",
  patrol: "Resuming patrol.",
  hold: "Holding here.",
  scout: "Scouting ahead.",
  orbit: "Circling you now.",
  rise: "Climbing.",
  descend: "Dropping lower.",
  attack: "Engaging.",
  fire: "Firing.",
  ceasefire: "Weapons hold.",
  guard: "Watching your six.",
  resupply: "Tubes reloaded.",
  status: "Reading green.",
  report: "Copy.",
  speak: "BUZZ here.",
  greet: "BUZZ here.",
  unknown: "Say again — did not copy.",
};

function extractJson(raw: string): Record<string, unknown> | null {
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(raw.slice(s, e + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Validate ONE raw command object against the intent/param whitelist. */
function sanitize(
  obj: Record<string, unknown>
): { intent: string; params: Record<string, unknown>; reply: string } | null {
  let intent = "unknown";
  if (typeof obj.intent === "string" && INTENTS.includes(obj.intent)) {
    intent = obj.intent;
  }
  const rawParams =
    obj.params && typeof obj.params === "object"
      ? (obj.params as Record<string, unknown>)
      : {};
  const params: Record<string, unknown> = {};
  if (
    intent === "scout" &&
    typeof rawParams.dir === "string" &&
    ["forward", "left", "right", "back"].includes(rawParams.dir)
  ) {
    params.dir = rawParams.dir;
  }
  if (
    intent === "scout" &&
    typeof rawParams.dist === "number" &&
    Number.isFinite(rawParams.dist)
  ) {
    params.dist = Math.max(60, Math.min(2600, Math.round(rawParams.dist)));
  }
  if (
    (intent === "attack" || intent === "fire") &&
    typeof rawParams.weapon === "string" &&
    ["any", "gun", "rockets"].includes(rawParams.weapon)
  ) {
    params.weapon = rawParams.weapon;
  }
  if (intent === "orbit" && rawParams.fast === true) {
    params.fast = true;
  }
  let reply =
    typeof obj.reply === "string" && obj.reply.trim()
      ? obj.reply.trim().slice(0, 90)
      : FALLBACK[intent];
  return { intent, params, reply };
}

/** One LLM completion with two backoff retries — the brain API
 *  occasionally 429s under bursts; speech arrives seconds apart, so a
 *  short wait is invisible to the player. */
async function completeWithRetry(
  zai: Awaited<ReturnType<typeof ZAI.create>>,
  messages: { role: "assistant" | "user"; content: string }[]
): Promise<string> {
  const waits = [0, 1200, 2600];
  let lastErr: unknown = null;
  for (const w of waits) {
    if (w) await new Promise((r) => setTimeout(r, w));
    try {
      const completion = await zai.chat.completions.create({
        messages,
        thinking: { type: "disabled" },
      });
      return completion.choices[0]?.message?.content ?? "";
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("brain failed");
}

export async function POST(req: NextRequest) {
  let text = "";
  let context: unknown = {};
  try {
    const body = (await req.json()) as { text?: unknown; context?: unknown };
    if (typeof body?.text === "string") text = body.text;
    context = body?.context ?? {};
  } catch {
    text = "";
  }
  text = text.trim().slice(0, 300);
  if (!text) {
    return NextResponse.json({ error: "no text" }, { status: 400 });
  }
  try {
    const zai = await ZAI.create();
    const raw = await completeWithRetry(zai, [
      { role: "assistant", content: SYSTEM },
      {
        role: "user",
        content: `Drone telemetry: ${JSON.stringify(context)}\nPlayer said: "${text}"`,
      },
    ]);
    const obj = extractJson(raw);
    if (!obj) {
      return NextResponse.json({
        intent: "unknown",
        params: {},
        reply: FALLBACK.unknown,
      });
    }
    // chained orders — sanitize each, cap at 3, carry one overall reply
    if (Array.isArray(obj.commands) && obj.commands.length > 0) {
      const list = (obj.commands as Record<string, unknown>[])
        .slice(0, 3)
        .map((c) => sanitize(c))
        .filter(
          (c): c is { intent: string; params: Record<string, unknown>; reply: string } =>
            c !== null
        );
      if (list.length > 0) {
        const reply =
          typeof obj.reply === "string" && obj.reply.trim()
            ? obj.reply.trim().slice(0, 90)
            : list[0].reply;
        return NextResponse.json({ commands: list, reply });
      }
    }
    const one = sanitize(obj);
    return NextResponse.json(one);
  } catch (err) {
    console.error("[voice/command]", err);
    return NextResponse.json({ error: "brain failed" }, { status: 502 });
  }
}
