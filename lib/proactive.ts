// the proactive engine — lexa reaching out FIRST. driven by the cron heartbeat.
// reminders/leave-now, morning briefs, and first-days learning / accountability check-ins.
import { db, User } from "./db";
import * as mem from "./memory";
import { composeProactive, think } from "./brain";
import { sendBubbles } from "./send";
import * as maps from "./integrations/maps";
import * as notion from "./integrations/notion";
import * as google from "./integrations/google";
import * as ticktick from "./integrations/ticktick";

async function getUser(id: string): Promise<User | null> {
  const { data } = await db.from("users").select("*").eq("id", id).maybeSingle();
  return (data as any) ?? null;
}

async function allUsers(): Promise<User[]> {
  const { data } = await db.from("users").select("*");
  return (data as any) ?? [];
}

// local wall-clock in the user's timezone (no external date lib)
function nowParts(tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p: any = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0=sun..6=sat for that local date
  return { date, hour: parseInt(p.hour), minute: parseInt(p.minute), weekday };
}

// 1) fire reminders that are due (accounting for lead time). adds live drive time for located ones.
export async function dispatchDueReminders(): Promise<number> {
  const now = Date.now();
  const ahead = new Date(now + 60 * 60_000).toISOString();
  const { data } = await db
    .from("reminders")
    .select("*")
    .eq("status", "scheduled")
    .lte("due_at", ahead)
    .order("due_at");
  let fired = 0;
  for (const r of data || []) {
    const dueMs = new Date(r.due_at).getTime();
    if (now < dueMs - (r.lead_time_min || 0) * 60_000) continue; // not time yet

    const user = await getUser(r.user_id);
    if (!user) continue;

    let ctx = `reminder: "${r.title}"${r.body ? `; note: ${r.body}` : ""}; happens at ${r.due_at}`;
    if (r.location && maps.mapsConnected()) {
      const origin = (user as any).last_address || (user as any).home_address;
      if (origin) {
        const dt = await maps.driveTime(origin, r.location);
        if (dt.ok) ctx += `; live drive ${origin} → ${r.location}: ${dt.minutes} min (${dt.distance_km} km)`;
      }
    }
    const situation = r.lead_time_min
      ? "it's time for jonny to get ready / leave for something"
      : "a reminder just came due";
    const text = await composeProactive(user, situation, ctx);
    await sendBubbles(user.id, user.phone, (user as any).linq_chat_id, text);
    await mem.logBehavior(user.id, "nudged", { ref: r.id, scheduled_at: r.due_at, acted_at: new Date(now).toISOString() });

    const rec = (r.recurrence || "").toLowerCase();
    if (/daily|every day/.test(rec)) {
      await db.from("reminders").update({ due_at: new Date(dueMs + 86400_000).toISOString() }).eq("id", r.id);
    } else if (/week/.test(rec)) {
      await db.from("reminders").update({ due_at: new Date(dueMs + 7 * 86400_000).toISOString() }).eq("id", r.id);
    } else {
      await db.from("reminders").update({ status: "sent" }).eq("id", r.id);
    }
    fired++;
  }
  return fired;
}

