// dashboard mutations — the write side of lexa's control panel. Owner-only via Vercel Auth.
// every editable thing lexa knows/does is reachable here so the dashboard can be the real
// management surface instead of a chat thread.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ownerUserId } from "@/lib/integrations/tokens";
import { TOOLS } from "@/lib/tools";
import * as ticktick from "@/lib/integrations/ticktick";
import { organizeDump } from "@/lib/organize";
import { loadDashboard } from "@/lib/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// live data for the client UI to refetch after edits (no full page reload).
export async function GET() {
  const data = await loadDashboard();
  return NextResponse.json(data ?? {});
}

const VALID_TOOLS = new Set((TOOLS as any[]).map((t) => t?.name).filter(Boolean));
VALID_TOOLS.add("web_search");

// plain-english abilities → the real tools behind them (so the builder never shows tool names)
const CAPS: Record<string, string[]> = {
  email: ["gmail_search", "gmail_send", "gmail_draft"],
  calendar: ["gcal_upcoming", "gcal_create", "gcal_update", "gcal_delete", "drive_time"],
  notion: ["notion_search", "notion_read", "notion_query_db", "notion_create_page", "notion_append", "notion_log", "list_master_planner"],
  todos: ["ticktick_list", "ticktick_create_task", "ticktick_projects", "ticktick_complete", "ticktick_update", "ticktick_delete"],
  web: ["web_search"],
  memory: ["recall", "list_facts", "remember_fact"],
  files: ["drive_search", "drive_read"],
};

const asArray = (v: any): string[] => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const now = () => new Date().toISOString();

