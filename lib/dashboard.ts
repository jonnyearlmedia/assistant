// shared dashboard data loader — used by the server page (initial render) AND the GET endpoint
// (live refetch after edits, so the UI updates without a full page reload).
import { db } from "./db";
import { ownerUserId } from "./integrations/tokens";
import { computeSpend, periodSince } from "./spend";
import * as ticktick from "./integrations/ticktick";

export type DashData = Awaited<ReturnType<typeof loadDashboard>>;

export async function loadDashboard() {
  const uid = await ownerUserId();
  if (!uid) return null;
  const [facts, goals, playbooks, reminders, integrations, user, commitments, subagents, places, messages, jobs] =
    await Promise.all([
      db.from("facts").select("id,category,key,value").eq("user_id", uid).order("category"),
      db.from("goals").select("id,title,detail,status").eq("user_id", uid).neq("status", "dropped"),
      db.from("playbooks").select("id,name,trigger,instructions,active,format").eq("user_id", uid).order("name"),
      db.from("reminders").select("id,title,due_at,status,recurrence").eq("user_id", uid).eq("status", "scheduled").order("due_at"),
      db.from("integrations").select("provider,status,meta").eq("user_id", uid),
      db.from("users").select("id,name,timezone,home_address,settings").eq("id", uid).single(),
      db.from("commitments").select("id,what,status").eq("user_id", uid).order("created_at", { ascending: false }).limit(25),
      db.from("subagents").select("id,name,brief,tools").eq("user_id", uid).order("name"),
      db.from("places").select("id,name,address").eq("user_id", uid).order("name"),
      db.from("messages").select("direction,body").eq("user_id", uid).order("created_at", { ascending: false }).limit(12),
      db.from("jobs").select("status").order("created_at", { ascending: false }).limit(40),
    ]);
  const spendWeek = await computeSpend(periodSince("week")).catch(() => null);
  let todos: any = null;
  try {
    todos = await ticktick.listTasks("today");
  } catch {}
  const u: any = user.data || {};
  return {
    facts: facts.data || [],
    goals: goals.data || [],
    playbooks: playbooks.data || [],
    reminders: reminders.data || [],
    integrations: integrations.data || [],
    settings: (u.settings as any) || {},
    timezone: u.timezone || "America/New_York",
    home_address: u.home_address || "",
    commitments: commitments.data || [],
    subagents: subagents.data || [],
    places: places.data || [],
    messages: (messages.data || []).reverse(),
    spendWeek: spendWeek ? spendWeek.total_usd : null,
    deadJobs: (jobs.data || []).filter((j: any) => j.status === "dead").length,
    todos: todos?.ok ? { overdue: todos.overdue || [], dated: todos.dated || [] } : null,
  };
}
