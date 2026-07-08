// cheap front-door triage (roadmap #1 follow-on: Haiku routing).
//
// every inbound text used to spin up the full Sonnet tool loop — all tools + full memory in
// context — even for "gn" or "thanks". this routes the trivial social stuff to a single cheap
// Haiku call that answers directly, and lets everything substantive fall through to think()
// UNCHANGED. the win is per-turn: a big chunk of daily texts are chatter, and those now cost a
// few hundred Haiku tokens instead of a full cached-Sonnet turn.
//
// design rules:
// - CONSERVATIVE: default to the full brain. only take the quick path for pure chatter where a
//   warm one-liner is a COMPLETE answer and nothing (memory / tool / task / lookup) is implied.
// - FAIL-SAFE: any error, empty output, or unparseable response → route "full". triage must never
//   be the reason a real request gets dropped or mishandled.
// - CACHE-SAFE: this is a separate model with its own tiny prompt. it does not touch the persona /
//   TOOLS / think() prefix, so the Sonnet prompt-cache path is completely unaffected.
import Anthropic from "@anthropic-ai/sdk";
import { User, db } from "./db";
import * as mem from "./memory";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TRIAGE_MODEL = process.env.LEXA_TRIAGE_MODEL || "claude-haiku-4-5-20251001";

export type TriageResult = { route: "quick" | "full"; reply?: string };

// her voice, compressed — just enough for a quick chatter reply to sound like lexa, not a bot.
const TRIAGE_SYSTEM = `you are lexa — jonny's personal AI who lives in his texts. a girl, she/her.
voice: lowercase, gen-z, warm, a little playful, SHORT. you text like a real friend, never a help desk.

your job here is FAST TRIAGE of the NEW message. decide if it's trivial social chatter you can
close out in one warm line, or if it needs jonny's full assistant (memory, tools, real action).

you're given the RECENT THREAD for context, then the NEW message. judge the new message IN THE
CONTEXT OF THAT THREAD — a short text is only chatter if the whole conversation is socially closed
out. if the thread has any loose end, it is NOT chatter, no matter how trivial the new message looks.

answer with EXACTLY ONE of these two forms, nothing else:
- "QUICK: <your short reply>"  — ONLY when the thread is fully closed AND the new message is pure
  chatter: greetings, thanks, acknowledgments, reactions, "gn"/"lol"/"ok cool", light banter,
  "how are you". a warm 1-2 line reply must fully close it. keep it lowercase and short, real
  bubbles ok (blank line between them).
- "FULL"  — for ANYTHING else: a task, reminder, calendar/email/notion/ticktick anything, a question
  about his day/schedule/life/data, a request to do/look up/remember/change/check something, plans,
  numbers, or anything you're even slightly unsure about. ALSO answer FULL whenever the thread has an
  open loose end the new message plugs into — jonny made a request that isn't confirmed done, you
  said you'd do/check/build/look at something and haven't reported back, or he's chasing a reply
  ("hello?", "you there?", "did you see my message", "dude", "?", "so?"). those are follow-ups on
  real work, not chatter — route them FULL so the real brain picks the thread back up.

when in doubt, answer FULL. it is much worse to quick-reply something that needed real action than
to send a trivial "thanks" through the full brain. never explain your choice — output only the form.`;

function logTriageUsage(u: Anthropic.Usage) {
  const row = {
    fn: "triage",
    turn: 0,
    model: TRIAGE_MODEL,
    input: u.input_tokens,
    cache_read: u.cache_read_input_tokens ?? 0,
    cache_write: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens,
  };
  console.log("[lexa] usage", JSON.stringify(row));
  Promise.resolve(db.from("usage_log").insert(row)).catch(() => {});
}

// last few rows of the thread, oldest→newest, so the triage can tell a mid-task follow-up from
// standalone chatter. cheap (a few hundred Haiku tokens) and best-effort — a load failure just
// means we classify without context (still fail-safe: unsure → FULL).
async function recentThread(userId: string, beforeIso?: string): Promise<string> {
  try {
    const rows = await mem.recentMessages(userId, 12, beforeIso);
    return rows
      .map((m) => ({ who: m.direction === "inbound" ? "jonny" : "you", body: (m.body || "").replace(/\s+/g, " ").trim() }))
      .filter((m) => m.body)
      .map((m) => `${m.who}: ${m.body.slice(0, 200)}`)
      .join("\n");
  } catch {
    return "";
  }
}

export async function quickTriage(
  user: User,
  text: string,
  opts: { historyBefore?: string } = {}
): Promise<TriageResult> {
  const body = (text || "").trim();
  if (!body) return { route: "full" }; // nothing to classify — let the brain handle the empty/edge case
  // opt-out hatch: jonny can disable triage from settings and force everything through the full brain
  if ((user.settings as any)?.triage_disabled) return { route: "full" };

  try {
    const thread = await recentThread(user.id, opts.historyBefore);
    // give Haiku the thread as context, then the new message to classify. one user turn keeps it
    // simple (no role-alternation reconstruction) and triage doesn't cache, so shape doesn't matter.
    const content = thread
      ? `RECENT THREAD (oldest→newest, for context only):\n${thread}\n\nNEW MESSAGE TO CLASSIFY:\n${body}`
      : body;
    const res = await client.messages.create({
      model: TRIAGE_MODEL,
      max_tokens: 200,
      thinking: { type: "disabled" },
      system: TRIAGE_SYSTEM,
      messages: [{ role: "user", content }],
    });
    logTriageUsage(res.usage);

    const out = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    // parse the strict contract. anything unexpected → fall through to the full brain.
    const m = out.match(/^QUICK:\s*([\s\S]+)$/i);
    if (m && m[1].trim()) return { route: "quick", reply: m[1].trim() };
    return { route: "full" };
  } catch (e: any) {
    console.error("[lexa] triage failed, routing to full brain:", e?.message || e);
    return { route: "full" };
  }
}
