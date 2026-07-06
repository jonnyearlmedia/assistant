// TickTick (jonny's source-of-truth calendar). OAuth2 + task ops with verified read-back.
import { ownerUserId, getIntegration, saveIntegration } from "./tokens";
import { auditWrite } from "../audit";

const AUTH = "https://ticktick.com/oauth/authorize";
const TOKEN_URL = "https://ticktick.com/oauth/token";
const API = "https://api.ticktick.com/open/v1";
const SCOPE = "tasks:write tasks:read";

function redirectUri() {
  return `${process.env.APP_BASE_URL}/api/connect/ticktick/callback`;
}

export function authUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.TICKTICK_CLIENT_ID || "",
    scope: SCOPE,
    response_type: "code",
    redirect_uri: redirectUri(),
    state,
  });
  return `${AUTH}?${p.toString()}`;
}

export async function exchangeCode(code: string): Promise<void> {
  const body = new URLSearchParams({
    client_id: process.env.TICKTICK_CLIENT_ID || "",
    client_secret: process.env.TICKTICK_CLIENT_SECRET || "",
    code,
    grant_type: "authorization_code",
    scope: SCOPE,
    redirect_uri: redirectUri(),
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const d = await res.json();
  if (!res.ok || !d.access_token) throw new Error(`ticktick token exchange failed: ${JSON.stringify(d).slice(0, 200)}`);
  const uid = await ownerUserId();
  if (!uid) throw new Error("no owner user");
  await saveIntegration(uid, "ticktick", {
    access_token: d.access_token,
    refresh_token: d.refresh_token ?? null,
    scope: d.scope ?? SCOPE,
    expires_at: d.expires_in ? new Date(Date.now() + d.expires_in * 1000).toISOString() : null,
  });
}

async function token(): Promise<string | null> {
  const uid = await ownerUserId();
  if (!uid) return null;
  const i = await getIntegration(uid, "ticktick");
  return i?.access_token ?? null;
}

export async function ticktickConnected(): Promise<boolean> {
  return !!(await token());
}

export async function listProjects(): Promise<{ ok: boolean; projects?: any[]; detail?: string }> {
  const t = await token();
  if (!t) return { ok: false, detail: "TickTick not connected" };
  const res = await fetch(`${API}/project`, { headers: { Authorization: `Bearer ${t}` } });
  const d = await res.json();
  if (!res.ok) return { ok: false, detail: JSON.stringify(d).slice(0, 150) };
  return { ok: true, projects: d.map((p: any) => ({ id: p.id, name: p.name })) };
}

// READ jonny's existing tasks/schedule — aggregates across all projects. scope filters by due date.
export async function listTasks(
  scope: "today" | "week" | "all" = "all"
): Promise<{ ok: boolean; detail: string; [k: string]: any }> {
  const t = await token();
  if (!t) return { ok: false, detail: "TickTick not connected" };
  const pr = await fetch(`${API}/project`, { headers: { Authorization: `Bearer ${t}` } });
  if (!pr.ok) return { ok: false, detail: `ticktick projects read failed: ${pr.status}` };
  const projects = await pr.json();

  const all: any[] = [];
  for (const p of projects || []) {
    try {
      const d = await fetch(`${API}/project/${p.id}/data`, { headers: { Authorization: `Bearer ${t}` } });
      if (!d.ok) continue;
      const data = await d.json();
      for (const task of data.tasks || []) {
        all.push({
          id: task.id,
          projectId: p.id,
          title: task.title,
          // time-block tasks have BOTH: start is when it begins, due is when it ends.
          // dropping start made lexa report blocks by their end time ("workout at 6:45"
          // for a 5:15–6:45 block). keep both so she reads the schedule like a human.
          start: task.startDate && task.startDate !== task.dueDate ? task.startDate : null,
          due: task.dueDate || task.startDate || null,
          isAllDay: task.isAllDay ?? false,
          priority: task.priority ?? 0,
          project: p.name,
          status: task.status === 2 ? "done" : "active",
        });
      }
    } catch {
      /* skip a project that won't read */
    }
  }

  const active = all.filter((x) => x.status !== "done");
  const now = new Date();
  const dated = active.filter((x) => x.due);
  const undated = active.filter((x) => !x.due);
  const overdue = dated.filter((x) => new Date(x.due) < now).sort((a, b) => a.due.localeCompare(b.due));

  let inWindow = dated;
  if (scope === "today" || scope === "week") {
    const end = new Date();
    end.setDate(end.getDate() + (scope === "today" ? 1 : 7));
    inWindow = dated.filter((x) => new Date(x.due) <= end);
  }
  inWindow.sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));

  // group undated by project so she can say "you've got X in Work, Y in School"
  const byProject: Record<string, number> = {};
  for (const t of undated) byProject[t.project] = (byProject[t.project] || 0) + 1;

  return {
    ok: true,
    scope,
    dated: inWindow,
    overdue: overdue.slice(0, 15),
    undated_sample: undated.slice(0, 20),
    undated_by_project: byProject,
    counts: { dated_in_window: inWindow.length, overdue: overdue.length, undated: undated.length, active_total: active.length },
    detail: `${inWindow.length} dated in window · ${overdue.length} overdue · ${undated.length} undated · ${active.length} active total`,
  };
}

async function projectIdByName(t: string, name?: string): Promise<string | undefined> {
  if (!name) return undefined;
  const res = await fetch(`${API}/project`, { headers: { Authorization: `Bearer ${t}` } });
  if (!res.ok) return undefined;
  const projects = await res.json();
  const hit = (projects || []).find((p: any) => p.name?.toLowerCase() === name.toLowerCase()) ||
    (projects || []).find((p: any) => p.name?.toLowerCase().includes(name.toLowerCase()));
  return hit?.id;
}

