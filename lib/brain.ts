// lexa's brain: takes an inbound text, loads her memory, runs the Anthropic tool-use loop,
// and returns what she wants to say back. persona rules (verified writes, backbone, etc.)
// live in the system prompt.

import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "./persona";
import { TOOLS, dispatch } from "./tools";
import { User, db } from "./db";
import { fetchMedia, fetchTextAttachment } from "./linq";
import * as mem from "./memory";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.LEXA_MODEL || "claude-sonnet-5";
const MAX_TOOL_TURNS = 8;

// request-time copy of messages with a cache breakpoint on the very last content block,
// so each call in the tool loop reuses everything before it (system + tools + prior turns).
// never mutates the working array — markers must not accumulate across loop iterations
// (the API allows max 4 breakpoints per request).
function withCacheMarker(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  const blocks: any[] =
    typeof last.content === "string"
      ? last.content
        ? [{ type: "text", text: last.content }]
        : []
      : (last.content as any[]).slice();
  if (blocks.length === 0) return messages;
  const tail = blocks[blocks.length - 1];
  blocks[blocks.length - 1] = { ...tail, cache_control: { type: "ephemeral" } };
  out[out.length - 1] = { ...last, content: blocks };
  return out;
}

// per-call token accounting: one line in the Vercel logs + a row in usage_log (queryable spend
// tracking). the insert is fire-and-forget — usage bookkeeping must never delay or break a reply.
function logUsage(fn: string, turn: number, u: Anthropic.Usage) {
  const row = {
    fn,
    turn,
    model: MODEL,
    input: u.input_tokens,
    cache_read: u.cache_read_input_tokens ?? 0,
    cache_write: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens,
  };
  console.log("[lexa] usage", JSON.stringify(row));
  Promise.resolve(db.from("usage_log").insert(row)).catch(() => {});
}

export async function think(
  user: User,
  incomingText: string,
  media: string[] = [],
  opts: { historyBefore?: string } = {}
): Promise<string> {
  // load memory into context
  const [facts, goals, playbooks, history] = await Promise.all([
    mem.listFacts(user.id),
    mem.listGoals(user.id),
    mem.listPlaybooks(user.id),
    mem.recentMessages(user.id, 20, opts.historyBefore),
  ]);

  const system = buildSystemPrompt({
    name: user.name ?? undefined,
    timezone: user.timezone,
    now: new Date().toLocaleString("en-US", { timeZone: user.timezone }),
    onboardingStage: user.onboarding_stage,
    facts: facts.map((f) => `- [${f.category}] ${f.key}: ${f.value}`).join("\n"),
    goals: goals.map((g) => `- ${g.title}${g.detail ? ` (${g.detail})` : ""}`).join("\n"),
    playbooks: playbooks
      .map((p) => `- ${p.name}${p.trigger ? ` [when: ${p.trigger}]` : ""}: ${p.instructions}`)
      .join("\n"),
  });

  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.direction === "inbound" ? "user" : "assistant",
    content: m.body || "",
  }));

  // current inbound — pull in attachments: images for vision, text/markdown files for ingestion
  let userContent: any = incomingText;
  if (media.length > 0) {
    const blocks: any[] = incomingText ? [{ type: "text", text: incomingText }] : [];
    for (const u of media) {
      const img = await fetchMedia(u);
      if (img) {
        blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
        continue;
      }
      const file = await fetchTextAttachment(u);
      if (file) blocks.push({ type: "text", text: `[attached file — its full contents follow]\n\n${file.text}` });
    }
    if (blocks.length > 0) userContent = blocks;
    else if (!incomingText) userContent = "[sent an attachment i couldn't open — ask him what it was]";
  }
  messages.push({ role: "user", content: userContent });

  let reply = "";
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    // max_tokens must leave room for adaptive thinking (on by default for this model) AND the
    // reply — a cap hit mid-thinking yields zero text blocks and she'd text "…"
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system,
      tools: TOOLS,
      messages: withCacheMarker(messages),
    });
    logUsage("think", turn, res.usage);

    // collect any text she emitted
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text) reply = text;

    const toolUses = res.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
      return reply.trim();
    }

    // run the tools she asked for, feed results back
    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const out = await dispatch(tu.name, tu.input, { userId: user.id });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
    }
    messages.push({ role: "user", content: results });
  }

  return (reply || "gimme a sec, that one got tangled — try me again?").trim();
}

// lexa reaching out FIRST (proactive): morning briefs, reminders, nudges, learning check-ins.
// single call, no tools — just composes what she'd text right now given the situation + her memory.
export async function composeProactive(
  user: User,
  situation: string,
  context?: string
): Promise<string> {
  const [facts, goals, playbooks] = await Promise.all([
    mem.listFacts(user.id),
    mem.listGoals(user.id),
    mem.listPlaybooks(user.id),
  ]);
  // no tools on this call → different prompt prefix than think(), so it can't share that
  // cache anyway; proactive fires a handful of times a day, not worth its own cache writes.
  const system = buildSystemPrompt(
    {
      name: user.name ?? undefined,
      timezone: user.timezone,
      now: new Date().toLocaleString("en-US", { timeZone: user.timezone }),
      onboardingStage: user.onboarding_stage,
      facts: facts.map((f) => `- [${f.category}] ${f.key}: ${f.value}`).join("\n"),
      goals: goals.map((g) => `- ${g.title}${g.detail ? ` (${g.detail})` : ""}`).join("\n"),
      playbooks: playbooks.map((p) => `- ${p.name}: ${p.instructions}`).join("\n"),
    },
    { cache: false }
  );
  const prompt = `you're reaching out to ${user.name ?? "jonny"} FIRST, unprompted — he did not just text you.
SITUATION: ${situation}
${context ? `\nRELEVANT DATA:\n${context}\n` : ""}
write exactly what you'd text him right now. keep it short + natural, real bubbles separated by blank lines. don't overexplain that you're being proactive — just text him like a friend would.`;

  // thinking off: this is a straight compose (no tools), and with it on-by-default a big brief
  // context can burn the whole token budget on thinking and deliver zero text (the "…" bug)
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    thinking: { type: "disabled" },
    system,
    messages: [{ role: "user", content: prompt }],
  });
  logUsage("proactive", 0, res.usage);
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
