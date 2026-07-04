// dashboard mutations (delete/edit memory, settings). Owner-only via Vercel Auth protection.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ownerUserId } from "@/lib/integrations/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const uid = await ownerUserId();
  if (!uid) return NextResponse.json({ error: "no user" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const { action } = body;

  try {
    if (action === "delete") {
      const { kind, id } = body;
      if (kind === "fact") await db.from("facts").delete().eq("user_id", uid).eq("id", id);
      else if (kind === "goal") await db.from("goals").update({ status: "dropped" }).eq("user_id", uid).eq("id", id);
      else if (kind === "playbook") await db.from("playbooks").delete().eq("user_id", uid).eq("id", id);
      else if (kind === "reminder") await db.from("reminders").update({ status: "cancelled" }).eq("user_id", uid).eq("id", id);
      else return NextResponse.json({ error: "bad kind" }, { status: 400 });
      return NextResponse.json({ ok: true });
    }

    if (action === "add_fact") {
      const { category, key, value } = body;
      if (!key || !value) return NextResponse.json({ error: "key+value required" }, { status: 400 });
      await db.from("facts").upsert(
        { user_id: uid, category: category || "general", key, value, source: "dashboard", updated_at: new Date().toISOString() },
        { onConflict: "user_id,category,key" }
      );
      return NextResponse.json({ ok: true });
    }

    if (action === "set_settings") {
      const { data: user } = await db.from("users").select("settings").eq("id", uid).single();
      const settings = { ...((user?.settings as any) || {}) };
      if (body.brief_hour !== undefined && body.brief_hour !== "") settings.brief_hour = Math.max(0, Math.min(23, parseInt(body.brief_hour) || 8));
      if (body.checkin_hour !== undefined && body.checkin_hour !== "") settings.checkin_hour = Math.max(0, Math.min(23, parseInt(body.checkin_hour) || 19));
      const patch: any = { settings };
      if (typeof body.timezone === "string" && body.timezone) patch.timezone = body.timezone;
      if (typeof body.home_address === "string") patch.home_address = body.home_address || null;
      await db.from("users").update(patch).eq("id", uid);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