export async function completeTask(projectId: string, taskId: string): Promise<{ ok: boolean; detail: string }> {
  const t = await token();
  if (!t) return { ok: false, detail: "TickTick not connected" };
  const res = await fetch(`${API}/project/${projectId}/task/${taskId}/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}` },
  });
  const detail = res.ok ? `completed task ${taskId}` : `complete failed: ${res.status} ${(await res.text()).slice(0, 100)}`;
  // cheap read-back: a completed task reads back with status 2 (or drops out of the project)
  let verified = false;
  if (res.ok) {
    const check = await fetch(`${API}/project/${projectId}/task/${taskId}`, { headers: { Authorization: `Bearer ${t}` } });
    const cd = check.ok ? await check.json().catch(() => null) : null;
    verified = cd?.status === 2 || check.status === 404;
  }
  auditWrite("ticktick", "complete_task", { targetRef: taskId, requested: { projectId, taskId }, verified, detail });
  return { ok: res.ok, detail };
}

export async function deleteTask(projectId: string, taskId: string): Promise<{ ok: boolean; detail: string }> {
  const t = await token();
  if (!t) return { ok: false, detail: "TickTick not connected" };
  const res = await fetch(`${API}/project/${projectId}/task/${taskId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${t}` },
  });
  const detail = res.ok ? `deleted task ${taskId}` : `delete failed: ${res.status}`;
  // cheap read-back: GET the deleted task and expect it gone
  let verified = false;
  if (res.ok) {
    const check = await fetch(`${API}/project/${projectId}/task/${taskId}`, { headers: { Authorization: `Bearer ${t}` } });
    verified = check.status === 404;
  }
  auditWrite("ticktick", "delete_task", { targetRef: taskId, requested: { projectId, taskId }, verified, detail });
  return { ok: res.ok, detail };
}

// update/reschedule/move a task. moveToProjectId changes which list it lives in.
export async function updateTask(f: {
  taskId: string;
  projectId: string;
  title?: string;
  due?: string;
  priority?: number;
  moveToProjectId?: string;
}): Promise<{ ok: boolean; verified?: boolean; detail: string }> {
  const t = await token();
  if (!t) return { ok: false, detail: "TickTick not connected" };
  const cur = await fetch(`${API}/project/${f.projectId}/task/${f.taskId}`, { headers: { Authorization: `Bearer ${t}` } });
  if (!cur.ok) return { ok: false, detail: `task not found (${cur.status})` };
  const task = await cur.json();
  const body: any = {
    id: f.taskId,
    projectId: f.moveToProjectId || f.projectId,
    title: f.title ?? task.title,
  };
  if (f.due !== undefined) body.dueDate = f.due;
  else if (task.dueDate) body.dueDate = task.dueDate;
  if (f.priority !== undefined) body.priority = f.priority;
  else if (task.priority != null) body.priority = task.priority;

  const res = await fetch(`${API}/task/${f.taskId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = `update failed: ${JSON.stringify(d).slice(0, 120)}`;
    auditWrite("ticktick", "update_task", { targetRef: f.taskId, requested: { title: f.title, due: f.due, priority: f.priority, moveToProjectId: f.moveToProjectId }, verified: false, detail });
    return { ok: false, detail };
  }
  const check = await fetch(`${API}/project/${body.projectId}/task/${f.taskId}`, { headers: { Authorization: `Bearer ${t}` } });
  const detail = `updated "${body.title}"${f.due !== undefined ? ` (due ${f.due})` : ""}${f.moveToProjectId ? " (moved)" : ""}`;
  auditWrite("ticktick", "update_task", { targetRef: f.taskId, requested: { title: f.title, due: f.due, priority: f.priority, moveToProjectId: f.moveToProjectId }, verified: check.ok, detail });
  return { ok: true, verified: check.ok, detail };
}

export async function createTask(f: {
  title: string;
  due?: string;
  priority?: number;
  projectId?: string;
  project?: string;
}): Promise<{ ok: boolean; id?: string; verified?: boolean; detail: string }> {
  const t = await token();
  if (!t) return { ok: false, detail: "TickTick not connected" };
  const projectId = f.projectId || (await projectIdByName(t, f.project));
  const body: any = { title: f.title };
  if (f.due) body.dueDate = f.due; // ISO8601, e.g. 2026-07-05T15:00:00+0000
  if (f.priority != null) body.priority = f.priority; // 0 none,1 low,3 med,5 high
  if (projectId) body.projectId = projectId;

  const res = await fetch(`${API}/task`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await res.json();
  if (!res.ok) {
    const detail = `ticktick create failed: ${JSON.stringify(d).slice(0, 150)}`;
    auditWrite("ticktick", "create_task", { requested: { title: f.title.slice(0, 200), due: f.due, priority: f.priority, project: f.project || f.projectId }, verified: false, detail });
    return { ok: false, detail };
  }

  // VERIFIED read-back
  let verified = false;
  if (d.id && d.projectId) {
    const check = await fetch(`${API}/project/${d.projectId}/task/${d.id}`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    verified = check.ok;
  }
  const detail = verified
    ? `created & verified in TickTick: "${d.title}"${f.due ? ` (due ${f.due})` : ""}`
    : `created in TickTick (id ${d.id}) but couldn't confirm on read-back — say so, don't overclaim`;
  auditWrite("ticktick", "create_task", { targetRef: d.id, requested: { title: f.title.slice(0, 200), due: f.due, priority: f.priority, project: f.project || f.projectId }, verified, detail });
  return { ok: true, id: d.id, verified, detail };
}
