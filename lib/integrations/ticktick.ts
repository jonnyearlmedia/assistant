// TickTick (jonny's source-of-truth calendar). OAuth2 + task ops with verified read-back.
import { ownerUserId, getIntegration, saveIntegration } from "./tokens";

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

export async function createTask(f: {
  title: string;
  due?: string;
  priority?: number;
  projectId?: string;
}): Promise<{ ok: boolean; id?: string; verified?: boolean; detail: string }> {
  const t = await token();
  if (!t) return { ok: false, detail: "TickTick not connected" };
  const body: any = { title: f.title };
  if (f.due) body.dueDate = f.due; // ISO8601, e.g. 2026-07-05T15:00:00+0000
  if (f.priority != null) body.priority = f.priority; // 0 none,1 low,3 med,5 high
  if (f.projectId) body.projectId = f.projectId;

  const res = await fetch(`${API}/task`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await res.json();
  if (!res.ok) return { ok: false, detail: `ticktick create failed: ${JSON.stringify(d).slice(0, 150)}` };

  // VERIFIED read-back
  let verified = false;
  if (d.id && d.projectId) {
    const check = await fetch(`${API}/project/${d.projectId}/task/${d.id}`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    verified = check.ok;
  }
  return {
    ok: true,
    id: d.id,
    verified,
    detail: verified
      ? `created & verified in TickTick: "${d.title}"${f.due ? ` (due ${f.due})` : ""}`
      : `created in TickTick (id ${d.id}) but couldn't confirm on read-back — say so, don't overclaim`,
  };
}
