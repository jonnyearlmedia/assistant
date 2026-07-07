// lexa's memory operations. all editable, all inspectable — this is what fixes Tomo's
// stale/locked memory. every function here is exposed to her as a tool.

import { db } from "./db";

// life-area tags are stored as slugs (matches the dashboard). accept a name or slug, store a slug.
export const areaSlug = (s?: string | null): string | null =>
  s ? String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || null : null;

export async function rememberFact(
  userId: string,
  category: string,
  key: string,
  value: string,
  source = "conversation",
  area?: string | null
) {
  const { data, error } = await db
    .from("facts")
    .upsert(
      { user_id: userId, category, key, value, source, ...(area !== undefined ? { area: areaSlug(area) } : {}), updated_at: new Date().toISOString() },
      { onConflict: "user_id,category,key" }
    )
    .select("id,category,key,value")
    .single();
  if (error) throw new Error(`rememberFact: ${error.message}`);
  return data;
}

export async function forgetFact(userId: string, key: string) {
  const { data, error } = await db
    .from("facts")
    .delete()
    .eq("user_id", userId)
    .eq("key", key)
    .select("id,key");
  if (error) throw new Error(`forgetFact: ${error.message}`);
  return { removed: data?.length ?? 0 };
}

export async function listFacts(userId: string) {
  const { data, error } = await db
    .from("facts")
    .select("category,key,value,pinned,updated_at")
    .eq("user_id", userId)
    .order("category");
  if (error) throw new Error(`listFacts: ${error.message}`);
  return data ?? [];
}

export async function setGoal(userId: string, title: string, detail?: string, cadence?: string, area?: string | null) {
  const { data, error } = await db
    .from("goals")
    .insert({ user_id: userId, title, detail, cadence, area: areaSlug(area) })
    .select("id,title,status")
    .single();
  if (error) throw new Error(`setGoal: ${error.message}`);
  return data;
}

export async function listGoals(userId: string) {
  const { data, error } = await db
    .from("goals")
    .select("id,title,detail,status,cadence")
    .eq("user_id", userId)
    .neq("status", "dropped");
  if (error) throw new Error(`listGoals: ${error.message}`);
  return data ?? [];
}

// playbooks = conversationally-taught workflows / strict formats (e.g. health_mood, routing rules)
export async function savePlaybook(
  userId: string,
  name: string,
  instructions: string,
  opts: { trigger?: string; format?: any; target?: any; area?: string | null } = {}
) {
  const { data, error } = await db
    .from("playbooks")
    .upsert(
      {
        user_id: userId,
        name,
        instructions,
        trigger: opts.trigger,
        format: opts.format,
        target: opts.target,
        ...(opts.area !== undefined ? { area: areaSlug(opts.area) } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,name" }
    )
    .select("id,name,trigger")
    .single();
  if (error) throw new Error(`savePlaybook: ${error.message}`);
  return data;
}

export async function listPlaybooks(userId: string) {
  const { data, error } = await db
    .from("playbooks")
    .select("name,trigger,instructions,format,target,active")
    .eq("user_id", userId)
    .eq("active", true);
  if (error) throw new Error(`listPlaybooks: ${error.message}`);
  return data ?? [];
}

// tz offset (ms, + = ahead of UTC) for a given instant in an IANA timezone. no date lib.
function tzOffsetMs(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: any = Object.fromEntries(dtf.formatToParts(instant).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === "24" ? 0 : p.hour), +p.minute, +p.second);
  return asUtc - instant.getTime();
}

// Interpret a wall-clock ISO string (no offset) as local time in `tz` → a correct UTC instant.
// Fixes the reminder timezone bug: the model emits naive local times ("2026-07-08T05:15"), which
// Postgres was reading as UTC. We resolve the offset (DST-aware) and store a real UTC timestamp.
export function normalizeDueAt(dueAt: string, tz?: string): string {
  const s = String(dueAt || "").trim();
  // already offset-qualified (ends in Z or ±HH:MM / ±HHMM) → it's an absolute instant, trust it.
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    if (isNaN(d.getTime())) throw new Error(`bad due_at: ${dueAt}`);
    return d.toISOString();
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) {
    const d = new Date(s);
    if (isNaN(d.getTime())) throw new Error(`bad due_at: ${dueAt}`);
    return d.toISOString();
  }
  const [, y, mo, d, hh = "0", mi = "0", ss = "0"] = m;
  const zone = tz || "America/New_York";
  const guess = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss); // wall clock read as if UTC
  // subtract the offset to land on the true instant; re-check at that instant for DST edges.
  const off1 = tzOffsetMs(new Date(guess), zone);
  const off2 = tzOffsetMs(new Date(guess - off1), zone);
  return new Date(guess - off2).toISOString();
}

