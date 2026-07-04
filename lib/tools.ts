// the tools lexa can call. memory/reminder/playbook tools are LIVE (Supabase-backed).
// integration tools (ticktick/notion/gmail/maps) are honest stubs until each service's auth
// is wired — they return a clear "not connected yet" so lexa never fakes a capability.

import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import * as mem from "./memory";
import * as notion from "./integrations/notion";
import * as maps from "./integrations/maps";
import * as ticktick from "./integrations/ticktick";
import * as google from "./integrations/google";

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "remember_fact",
    description:
      "Save a durable fact about jonny to memory (editable later). Use for routines, preferences, people, health, work context.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "routine | preference | person | health | work | general" },
        key: { type: "string", description: "short stable key, e.g. 'wake_time'" },
        value: { type: "string" },
      },
      required: ["category", "key", "value"],
    },
  },
  {
    name: "forget_fact",
    description: "Delete a fact from memory. Use when jonny says forget it / that's wrong / no longer true.",
    input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "list_facts",
    description: "List everything lexa currently remembers about jonny. Use when he asks 'what do you know about me'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_goal",
    description: "Record a goal to hold jonny accountable to.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" }, detail: { type: "string" }, cadence: { type: "string" } },
      required: ["title"],
    },
  },
  {
    name: "save_playbook",
    description:
      "Save a reusable workflow or strict format jonny taught you (e.g. how to log health_mood, or a task-routing rule). This is how you learn new behavior without a code change.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        instructions: { type: "string", description: "exactly what to do, in your words" },
        trigger: { type: "string", description: "when to run it" },
        format: { type: "object", description: "strict field schema for structured logs" },
        target: { type: "object", description: "where it writes, e.g. {notion_db_id: '...'}" },
      },
      required: ["name", "instructions"],
    },
  },
  {
    name: "schedule_reminder",
    description:
      "Schedule a reminder/nudge. For 'leave now' set location + lead_time_min so drive time can be added. due_at is ISO8601.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        due_at: { type: "string" },
        lead_time_min: { type: "number" },
        location: { type: "string" },
        recurrence: { type: "string" },
      },
      required: ["title", "due_at"],
    },
  },
  {
    name: "list_reminders",
    description: "List jonny's upcoming scheduled reminders.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_automation",
    description:
      "Set up a recurring automation lexa runs on a schedule and texts jonny the result — e.g. 'every morning summarize my unread email', 'every friday review my week', 'each night ask how my day went'. She runs it with full tools (can read email, create tasks, etc.). hour is 0-23 in his timezone; weekday optional (0=sun..6=sat, omit = daily).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        instruction: { type: "string", description: "what to do when it fires, in your words" },
        hour: { type: "number" },
        weekday: { type: "number" },
      },
      required: ["name", "instruction", "hour"],
    },
  },
  {
    name: "route_todo",
    description:
      "Decide where a to-do belongs: ticktick (schedulable/recording), master_planner (planner/project), or short_term (lightweight). Returns the routing decision; then call the matching create tool.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" }, area: { type: "string", description: "school|work|project|today|week|..." } },
      required: ["text"],
    },
  },
  // --- integrations (stubbed until auth wired) ---
  {
    name: "ticktick_create_task",
    description: "Create a task in TickTick (source of truth for schedule). Verified read-back after write.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" }, due: { type: "string" }, project: { type: "string" }, priority: { type: "number" } },
      required: ["title"],
    },
  },
  {
    name: "notion_log",
    description:
      "Write to Notion. target='master_planner' creates a task in the MASTER PLANNER db — fields: {task (required), due (ISO date), status, priority, project, type, category, firmness, critical (bool), focus (bool), tags (string[])}. target='health_mood' is the mood tracker (strict format — only if you have the playbook). VERIFIED read-back after write; report verified:false honestly, never fake it.",
    input_schema: {
      type: "object",
      properties: { target: { type: "string", description: "master_planner | health_mood | <page/db id>" }, fields: { type: "object" } },
      required: ["target", "fields"],
    },
  },
  {
    name: "list_master_planner",
    description:
      "Read jonny's current tasks from the Notion MASTER PLANNER database (task, status, due, priority, project). Use for 'what's on my planner', planning, or before adding to avoid dupes.",
    input_schema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "gmail_search",
    description: "Search jonny's Gmail (Gmail query syntax) and summarize the top results.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "gcal_upcoming",
    description: "List jonny's upcoming Google Calendar events (note: his primary planner is TickTick).",
    input_schema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "gcal_create",
    description: "Create a Google Calendar event. start/end are ISO8601. Verified read-back.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, location: { type: "string" } },
      required: ["title", "start"],
    },
  },
  {
    name: "drive_search",
    description: "Search jonny's Google Drive by filename and return matching files with links.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "drive_time",
    description: "Get live drive time between two places (for 'leave now' reminders).",
    input_schema: {
      type: "object",
      properties: { origin: { type: "string" }, destination: { type: "string" } },
      required: ["destination"],
    },
  },
];

