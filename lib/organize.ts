// "just dump it" — jonny writes anything (rules, facts, goals, reminders, workflows) in plain
// words and this sorts each piece into the right place. so he never has to know which box is which.
// one model call classifies + routes; everything is applied to the real tables and a summary comes back.
import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.LEXA_MODEL || "claude-sonnet-5";

const SYSTEM = `you sort jonny's brain-dump into structured items for his assistant lexa. read it and emit one item
per distinct thing, each with the RIGHT type:
- instruction: a standing rule for how lexa should BEHAVE or TALK (always/never, tone, format, length). field: text.
- fact: a stable truth about jonny (a preference/routine/person/work/health detail). fields: category (one short word), key (short), value.
- goal: something he's working toward over time. fields: title, detail (optional).
- playbook: a repeatable workflow or strict format he wants done the same way every time. fields: name, trigger (optional), instructions.
- reminder: a nudge at a specific time. fields: title, due_at (ISO8601 — ONLY if a concrete date/time is clear), location (optional).
- place: a named address. fields: name, address.
- commitment: something he said he'll actually do soon. fields: what, follow_up_at (ISO8601, best guess).
only emit items clearly present. do NOT invent. prefer fewer, accurate items. when unsure between instruction and fact:
a RULE for lexa's behavior = instruction; a truth about jonny = fact. call file_items with the array.`;

const TOOL: any = {
  name: "file_items",
  description: "file the organized items into jonny's assistant",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["instruction", "fact", "goal", "playbook", "reminder", "place", "commitment"] },
            text: { type: "string" }, category: { type: "string" }, key: { type: "string" }, value: { type: "string" },
            title: { type: "string" }, detail: { type: "string" }, name: { type: "string" }, trigger: { type: "string" },
            instructions: { type: "string" }, due_at: { type: "string" }, location: { type: "string" }, address: { type: "string" },
            what: { type: "string" }, follow_up_at: { type: "string" },
          },
          required: ["type"],
        },
      },
    },
    required: ["items"],
  },
};

const iso = (s: string) => new Date(s).toISOString(); // throws on bad input → caller's try/catch skips it

export async function organizeDump(userId: string, text: string): Promise<{ ok: boolean; summary: string }> {
  const body = (text || "").trim();
  if (!body) return { ok: false, summary: "nothing to organize" };

  let items: any[] = [];
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      thinking: { type: "disabled" },
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "file_items" } as any,
      messages: [{ role: "user", content: body }],
    });
    const call: any = res.content.find((b: any) => b.type === "tool_use");
    items = call?.input?.items || [];
  } catch (e: any) {
    return { ok: false, summary: `couldn't sort that: ${e?.message || e}` };
  }

  const done: Record<string, number> = { instruction: 0, fact: 0, goal: 0, playbook: 0, reminder: 0, place: 0, commitment: 0 };
  const instructions: string[] = [];
  for (const it of items) {
    try {
      if (it.type === "instruction" && it.text) { instructions.push(it.text.trim()); done.instruction++; }
      else if (it.type === "fact" && it.value) {
        await db.from("facts").upsert(
          { user_id: userId, category: (it.category || "general").toLowerCase().trim(), key: (it.key || it.value).slice(0, 60).trim(), value: it.value, source: "dashboard-dump", updated_at: new Date().toISOString() },
          { onConflict: "user_id,category,key" }
        );
        done.fact++;
      } else if (it.type === "goal" && it.title) {
        await db.from("goals").insert({ user_id: userId, title: it.title, detail: it.detail || null });
        done.goal++;
      } else if (it.type === "playbook" && it.name && it.instructions) {
        await db.from("playbooks").upsert(
          { user_id: userId, name: it.name.trim(), trigger: it.trigger || null, instructions: it.instructions, active: true, updated_at: new Date().toISOString() },
          { onConflict: "user_id,name" }
        );
        done.playbook++;
      } else if (it.type === "reminder" && it.title && it.due_at) {
        await db.from("reminders").insert({ user_id: userId, title: it.title, due_at: iso(it.due_at), location: it.location || null });
        done.reminder++;
      } else if (it.type === "place" && it.name && it.address) {
        await db.from("places").upsert({ user_id: userId, name: it.name.toLowerCase().trim(), address: it.address }, { onConflict: "user_id,name" });
        done.place++;
      } else if (it.type === "commitment" && it.what) {
        await db.from("commitments").insert({ user_id: userId, what: it.what, follow_up_at: it.follow_up_at ? iso(it.follow_up_at) : new Date(Date.now() + 86400_000).toISOString() });
        done.commitment++;
      }
    } catch {
      /* skip a single malformed item (e.g. unparseable date) */
    }
  }

  if (instructions.length) {
    const { data: user } = await db.from("users").select("settings").eq("id", userId).single();
    const cur = (user?.settings as any)?.custom_instructions || "";
    const merged = ((cur ? cur + "\n" : "") + instructions.map((t) => `- ${t}`).join("\n")).slice(0, 4000);
    await db.from("users").update({ settings: { ...((user?.settings as any) || {}), custom_instructions: merged } }).eq("id", userId);
  }

  const parts = Object.entries(done).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}${n > 1 ? "s" : ""}`);
  return {
    ok: true,
    summary: parts.length ? `filed → ${parts.join(", ")}. review the sections below.` : "hmm, couldn't find anything concrete to file — try being a little more specific.",
  };
}
