// the proactive engine — lexa reaching out FIRST. driven by the cron heartbeat.
// reminders/leave-now, morning briefs, first-days learning / accountability check-ins,
// and user-defined automations.
//
// reliability model (the durable-queue rework):
// - runTick takes a short lease so overlapping cron fires (GitHub pinger bunching up, the
//   daily Vercel cron landing on the same minute) can't double-run the engine.
// - once-a-day work (brief / check-in / automations) is enqueued on the jobs table with a
//   per-user-per-day dedupe key — exactly-once by construction — then executed by a handler
//   with retry + backoff + dead-letter, so one flaky Linq call no longer costs the whole brief.
// - reminders are claimed atomically on their own row (scheduled → sending) and put back on
//   failure; the row itself is the durable retry state.
import { db, User } from "./db";
import * as mem from "./memory";
import { composeProactive, think } from "./brain";
import { sendBubbles } from "./send";
import * as q from "./queue";
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

    // no per-row claim needed: runTick holds a lease, so only one tick dispatches reminders
    // per window. on any failure below we simply DON'T advance the row — it stays 'scheduled'
    // and due, so the next tick retries the whole thing. (an earlier 'sending' claim could
    // strand a reminder forever if the function died between claim and revert — removed.)
    try {
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
      const res = await sendBubbles(user.id, user.phone, (user as any).linq_chat_id, text);
      if (res.sent === 0) throw new Error("all bubbles failed to send");
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
    } catch (e: any) {
      // row stays 'scheduled' + due → next tick retries. one bad reminder can't abort the loop.
      console.error("[lexa] reminder send failed, staying scheduled for next tick:", e?.message || e);
    }
  }
  return fired;
}

// 1b) follow up on due commitments — "yo did you end up doing X?". one nudge, then mark 'nudged'
// so it never nags again; his reply resolves it (kept/missed) via the resolve_commitment tool.
export async function dispatchDueCommitments(): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data } = await db
    .from("commitments")
    .select("*")
    .eq("status", "open")
    .lte("follow_up_at", nowIso)
    .order("follow_up_at");
  let fired = 0;
  for (const c of data || []) {
    const user = await getUser(c.user_id);
    if (!user) continue;
    try {
      const ctx = `he committed to: "${c.what}"${c.context ? ` (${c.context})` : ""}; he said this at ${c.committed_at}. check in like a friend who remembered — did he actually do it? hold him to it without nagging.`;
      const text = await composeProactive(user, "a thing jonny said he'd do is due for a follow-up — see if he did it", ctx);
      const res = await sendBubbles(user.id, user.phone, (user as any).linq_chat_id, text);
      if (res.sent === 0) throw new Error("all bubbles failed to send");
      // mark 'nudged' (won't re-fire); his reply resolves it kept/missed. row stays open on failure.
      await db.from("commitments").update({ status: "nudged", nudge_count: (c.nudge_count || 0) + 1 }).eq("id", c.id);
      await mem.logBehavior(user.id, "nudged", { ref: c.id, scheduled_at: c.follow_up_at, acted_at: nowIso, meta: { kind: "commitment" } });
      fired++;
    } catch (e: any) {
      console.error("[lexa] commitment follow-up failed, staying open for next tick:", e?.message || e);
    }
  }
  return fired;
}

// gather the brief's context (TickTick + Notion + Calendar + unread email). best-effort per source.
async function buildBriefContext(): Promise<string> {
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
  return ctx;
}

// compose + send + mark. throws on total send failure so the job layer retries with backoff.
async function sendBriefTo(user: User, date: string): Promise<void> {
  const ctx = await buildBriefContext();
  const text = await composeProactive(
    user,
    "it's morning — give jonny his morning brief: what's on today, what actually matters, one nudge to lock in. keep it tight.",
    ctx || "no connected schedule data yet — just check in warmly and ask what's on his plate today."
  );
  const res = await sendBubbles(user.id, user.phone, (user as any).linq_chat_id, text);
  if (res.sent === 0) throw new Error("brief: all bubbles failed to send");
  await db.from("users").update({ settings: { ...(user.settings as any), last_brief: date } }).eq("id", user.id);
}

async function sendCheckinTo(user: User, date: string): Promise<void> {
  const facts = await mem.listFacts(user.id);
  const situation =
    facts.length < 6
      ? "you're still learning jonny (early days). ask ONE genuinely useful question to learn his routine/goals/preferences — not spammy, just curious like a friend getting to know him."
      : "evening check-in — see how his day went and gently nudge on anything he said mattered or is slipping on. short.";
  const text = await composeProactive(user, situation);
  const res = await sendBubbles(user.id, user.phone, (user as any).linq_chat_id, text);
  if (res.sent === 0) throw new Error("checkin: all bubbles failed to send");
  await db.from("users").update({ settings: { ...(user.settings as any), last_checkin: date } }).eq("id", user.id);
}

// 2) morning brief — once/day at the user's brief hour. non-force enqueues (dedupe key =
// exactly one per user per day, even across concurrent ticks); force sends immediately.
export async function runDailyBrief(force = false): Promise<number> {
  let n = 0;
  for (const user of await allUsers()) {
    const tz = user.timezone || "America/New_York";
    const { hour, date } = nowParts(tz);
    if (force) {
      await sendBriefTo(user, date);
      n++;
      continue;
    }
    const briefHour = (user.settings as any)?.brief_hour ?? 8;
    if (hour !== briefHour) continue;
    if ((user.settings as any)?.last_brief === date) continue;
    const job = await q.enqueue(
      "morning_brief",
      { user_id: user.id, date },
      { dedupeKey: `brief-${user.id}-${date}`, userId: user.id }
    );
    if (job) n++;
  }
  return n;
}

