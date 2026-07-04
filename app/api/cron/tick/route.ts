// the heartbeat. Vercel Cron hits this on a schedule; it drains due reminders, sends morning
// briefs, and runs the proactive-learning tick. full logic lands in the proactive-engine task.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  // guard: only Vercel Cron (or someone with the secret) can trigger this
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date().toISOString();

  // reminders that are due (accounting for lead time) and not yet sent
  const { data: due, error } = await db
    .from("reminders")
    .select("id,user_id,title,body,due_at,lead_time_min,location")
    .eq("status", "scheduled")
    .lte("due_at", now);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // TODO(proactive-engine): drive-time math, send via Linq w/ retry, morning briefs, learning tick.
  return NextResponse.json({ ok: true, checked_at: now, due_count: due?.length ?? 0 });
}