export async function scheduleReminder(
  userId: string,
  r: { title: string; body?: string; due_at: string; lead_time_min?: number; location?: string; recurrence?: string; area?: string | null },
  tz?: string
) {
  const { area, due_at, ...rest } = r;
  const { data, error } = await db
    .from("reminders")
    .insert({ user_id: userId, ...rest, due_at: normalizeDueAt(due_at, tz), area: areaSlug(area) })
    .select("id,title,due_at,lead_time_min,location")
    .single();
  if (error) throw new Error(`scheduleReminder: ${error.message}`);
  return data;
}

export async function listReminders(userId: string) {
  const { data, error } = await db
    .from("reminders")
    .select("id,title,due_at,lead_time_min,location,status")
    .eq("user_id", userId)
    .eq("status", "scheduled")
    .order("due_at");
  if (error) throw new Error(`listReminders: ${error.message}`);
  return data ?? [];
}

export async function cancelReminder(userId: string, id: string) {
  const { error } = await db
    .from("reminders")
    .update({ status: "cancelled" })
    .eq("user_id", userId)
    .eq("id", id);
  if (error) throw new Error(`cancelReminder: ${error.message}`);
  return { cancelled: id };
}

// commitment follow-through: jonny says "i'll do X later" → lexa stores it and follows up.
export async function trackCommitment(
  userId: string,
  c: { what: string; follow_up_at: string; context?: string }
) {
  const { data, error } = await db
    .from("commitments")
    .insert({ user_id: userId, what: c.what, follow_up_at: c.follow_up_at, context: c.context })
    .select("id,what,follow_up_at,status")
    .single();
  if (error) throw new Error(`trackCommitment: ${error.message}`);
  return data;
}

// open = not yet resolved (includes ones she's already nudged, so she can still resolve them)
export async function listOpenCommitments(userId: string) {
  const { data, error } = await db
    .from("commitments")
    .select("id,what,context,follow_up_at,status,nudge_count")
    .eq("user_id", userId)
    .in("status", ["open", "nudged"])
    .order("follow_up_at");
  if (error) throw new Error(`listOpenCommitments: ${error.message}`);
  return data ?? [];
}

// resolve a commitment when jonny tells her he did / didn't do it (feeds his accountability record)
export async function resolveCommitment(
  userId: string,
  id: string,
  status: "kept" | "missed" | "cancelled",
  outcome?: string
) {
  const { data, error } = await db
    .from("commitments")
    .update({ status, outcome })
    .eq("user_id", userId)
    .eq("id", id)
    .select("id,what,status,outcome");
  if (error) throw new Error(`resolveCommitment: ${error.message}`);
  return { resolved: data?.length ?? 0, commitment: data?.[0] ?? null };
}

// named places (home, gym, work…) for drive-time + "leave now" reminders
export async function savePlace(userId: string, name: string, address: string) {
  const { data, error } = await db
    .from("places")
    .upsert({ user_id: userId, name, address }, { onConflict: "user_id,name" })
    .select("id,name,address")
    .single();
  if (error) throw new Error(`savePlace: ${error.message}`);
  if (name.toLowerCase() === "home") await db.from("users").update({ home_address: address }).eq("id", userId);
  return data;
}

export async function listPlaces(userId: string) {
  const { data } = await db.from("places").select("name,address").eq("user_id", userId);
  return data ?? [];
}

// jonny tells lexa where he is (text) → sets current location for drive-time math
export async function setCurrentLocation(userId: string, address: string) {
  await db.from("users").update({ last_address: address, last_location_at: new Date().toISOString() }).eq("id", userId);
  return { ok: true, address };
}

// procrastination modeling: record what happened vs. what was scheduled
export async function logBehavior(
  userId: string,
  event_type: string,
  opts: { ref?: string; scheduled_at?: string; acted_at?: string; delay_min?: number; meta?: any } = {}
) {
  await db.from("behavior_log").insert({ user_id: userId, event_type, ...opts });
}