// 3) first-days learning + accountability check-in — once/day at the user's check-in hour
export async function proactiveCheckin(force = false): Promise<number> {
  let n = 0;
  for (const user of await allUsers()) {
    const tz = user.timezone || "America/New_York";
    const { hour, date } = nowParts(tz);
    if (force) {
      await sendCheckinTo(user, date);
      n++;
      continue;
    }
    const checkinHour = (user.settings as any)?.checkin_hour ?? 19;
    if (hour !== checkinHour) continue;
    if ((user.settings as any)?.last_checkin === date) continue;
    const job = await q.enqueue(
      "checkin",
      { user_id: user.id, date },
      { dedupeKey: `checkin-${user.id}-${date}`, userId: user.id }
    );
    if (job) n++;
  }
  return n;
}

// 4) user-defined automations (playbooks flagged automation:true) — enqueued once per day
export async function runAutomations(): Promise<number> {
  let n = 0;
  for (const user of await allUsers()) {
    const { hour, date, weekday } = nowParts(user.timezone || "America/New_York");
    const { data: pbs } = await db.from("playbooks").select("*").eq("user_id", user.id).eq("active", true);
    for (const p of pbs || []) {
      const f: any = p.format || {};
      if (!f.automation || f.hour !== hour) continue;
      if (f.weekday != null && f.weekday !== weekday) continue;
      if (f.last_run === date) continue;
      const job = await q.enqueue(
        "automation",
        { user_id: user.id, playbook_id: p.id, date },
        { dedupeKey: `auto-${p.id}-${date}`, userId: user.id }
      );
      if (job) n++;
    }
  }
  return n;
}

// job handlers — the execution side of the queue. every handler is idempotent-guarded
// (re-checks the once-a-day marker + drops stale work) because retries WILL re-enter it.
export const JOB_HANDLERS: Record<string, (job: q.Job) => Promise<void>> = {
  tick_lease: async () => {}, // lease marker rows; normally marked done at acquire time

  send_message: async (job) => {
    const p = job.payload || {};
    const res = await sendBubbles(p.user_id, p.to, p.chat_id ?? undefined, p.text);
    if (res.sent === 0) throw new Error("send_message: all bubbles failed");
  },

  morning_brief: async (job) => {
    const p = job.payload || {};
    const user = await getUser(p.user_id);
    if (!user) return;
    const { date } = nowParts(user.timezone || "America/New_York");
    if (p.date !== date) return; // stale — never deliver yesterday's brief today
    if ((user.settings as any)?.last_brief === date) return; // already sent (e.g. forced)
    await sendBriefTo(user, date);
  },

  checkin: async (job) => {
    const p = job.payload || {};
    const user = await getUser(p.user_id);
    if (!user) return;
    const { date } = nowParts(user.timezone || "America/New_York");
    if (p.date !== date) return;
    if ((user.settings as any)?.last_checkin === date) return;
    await sendCheckinTo(user, date);
  },

  automation: async (job) => {
    const p = job.payload || {};
    const user = await getUser(p.user_id);
    if (!user) return;
    const { date } = nowParts(user.timezone || "America/New_York");
    if (p.date !== date) return; // stale (e.g. a backed-off retry crossed midnight) — don't fire off-day
    const { data: pb } = await db.from("playbooks").select("*").eq("id", p.playbook_id).maybeSingle();
    if (!pb || !pb.active) return;
    const f: any = pb.format || {};
    if (f.last_run === p.date) return;
    const reply = await think(user, `(scheduled automation "${pb.name}") ${pb.instructions}`);
    const res = await sendBubbles(user.id, user.phone, (user as any).linq_chat_id, reply);
    if (res.sent === 0) throw new Error("automation: all bubbles failed");
    await db.from("playbooks").update({ format: { ...f, last_run: p.date } }).eq("id", pb.id);
  },
};

export async function runTick() {
  // one tick per window — an overlapping cron fire returns immediately instead of racing.
  // fail OPEN: if the lease query itself errors (DB blip, free-tier pause), we proceed anyway
  // rather than let a lease failure silently kill reminders/briefs. worst case is a rare
  // double-run, which the per-job dedupe keys already guard against.
  try {
    if (!(await q.acquireTickLease())) return { skipped: "tick lease held — another run owns this window" };
  } catch (e: any) {
    console.error("[lexa] tick lease errored, proceeding without it:", e?.message || e);
  }

  const out: any = {};
  try {
    out.reaped = await q.reapStuck();
  } catch {}
  for (const [name, fn] of [
    ["reminders", dispatchDueReminders],
    ["commitments", dispatchDueCommitments],
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
  // drain: freshly enqueued work + anything whose backoff timer came due
  try {
    out.jobs = await q.runJobs(JOB_HANDLERS, 20);
  } catch (e: any) {
    out.jobs = `err: ${e?.message || e}`;
  }
  try {
    await q.prune();
  } catch {}
  return out;
}
