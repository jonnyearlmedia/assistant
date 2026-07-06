// specialist subagents (the real "fleet"). the main brain stays lean and DELEGATES a focused
// sub-task to a worker that runs with ONLY that domain's tools + a tight brief. keeps each task
// sharp and the orchestrator's context clean, so lexa scales to arbitrarily many capabilities
// without one bloated 30-tool prompt. the main brain can still use tools directly for simple stuff;
// delegation is for focused multi-step work in one area, or fanning out across independent areas.
import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, dispatch } from "./tools";
import * as mem from "./memory";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.LEXA_MODEL || "claude-sonnet-5";
const MAX_TURNS = 6;

// web search is a server-side tool (the API runs the search + filters results inside the call).
// it lives ONLY in the research specialist, not the main brain — so a bad web-search call can only
// break a research delegation (caught below), never a normal reply.
const WEB_SEARCH = { type: "web_search_20260209", name: "web_search", max_uses: 5 } as any;

// each specialist gets a curated tool subset (names must match TOOLS) + a one-line identity.
const DOMAINS: Record<string, { tools: string[]; brief: string }> = {
  email: {
    tools: ["gmail_search", "gmail_send", "gmail_draft"],
    brief: "you handle jonny's gmail (both inboxes). only send after he's clearly okayed recipient + content.",
  },
  calendar: {
    tools: ["gcal_upcoming", "gcal_create", "gcal_update", "gcal_delete", "drive_time"],
    brief: "you handle jonny's google calendar (his primary planner is ticktick, but calendar is yours).",
  },
  notion: {
    tools: ["notion_search", "notion_read", "notion_query_db", "notion_create_page", "notion_append", "notion_log", "list_master_planner"],
    brief: "you handle jonny's notion — master planner + trackers. query a db for its real property names before writing.",
  },
  tasks: {
    tools: ["ticktick_list", "ticktick_create_task", "ticktick_projects", "ticktick_complete", "ticktick_update", "ticktick_delete"],
    brief: "you handle jonny's ticktick — the source of truth for his schedule + tasks.",
  },
  research: {
    tools: ["web_search"],
    brief: "you research the web and report back the facts he needs, with the gist of the source.",
  },
  memory: {
    tools: ["recall", "list_facts", "remember_fact"],
    brief: "you dig through jonny's full history + saved facts to answer what he said/decided before.",
  },
};

export function subagentDomains(): string[] {
  return Object.keys(DOMAINS);
}

// run one specialist to completion and return a short plain-text result for the orchestrator.
// domain is a built-in (DOMAINS) or the name of a user-defined specialist (subagents table).
export async function runSubagent(userId: string, domain: string, task: string): Promise<string> {
  let toolNames: string[];
  let brief: string;
  const builtin = DOMAINS[domain];
  if (builtin) {
    toolNames = builtin.tools;
    brief = builtin.brief;
  } else {
    const custom = await mem.getUserSubagent(userId, domain);
    if (!custom)
      return `unknown subagent "${domain}". built-in: ${Object.keys(DOMAINS).join(", ")}. (jonny can make a custom one with create_subagent)`;
    toolNames = Array.isArray(custom.tools) ? custom.tools : [];
    brief = custom.brief || `you are jonny's "${domain}" specialist.`;
  }
  const base = (TOOLS as any[]).filter((t) => toolNames.includes(t?.name));
  const toolset = toolNames.includes("web_search") ? [...base, WEB_SEARCH] : base;

  const system = `you are a focused ${domain} specialist working for lexa (jonny's personal assistant). ${brief}
do ONLY the delegated task, using your tools. VERIFY every external write by reading it back — never claim
something's done unless you confirmed it landed. you cannot see the chat with jonny, so work only from the
task given. when finished, reply with a SHORT plain-text result the main assistant can relay — outcomes and
facts only, no filler. if you couldn't do it, say exactly what blocked you.`;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  let out = "";
  try {
    for (let i = 0; i < MAX_TURNS; i++) {
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 1500,
        thinking: { type: "disabled" },
        system,
        tools: toolset,
        messages,
      });
      const text = res.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      if (text) out = text;

      if (res.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: res.content });
        continue;
      }
      const toolUses = res.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      if (res.stop_reason !== "tool_use" || toolUses.length === 0) return (out.trim() || "(no result)");

      messages.push({ role: "assistant", content: res.content });
      const results: any[] = [];
      for (const tu of toolUses) {
        const r = await dispatch(tu.name, tu.input, { userId });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: r });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e: any) {
    return `${domain} subagent errored: ${e?.message || e}`;
  }
  return out.trim() || `(${domain} subagent hit its step limit without finishing)`;
}