// recent conversation for context. beforeIso lets us load history strictly BEFORE the current
// (debounced) batch so those messages aren't duplicated as both history and the current turn.
export async function recentMessages(userId: string, limit = 20, beforeIso?: string) {
  let q = db.from("messages").select("direction,body,created_at").eq("user_id", userId);
  if (beforeIso) q = q.lt("created_at", beforeIso);
  const { data } = await q.order("created_at", { ascending: false }).limit(limit);
  return (data ?? []).reverse();
}

// user-defined subagents: jonny spins up his own specialists by text. stored as name + brief +
// allowed tool names; delegate routes to them by name just like the built-in domains.
export async function createUserSubagent(userId: string, name: string, brief: string, tools: string[]) {
  const { data, error } = await db
    .from("subagents")
    .upsert(
      { user_id: userId, name, brief, tools, active: true, updated_at: new Date().toISOString() },
      { onConflict: "user_id,name" }
    )
    .select("id,name,brief,tools")
    .single();
  if (error) throw new Error(`createUserSubagent: ${error.message}`);
  return data;
}

export async function listUserSubagents(userId: string) {
  const { data, error } = await db
    .from("subagents")
    .select("name,brief,tools,active")
    .eq("user_id", userId)
    .eq("active", true)
    .order("name");
  if (error) throw new Error(`listUserSubagents: ${error.message}`);
  return data ?? [];
}

export async function getUserSubagent(userId: string, name: string) {
  const { data } = await db
    .from("subagents")
    .select("name,brief,tools")
    .eq("user_id", userId)
    .eq("name", name)
    .eq("active", true)
    .maybeSingle();
  return data as { name: string; brief: string | null; tools: string[] } | null;
}

export async function deleteUserSubagent(userId: string, name: string) {
  const { data, error } = await db
    .from("subagents")
    .delete()
    .eq("user_id", userId)
    .eq("name", name)
    .select("name");
  if (error) throw new Error(`deleteUserSubagent: ${error.message}`);
  return { removed: data?.length ?? 0 };
}

// memory_query: search jonny's FULL history (not just the recent ~20-msg window) + his facts,
// for when he references something older than what's already in context. substring match — simple,
// but enough to surface "what did i say about X" / "that thing from last week".
export async function searchMemory(userId: string, query: string, limit = 8) {
  const q = (query || "").trim();
  if (!q) return { messages: [], facts: [] };
  const like = `%${q}%`;
  const [msgs, fcts] = await Promise.all([
    db
      .from("messages")
      .select("direction,body,created_at")
      .eq("user_id", userId)
      .ilike("body", like)
      .order("created_at", { ascending: false })
      .limit(limit),
    db
      .from("facts")
      .select("category,key,value,updated_at")
      .eq("user_id", userId)
      .or(`key.ilike.${like},value.ilike.${like}`)
      .limit(limit),
  ]);
  return { messages: (msgs.data ?? []).reverse(), facts: fcts.data ?? [] };
}

export async function logMessage(
  userId: string | null,
  direction: "inbound" | "outbound",
  body: string,
  extra: { channel?: string; media?: any; linq_message_id?: string; status?: string } = {}
): Promise<{ id: string; created_at: string } | null> {
  const { data } = await db
    .from("messages")
    .insert({ user_id: userId, direction, body, ...extra })
    .select("id,created_at")
    .single();
  return (data as any) ?? null;
}

// --- debounce / message coalescing (so lexa waits until jonny's done spamming) ---

// is there an inbound message newer than mine? if so, that later invocation will handle the batch.
export async function hasNewerInbound(userId: string, afterIso: string): Promise<boolean> {
  const { data } = await db
    .from("messages")
    .select("id")
    .eq("user_id", userId)
    .eq("direction", "inbound")
    .gt("created_at", afterIso)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

// all unhandled inbound messages (the batch), oldest first
export async function pendingInbound(userId: string) {
  const { data } = await db
    .from("messages")
    .select("id,body,media,created_at")
    .eq("user_id", userId)
    .eq("direction", "inbound")
    .eq("status", "received")
    .order("created_at", { ascending: true });
  return data ?? [];
}

// claim the batch so it isn't processed twice
export async function markHandled(ids: string[]) {
  if (!ids.length) return;
  await db.from("messages").update({ status: "handled" }).in("id", ids);
}