// 2) morning brief — once/day at the user's brief hour
export async function runDailyBrief(force = false): Promise<number> {
  let sent = 0;
  for (const user of await allUsers()) {
    const tz = user.timezone || "America/New_York";
    const { hour, date } = nowParts(tz);
    const briefHour = (user.settings as any)?.brief_hour ?? 8;
    if (!force && hour !== briefHour) continue;
    if (!force && (user.settings as any)?.last_brief === date) continue;

    let ctx = "";
    try {
      const tt: any = await ticktick.listTasks("today");
      if (tt.ok) {
        if (tt.dated?.length)
          ctx +=
            "TODAY (TickTick — for time blocks, 'from X' is when it STARTS, 'until' is when it ends):\n" +
            tt.dated
              .map((x: any) =>
                x.start
                  ? `- ${x.title} from ${x.start} until ${x.due} (${x.project})`
                  : `- ${x.title}${x.isAllDay ? " (all day)" : ` @ ${x.due}`} (${x.project})`
              )
              .join("\n") + "\n";
        if (tt.overdue?.length)
          ctx += `\nOVERDUE (${tt.counts.overdue}):\n` + tt.overdue.slice(0, 6).map((x: any) => `- ${x.title} (was due ${x.due})`).join("\n") + "\n";
        if (tt.counts?.undated)
          ctx += `\nUNDATED backlog: ${tt.counts.undated} tasks across ${Object.keys(tt.undated_by_project || {}).join(", ")}\n`;
      }
    } catch {}
    try {
      const mp = await notion.listMasterPlanner(8);
      if (mp.ok && mp.tasks?.length)
        ctx +=
          "MASTER PLANNER:\n" +
          mp.tasks.map((t: any) => `- ${t.task}${t.due ? ` (due ${t.due})` : ""} [${t.status || "?"}]`).join("\n") +
          "\n";
    } catch {}
    try {
      const cal = await google.calendarUpcoming(6);
      if (cal.ok && cal.events?.length)
        ctx += "\nCALENDAR (upcoming):\n" + cal.events.map((e: any) => `- ${e.title} @ ${e.start}`).join("\n") + "\n";
    } catch {}
    try {
      const gm = await google.gmailSearch("is:unread newer_than:2d", 6);
      if (gm.ok && gm.results?.length)
        ctx +=
          "\nUNREAD EMAIL (across inboxes — flag anything that actually needs him):\n" +
          gm.results.map((r: any) => `- [${r.inbox}] "${r.subject}" — ${r.from}`).join("\n") +
          "\n";
    } catch {}

    const text = await composeProactive(
      user,
      "it's morning — give jonny his morning brief: what's on today, what actually matters, one nudge to lock in. keep it tight.",
      ctx || "no connected schedule data yet — just check in warmly and ask what's on his plate today."
    );
    await sendBubbles(user.id, user.phone, (user as any).linq_chat_id, text);
    await db.from("users").update({ settings: { ...(user.settings as any), last_brief: date } }).eq("id", user.id);
    sent++;
  }
  return sent;
}

// 3) first-days learning + accountability check-in — once/day at the user's check-in hour
export async function proactiveCheckin(force = false): Promise<number> {
  let sent = 0;
  for (const user of await allUsers()) {
    const tz = user.timezone || "America/New_York";
    const { hour, date } = nowParts(tz);
    const checkinHour = (user.settings as any)?.checkin_hour ?? 19;
    if (!force && hour !== checkinHour) continue;
    if (!force && (user.settings as any)?.last_checkin === date) continue;

    const facts = await mem.listFacts(user.id);
    const situation =
      facts.length < 6
        ? "you're still learning jonny (early days). ask ONE genuinely useful question to learn his routine/goals/preferences — not spammy, just curious like a friend getting to know him."
        : "evening check-in — see how his day went and gently nudge on anything he said mattered or is slipping on. short.";
    const text = await composeProactive(user, situation);
    await sendBubbles(user.id, user.phone, (user as any).linq_chat_id, text);
    await db.from("users").update({ settings: { ...(user.settings as any), last_checkin: date } }).eq("id", user.id);
    sent++;
  }
  return sent;
}

// 4) user-defined automations (playbooks flagged automation:true) — run via full tool loop
export async function runAutomations(): Promise<number> {
  let ran = 0;
  for (const user of await allUsers()) {
    const { hour, date, weekday } = nowParts(user.timezone || "America/New_York");
    const { data: pbs } = await db.from("playbooks").select("*").eq("user_id", user.id).eq("active", true);
    for (const p of pbs || []) {
      const f: any = p.format || {};
      if (!f.automation || f.hour !== hour) continue;
      if (f.weekday != null && f.weekday !== weekday) continue;
      if (f.last_run === date) continue;
      const reply = await think(user, `(scheduled automation "${p.name}") ${p.instructions}`);
      await sendBubbles(user.id, user.phone, (user as any).linq_chat_id, reply);
      await db.from("playbooks").update({ format: { ...f, last_run: date } }).eq("id", p.id);
      ran++;
    }
  }
  return ran;
}

export async function runTick() {
  const out: any = {};
  for (const [name, fn] of [
    ["reminders", dispatchDueReminders],
    ["brief", runDailyBrief],
    ["checkin", proactiveCheckin],
    ["automations", runAutomations],
  ] as const) {
    try {
      out[name] = await fn();
    } catch (e: any) {
      out[name] = `err: ${e?.message || e}`;
    }
  }
  return out;
}