async function integrationConnected(userId: string, provider: string): Promise<boolean> {
  const { data } = await db
    .from("integrations")
    .select("status")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  return data?.status === "connected";
}

const NOT_CONNECTED = (p: string) =>
  `⚠️ ${p} isn't connected yet — jonny needs to approve the ${p} login before I can do this. Tell him plainly; do NOT pretend it worked.`;

/** Execute a tool call. Returns a string result for the model. */
export async function dispatch(name: string, input: any, ctx: { userId: string }): Promise<string> {
  const u = ctx.userId;
  try {
    switch (name) {
      case "remember_fact":
        return JSON.stringify(await mem.rememberFact(u, input.category, input.key, input.value));
      case "forget_fact":
        return JSON.stringify(await mem.forgetFact(u, input.key));
      case "list_facts":
        return JSON.stringify(await mem.listFacts(u));
      case "set_goal":
        return JSON.stringify(await mem.setGoal(u, input.title, input.detail, input.cadence));
      case "save_playbook":
        return JSON.stringify(
          await mem.savePlaybook(u, input.name, input.instructions, {
            trigger: input.trigger,
            format: input.format,
            target: input.target,
          })
        );
      case "schedule_reminder":
        return JSON.stringify(await mem.scheduleReminder(u, input));
      case "list_reminders":
        return JSON.stringify(await mem.listReminders(u));
      case "create_automation":
        return JSON.stringify(
          await mem.savePlaybook(u, input.name, input.instruction, {
            trigger: `automation @ ${input.hour}:00 ${input.weekday != null ? `wd${input.weekday}` : "daily"}`,
            format: { automation: true, hour: input.hour, weekday: input.weekday ?? null, last_run: null },
          })
        );
      case "route_todo": {
        // lightweight heuristic; refined by learned routing playbooks over time
        return JSON.stringify({
          text: input.text,
          suggestion:
            "decide among ticktick | master_planner | short_term based on whether it's time-bound (ticktick), project/ongoing (master_planner), or a quick throwaway (short_term). confirm with jonny if unsure.",
        });
      }
      case "ticktick_create_task":
        if (!(await ticktick.ticktickConnected())) return NOT_CONNECTED("TickTick");
        return JSON.stringify(
          await ticktick.createTask({ title: input.title, due: input.due, priority: input.priority })
        );
      case "notion_log": {
        if (!notion.notionConnected()) return NOT_CONNECTED("Notion");
        const f = input.fields || {};
        if (input.target === "master_planner") {
          return JSON.stringify(
            await notion.createMasterPlannerTask({
              task: f.task || f.title || f.name,
              due: f.due || f.due_date,
              status: f.status,
              priority: f.priority,
              project: f.project,
              type: f.type,
              category: f.category,
              firmness: f.firmness,
              tags: f.tags,
              critical: f.critical,
              focus: f.focus,
            })
          );
        }
        if (input.target === "health_mood") {
          return "health_mood format isn't mapped yet — ask jonny for the exact fields + options ONCE, save it as a playbook, then log. do NOT guess the format or fake the entry.";
        }
        return `notion target '${input.target}' not wired yet.`;
      }
      case "list_master_planner":
        if (!notion.notionConnected()) return NOT_CONNECTED("Notion");
        return JSON.stringify(await notion.listMasterPlanner(input.limit || 12));
      case "gmail_search":
        if (!(await google.googleConnected())) return NOT_CONNECTED("Gmail");
        return JSON.stringify(await google.gmailSearch(input.query, 5));
      case "gcal_upcoming":
        if (!(await google.googleConnected())) return NOT_CONNECTED("Google Calendar");
        return JSON.stringify(await google.calendarUpcoming(input.limit || 10));
      case "gcal_create":
        if (!(await google.googleConnected())) return NOT_CONNECTED("Google Calendar");
        return JSON.stringify(
          await google.calendarCreate({ title: input.title, start: input.start, end: input.end, location: input.location })
        );
      case "drive_search":
        if (!(await google.googleConnected())) return NOT_CONNECTED("Google Drive");
        return JSON.stringify(await google.driveSearch(input.query, 6));
      case "drive_time": {
        if (!maps.mapsConnected()) return NOT_CONNECTED("Google Maps");
        let origin = input.origin;
        if (!origin) {
          const { data } = await db
            .from("users")
            .select("home_address,last_address")
            .eq("id", u)
            .maybeSingle();
          origin = data?.last_address || data?.home_address;
        }
        if (!origin) return "need an origin — set jonny's home address or share location first.";
        return JSON.stringify(await maps.driveTime(origin, input.destination));
      }
      default:
        return `unknown tool: ${name}`;
    }
  } catch (e: any) {
    return `tool error (${name}): ${e?.message || String(e)}`;
  }
}
