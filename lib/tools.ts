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
import * as spend from "./spend";
import * as sub from "./subagents";

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
    description: "Create a task in TickTick. 'project' = list name (e.g. 'Fitness', 'Personal') — omit for Inbox. due=ISO8601. priority 0/1/3/5. Verified read-back.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" }, due: { type: "string" }, project: { type: "string" }, priority: { type: "number" } },
      required: ["title"],
    },
  },
  {
    name: "ticktick_projects",
    description: "List jonny's TickTick projects/lists with their ids (needed to move tasks or create into a specific list).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "ticktick_complete",
    description: "Mark a TickTick task done. Needs task_id + project_id (get both from ticktick_list).",
    input_schema: { type: "object", properties: { task_id: { type: "string" }, project_id: { type: "string" } }, required: ["task_id", "project_id"] },
  },
  {
    name: "ticktick_update",
    description: "Reschedule / rename / re-prioritize / MOVE a TickTick task. task_id + project_id required. Set due (ISO8601) to reschedule, move_to_project_id to move it to another list. Verified read-back.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string" }, project_id: { type: "string" }, title: { type: "string" }, due: { type: "string" }, priority: { type: "number" }, move_to_project_id: { type: "string" } },
      required: ["task_id", "project_id"],
    },
  },
  {
    name: "ticktick_delete",
    description: "Delete a TickTick task. Needs task_id + project_id.",
    input_schema: { type: "object", properties: { task_id: { type: "string" }, project_id: { type: "string" } }, required: ["task_id", "project_id"] },
  },
  {
    name: "ticktick_list",
    description:
      "READ jonny's TickTick (source of truth). scope: today|week|all. Returns dated tasks in the window, OVERDUE tasks, and UNDATED tasks grouped by project — he keeps MOST of his tasks undated inside projects (Work, School, Fitness, etc.). CRITICAL: if nothing is dated this week, do NOT say 'nothing' — surface his overdue + undated backlog by project so he's never flying blind. Always give him the real picture of his plate.",
    input_schema: { type: "object", properties: { scope: { type: "string", description: "today | week | all" } } },
  },
  {
    name: "notion_search",
    description:
      "Search ALL of jonny's Notion — any page or database (not just Master Planner). Use for 'find my X page', 'what's in my Y', 'search my notion'. Returns titles + ids + type. If it returns nothing, that page just isn't shared with the integration yet — tell him to share it (••• → Connections → text-assistant).",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "notion_read",
    description: "Read the actual content of a Notion page by id (get the id from notion_search first).",
    input_schema: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] },
  },
  {
    name: "notion_query_db",
    description: "Query any Notion database by id (get the id from notion_search). Returns the rows with their properties.",
    input_schema: { type: "object", properties: { database_id: { type: "string" } }, required: ["database_id"] },
  },
  {
    name: "notion_create_page",
    description:
      "Create a page/row in ANY Notion database (e.g. log a mood entry in health_mood). fields is a {property_name: value} map — it's auto-mapped to the db's real property types. Query the db first (notion_query_db / notion_search) to learn the exact property names. Verified read-back.",
    input_schema: {
      type: "object",
      properties: { database_id: { type: "string" }, fields: { type: "object" } },
      required: ["database_id", "fields"],
    },
  },
  {
    name: "notion_append",
    description: "Append text content to any Notion page by id (each line becomes a paragraph). Use for journaling/notes into an existing page.",
    input_schema: { type: "object", properties: { page_id: { type: "string" }, text: { type: "string" } }, required: ["page_id", "text"] },
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
    name: "gmail_send",
    description: "SEND an email as jonny from his primary Gmail. Only call this AFTER he's explicitly okayed the recipient + content — confirm first, then send.",
    input_schema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] },
  },
  {
    name: "gmail_draft",
    description: "Save a Gmail draft (does NOT send). Good for prepping a reply he can review/send later.",
    input_schema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] },
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
    name: "gcal_update",
    description: "Reschedule/rename/move a Google Calendar event by id (get id from gcal_upcoming). start/end ISO8601.",
    input_schema: {
      type: "object",
      properties: { event_id: { type: "string" }, title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, location: { type: "string" } },
      required: ["event_id"],
    },
  },
  {
    name: "gcal_delete",
    description: "Delete a Google Calendar event by id (get id from gcal_upcoming).",
    input_schema: { type: "object", properties: { event_id: { type: "string" } }, required: ["event_id"] },
  },
  {
    name: "drive_search",
    description: "Search jonny's Google Drive by filename. Returns files with ids + links (use the id with drive_read).",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "drive_read",
    description: "Read the contents of a Google Drive file by id (get the id from drive_search). Handles Google Docs + text files.",
    input_schema: { type: "object", properties: { file_id: { type: "string" } }, required: ["file_id"] },
  },
  {
    name: "save_place",
    description: "Save a named place (home, gym, work, school…) with its address, for drive-time + 'leave now' reminders. Naming one 'home' sets his home address.",
    input_schema: { type: "object", properties: { name: { type: "string" }, address: { type: "string" } }, required: ["name", "address"] },
  },
  {
    name: "list_places",
    description: "List jonny's saved places (name + address).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_current_location",
    description: "Set jonny's current location when he tells you where he is (address or place). Used for accurate drive-time / 'when should I leave' math.",
    input_schema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
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
  {
    name: "track_commitment",
    description:
      "When jonny says he'll do something later ('i'll hit the gym after work', 'gonna call mom tomorrow', 'i'll finish that tonight'), record it so you follow up and hold him accountable. what = the thing ('hit the gym'). follow_up_at = ISO8601, a bit AFTER when he said he'd do it, so you can check whether he actually did. context = the gist of what he said. Don't make a big deal of it in your reply — a quick 'bet' is enough.",
    input_schema: {
      type: "object",
      properties: {
        what: { type: "string" },
        follow_up_at: { type: "string", description: "ISO8601, shortly after he said he'd do it" },
        context: { type: "string" },
      },
      required: ["what", "follow_up_at"],
    },
  },
  {
    name: "list_commitments",
    description:
      "List jonny's open commitments (things he said he'd do that you're tracking, incl. ones you already nudged). Use to reference them, or to get an id before resolving one.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "resolve_commitment",
    description:
      "Close out a tracked commitment when jonny tells you what happened. status: kept (he did it), missed (he didn't), or cancelled (no longer relevant). Get the id from list_commitments. Resolve honestly — this is his real accountability record.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", description: "kept | missed | cancelled" },
        outcome: { type: "string", description: "what actually happened" },
      },
      required: ["id", "status"],
    },
  },
  {
    name: "spend_report",
    description:
      "Estimate what you (the AI) are costing jonny, from the token usage log. Call this when he asks about cost / spend / 'how much are you costing me' / his Anthropic bill. period: today | week | month | all. Returns a ~dollar estimate + a breakdown by function (think = full brain, triage = cheap Haiku, proactive = your outreach). It's an ESTIMATE off logged tokens — tell him with a '~', don't present it as an exact invoice.",
    input_schema: {
      type: "object",
      properties: { period: { type: "string", description: "today | week | month | all" } },
    },
  },
  {
    name: "recall",
    description:
      "Search jonny's FULL history — past messages + saved facts — for something OLDER than the recent conversation you can already see. Use whenever he references a past chat, detail, or decision ('what did i say about X', 'that place i mentioned', 'the thing from last week') and it's not in your recent context. Returns matching past messages + facts with dates. Recall before ever claiming you don't remember.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
  },
  {
    name: "delegate",
    description:
      "Spin up a specialist SUBAGENT to handle a focused sub-task, so you stay lean and can run areas independently. domain: email | calendar | notion | tasks | research | memory. task: a clear, COMPLETE instruction (the specialist can't see this chat — hand it everything it needs). It runs with ONLY that domain's tools, verifies its own writes, and returns a short result. research = web lookup (current facts/news/prices/hours). Delegate several in one turn for independent work (e.g. check email AND scan the calendar); or just use your own tools directly for something simple/one-step.",
    input_schema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "email | calendar | notion | tasks | research | memory" },
        task: { type: "string", description: "complete standalone instruction for the specialist" },
      },
      required: ["domain", "task"],
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
          await ticktick.createTask({ title: input.title, due: input.due, priority: input.priority, project: input.project })
        );
      case "ticktick_projects":
        if (!(await ticktick.ticktickConnected())) return NOT_CONNECTED("TickTick");
        return JSON.stringify(await ticktick.listProjects());
      case "ticktick_complete":
        if (!(await ticktick.ticktickConnected())) return NOT_CONNECTED("TickTick");
        return JSON.stringify(await ticktick.completeTask(input.project_id, input.task_id));
      case "ticktick_update":
        if (!(await ticktick.ticktickConnected())) return NOT_CONNECTED("TickTick");
        return JSON.stringify(
          await ticktick.updateTask({
            taskId: input.task_id,
            projectId: input.project_id,
            title: input.title,
            due: input.due,
            priority: input.priority,
            moveToProjectId: input.move_to_project_id,
          })
        );
      case "ticktick_delete":
        if (!(await ticktick.ticktickConnected())) return NOT_CONNECTED("TickTick");
        return JSON.stringify(await ticktick.deleteTask(input.project_id, input.task_id));
      case "ticktick_list":
        if (!(await ticktick.ticktickConnected())) return NOT_CONNECTED("TickTick");
        return JSON.stringify(await ticktick.listTasks(input.scope || "all"));
      case "notion_search":
        if (!notion.notionConnected()) return NOT_CONNECTED("Notion");
        return JSON.stringify(await notion.search(input.query, 8));
      case "notion_read":
        if (!notion.notionConnected()) return NOT_CONNECTED("Notion");
        return JSON.stringify(await notion.readPage(input.page_id));
      case "notion_query_db":
        if (!notion.notionConnected()) return NOT_CONNECTED("Notion");
        return JSON.stringify(await notion.queryDatabase(input.database_id));
      case "notion_create_page":
        if (!notion.notionConnected()) return NOT_CONNECTED("Notion");
        return JSON.stringify(await notion.createPageInDb(input.database_id, input.fields || {}));
      case "notion_append":
        if (!notion.notionConnected()) return NOT_CONNECTED("Notion");
        return JSON.stringify(await notion.appendText(input.page_id, input.text));
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
          return "for health_mood: notion_search it → notion_query_db to see its exact property names/options → then notion_create_page with those fields (follow jonny's saved format playbook if one exists). don't guess property names.";
        }
        return `notion target '${input.target}' not wired yet.`;
      }
      case "list_master_planner":
        if (!notion.notionConnected()) return NOT_CONNECTED("Notion");
        return JSON.stringify(await notion.listMasterPlanner(input.limit || 12));
      case "gmail_search":
        if (!(await google.googleConnected())) return NOT_CONNECTED("Gmail");
        return JSON.stringify(await google.gmailSearch(input.query, 5));
      case "gmail_send":
        if (!(await google.googleConnected())) return NOT_CONNECTED("Gmail");
        return JSON.stringify(await google.gmailSend(input.to, input.subject, input.body));
      case "gmail_draft":
        if (!(await google.googleConnected())) return NOT_CONNECTED("Gmail");
        return JSON.stringify(await google.gmailDraft(input.to, input.subject, input.body));
      case "gcal_upcoming":
        if (!(await google.googleConnected())) return NOT_CONNECTED("Google Calendar");
        return JSON.stringify(await google.calendarUpcoming(input.limit || 10));
      case "gcal_create":
        if (!(await google.googleConnected())) return NOT_CONNECTED("Google Calendar");
        return JSON.stringify(
          await google.calendarCreate({ title: input.title, start: input.start, end: input.end, location: input.location })
        );
      case "gcal_update":
        if (!(await google.googleConnected())) return NOT_CONNECTED("Google Calendar");
        return JSON.stringify(
          await google.calendarUpdate(input.event_id, { title: input.title, start: input.start, end: input.end, location: input.location })
        );
      case "gcal_delete":
        if (!(await google.googleConnected())) return NOT_CONNECTED("Google Calendar");
        return JSON.stringify(await google.calendarDelete(input.event_id));
      case "drive_search":
        if (!(await google.googleConnected())) return NOT_CONNECTED("Google Drive");
        return JSON.stringify(await google.driveSearch(input.query, 6));
      case "drive_read":
        if (!(await google.googleConnected())) return NOT_CONNECTED("Google Drive");
        return JSON.stringify(await google.driveRead(input.file_id));
      case "save_place":
        return JSON.stringify(await mem.savePlace(u, input.name, input.address));
      case "list_places":
        return JSON.stringify(await mem.listPlaces(u));
      case "set_current_location":
        return JSON.stringify(await mem.setCurrentLocation(u, input.address));
      case "track_commitment":
        return JSON.stringify(
          await mem.trackCommitment(u, { what: input.what, follow_up_at: input.follow_up_at, context: input.context })
        );
      case "list_commitments":
        return JSON.stringify(await mem.listOpenCommitments(u));
      case "resolve_commitment":
        return JSON.stringify(await mem.resolveCommitment(u, input.id, input.status, input.outcome));
      case "spend_report":
        return JSON.stringify(await spend.computeSpend(spend.periodSince(input.period || "week")));
      case "recall":
        return JSON.stringify(await mem.searchMemory(u, input.query, input.limit || 8));
      case "delegate":
        return await sub.runSubagent(u, input.domain, input.task);
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
        if (!origin) return "need an origin — set jonny's home address or tell me where he is first.";
        return JSON.stringify(await maps.driveTime(origin, input.destination));
      }
      default:
        return `unknown tool: ${name}`;
    }
  } catch (e: any) {
    return `tool error (${name}): ${e?.message || String(e)}`;
  }
}
