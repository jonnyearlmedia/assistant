// the heartbeat. Vercel Cron (or an external pinger) hits this; it runs the proactive engine:
// due reminders + leave-now, morning briefs, and the learning/accountability check-in.
import { NextRequest, NextResponse } from "next/server";
import { runTick, runDailyBrief, proactiveCheckin, runWeeklyPlanning, runMoodCheckins, JOB_HANDLERS } from "@/lib/proactive";
import { runJobs } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true; // Vercel Cron sends this automatically
  if (req.nextUrl.searchParams.get("key") === secret) return true; // external pinger / manual
  return false;
}

async function handle(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const force = req.nextUrl.searchParams.get("force");
  if (force === "brief") return NextResponse.json({ ok: true, forced: "brief", sent: await runDailyBrief(true) });
  if (force === "checkin") return NextResponse.json({ ok: true, forced: "checkin", sent: await proactiveCheckin(true) });
  if (force === "planning") return NextResponse.json({ ok: true, forced: "planning", sent: await runWeeklyPlanning(true) });
  if (force === "mood") return NextResponse.json({ ok: true, forced: "mood", sent: await runMoodCheckins(true) });
  // drain the job queue on demand (bypasses the tick lease) — for ops/verification
  if (force === "jobs") return NextResponse.json({ ok: true, forced: "jobs", result: await runJobs(JOB_HANDLERS, 50) });
  const result = await runTick();
  return NextResponse.json({ ok: true, at: new Date().toISOString(), result });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