export async function POST(req: NextRequest) {
  const uid = await ownerUserId();
  if (!uid) return NextResponse.json({ error: "no user" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const { action } = body;

  try {
    switch (action) {
      // ---- generic delete / soft-delete ----
      case "delete": {
        const { kind, id } = body;
        const ops: Record<string, () => any> = {
          fact: () => db.from("facts").delete().eq("user_id", uid).eq("id", id),
          goal: () => db.from("goals").update({ status: "dropped" }).eq("user_id", uid).eq("id", id),
          playbook: () => db.from("playbooks").delete().eq("user_id", uid).eq("id", id),
          reminder: () => db.from("reminders").update({ status: "cancelled" }).eq("user_id", uid).eq("id", id),
          commitment: () => db.from("commitments").delete().eq("user_id", uid).eq("id", id),
          place: () => db.from("places").delete().eq("user_id", uid).eq("id", id),
          subagent: () => db.from("subagents").delete().eq("user_id", uid).eq("id", id),
        };
        if (!ops[kind]) return NextResponse.json({ error: "bad kind" }, { status: 400 });
        await ops[kind]();
        return NextResponse.json({ ok: true });
      }

      // ---- facts (memories) ----
      case "add_fact": {
        const { category, value } = body;
        if (!value) return NextResponse.json({ error: "type what she should remember" }, { status: 400 });
        const key = String(body.key || value).trim().slice(0, 60); // auto key from the value if none given
        await db.from("facts").upsert(
          { user_id: uid, category: (category || "general").trim().toLowerCase() || "general", key, value, source: "dashboard", updated_at: now() },
          { onConflict: "user_id,category,key" }
        );
        return NextResponse.json({ ok: true });
      }
      case "edit_fact": {
        if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
        await db.from("facts").update({ value: body.value ?? "", updated_at: now() }).eq("user_id", uid).eq("id", body.id);
        return NextResponse.json({ ok: true });
      }

      // ---- goals ----
      case "add_goal": {
        if (!body.title) return NextResponse.json({ error: "title required" }, { status: 400 });
        await db.from("goals").insert({ user_id: uid, title: body.title, detail: body.detail || null });
        return NextResponse.json({ ok: true });
      }

      // ---- playbooks (rules + workflows) ----
      case "save_playbook": {
        if (!body.name || !body.instructions) return NextResponse.json({ error: "name+instructions required" }, { status: 400 });
        await db.from("playbooks").upsert(
          { user_id: uid, name: body.name.trim(), trigger: body.trigger || null, instructions: body.instructions, active: true, updated_at: now() },
          { onConflict: "user_id,name" }
        );
        return NextResponse.json({ ok: true });
      }
      case "toggle_playbook": {
        await db.from("playbooks").update({ active: !!body.active, updated_at: now() }).eq("user_id", uid).eq("id", body.id);
        return NextResponse.json({ ok: true });
      }

      // ---- reminders ----
      case "add_reminder": {
        if (!body.title || !body.due_at) return NextResponse.json({ error: "title+due_at required" }, { status: 400 });
        await db.from("reminders").insert({
          user_id: uid,
          title: body.title,
          due_at: new Date(body.due_at).toISOString(),
          location: body.location || null,
          recurrence: body.recurrence || null,
          lead_time_min: body.lead_time_min ? parseInt(body.lead_time_min) : 0,
        });
        return NextResponse.json({ ok: true });
      }
      case "edit_reminder": {
        if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
        const patch: any = {};
        if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
        if (body.due_at) {
          const t = new Date(body.due_at);
          if (isNaN(t.getTime())) return NextResponse.json({ error: "bad time" }, { status: 400 });
          patch.due_at = t.toISOString();
          patch.status = "scheduled"; // re-editing an overdue/cancelled one re-arms it
        }
        if (body.location !== undefined) patch.location = body.location || null;
        if (!Object.keys(patch).length) return NextResponse.json({ error: "nothing to change" }, { status: 400 });
        await db.from("reminders").update(patch).eq("user_id", uid).eq("id", body.id);
        return NextResponse.json({ ok: true });
      }

      // ---- commitments ----
      case "resolve_commitment": {
        const status = ["kept", "missed", "cancelled"].includes(body.status) ? body.status : "cancelled";
        await db.from("commitments").update({ status, outcome: body.outcome || null }).eq("user_id", uid).eq("id", body.id);
        return NextResponse.json({ ok: true });
      }

      // ---- places ----
      case "add_place": {
        if (!body.name || !body.address) return NextResponse.json({ error: "name+address required" }, { status: 400 });
        await db.from("places").upsert({ user_id: uid, name: body.name.trim().toLowerCase(), address: body.address }, { onConflict: "user_id,name" });
        if (body.name.trim().toLowerCase() === "home") await db.from("users").update({ home_address: body.address }).eq("id", uid);
        return NextResponse.json({ ok: true });
      }

      // ---- subagents (visual builder) ----
      case "save_subagent": {
        const name = String(body.name || "").trim().toLowerCase().replace(/\s+/g, "_");
        if (!name) return NextResponse.json({ error: "give your helper a name" }, { status: 400 });
        // abilities (plain english) expand to real tools; raw tool names still accepted for safety
        let tools: string[] = [];
        for (const c of asArray(body.caps)) if (CAPS[c]) tools.push(...CAPS[c]);
        tools.push(...asArray(body.tools).filter((t) => VALID_TOOLS.has(t)));
        tools = [...new Set(tools)];
        if (!tools.length) return NextResponse.json({ error: "pick at least one ability for your helper" }, { status: 400 });
        await db.from("subagents").upsert(
          { user_id: uid, name, brief: body.brief || "", tools, active: true, updated_at: now() },
          { onConflict: "user_id,name" }
        );
        return NextResponse.json({ ok: true });
      }

      // ---- to-dos (ticktick) ----
      case "ticktick_complete": {
        if (!body.task_id || !body.project_id) return NextResponse.json({ error: "ids required" }, { status: 400 });
        const r = await ticktick.completeTask(body.project_id, body.task_id);
        return NextResponse.json({ ok: r.ok, detail: r.detail });
      }
      case "ticktick_add": {
        if (!body.title) return NextResponse.json({ error: "title required" }, { status: 400 });
        const r = await ticktick.createTask({ title: body.title, due: body.due || undefined, project: body.project || undefined });
        return NextResponse.json({ ok: r.ok, detail: r.detail });
      }

      // ---- "just dump it": free text → auto-sorted into the right places ----
      case "organize":
        return NextResponse.json(await organizeDump(uid, String(body.text || "")));

      // ---- custom instructions (jonny's own standing rules, folded into her brain) ----
      case "set_instructions": {
        const { data: user } = await db.from("users").select("settings").eq("id", uid).single();
        const settings = { ...((user?.settings as any) || {}), custom_instructions: String(body.instructions || "").slice(0, 4000) };
        await db.from("users").update({ settings }).eq("id", uid);
        return NextResponse.json({ ok: true });
      }
      // ---- rules as an editable list: add / edit / remove one line at a time ----
      case "set_instruction_list": {
        const items = asArray(body.items).map((s) => String(s).replace(/^[-•\s]+/, "").trim()).filter(Boolean).slice(0, 40);
        const merged = items.map((t) => `- ${t}`).join("\n").slice(0, 4000);
        const { data: user } = await db.from("users").select("settings").eq("id", uid).single();
        const settings = { ...((user?.settings as any) || {}), custom_instructions: merged };
        await db.from("users").update({ settings }).eq("id", uid);
        return NextResponse.json({ ok: true });
      }

      // ---- settings ----
      case "set_settings": {
        const { data: user } = await db.from("users").select("settings").eq("id", uid).single();
        const settings = { ...((user?.settings as any) || {}) };
        const hour = (v: any, d: number) => Math.max(0, Math.min(23, parseInt(v) || d));
        if (body.brief_hour !== undefined && body.brief_hour !== "") settings.brief_hour = hour(body.brief_hour, 8);
        if (body.checkin_hour !== undefined && body.checkin_hour !== "") settings.checkin_hour = hour(body.checkin_hour, 19);
        if (body.planning_hour !== undefined && body.planning_hour !== "") settings.planning_hour = hour(body.planning_hour, 18);
        if (body.planning_weekday !== undefined && body.planning_weekday !== "")
          settings.planning_weekday = Math.max(0, Math.min(6, parseInt(body.planning_weekday) || 0));
        settings.triage_disabled = body.triage_disabled === "on" || body.triage_disabled === true;
        const patch: any = { settings };
        if (typeof body.timezone === "string" && body.timezone) patch.timezone = body.timezone;
        if (typeof body.home_address === "string") patch.home_address = body.home_address || null;
        await db.from("users").update(patch).eq("id", uid);
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
