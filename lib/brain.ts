// lexa's brain: takes an inbound text, loads her memory, runs the Anthropic tool-use loop,
// and returns what she wants to say back. persona rules (verified writes, backbone, etc.)
// live in the system prompt.

import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "./persona";
import { TOOLS, dispatch } from "./tools";
import { User } from "./db";
import { fetchMedia } from "./linq";
import * as mem from "./memory";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.LEXA_MODEL || "claude-sonnet-5";
const MAX_TOOL_TURNS = 8;

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

  // current inbound — attach real images for vision (food pics, screenshots, etc.)
  let userContent: any = incomingText;
  if (media.length > 0) {
    const imgs = ((await Promise.all(media.map((u) => fetchMedia(u)))).filter(Boolean) as {
      mediaType: string;
      data: string;
    }[]);
    if (imgs.length > 0) {
      userContent = [
        ...(incomingText ? [{ type: "text", text: incomingText }] : []),
        ...imgs.map((im) => ({
          type: "image",
          source: { type: "base64", media_type: im.mediaType, data: im.data },
        })),
      ];
    } else if (!incomingText) {
      userContent = "[sent an attachment i couldn't open — ask him what it was]";
    }
  }
  messages.push({ role: "user", content: userContent });

  let reply = "";
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: TOOLS,
      messages,
    });

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
  const system = buildSystemPrompt({
    name: user.name ?? undefined,
    timezone: user.timezone,
    now: new Date().toLocaleString("en-US", { timeZone: user.timezone }),
    onboardingStage: user.onboarding_stage,
    facts: facts.map((f) => `- [${f.category}] ${f.key}: ${f.value}`).join("\n"),
    goals: goals.map((g) => `- ${g.title}${g.detail ? ` (${g.detail})` : ""}`).join("\n"),
    playbooks: playbooks.map((p) => `- ${p.name}: ${p.instructions}`).join("\n"),
  });
  const prompt = `you're reaching out to ${user.name ?? "jonny"} FIRST, unprompted — he did not just text you.
SITUATION: ${situation}
${context ? `\nRELEVANT DATA:\n${context}\n` : ""}
write exactly what you'd text him right now. keep it short + natural, real bubbles separated by blank lines. don't overexplain that you're being proactive — just text him like a friend would.`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
