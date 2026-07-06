// Google (Gmail + Calendar + Drive). OAuth2 with refresh. Multi-inbox: two account slots
// ("google" primary + "google2" personal) share ONE registered redirect URI, distinguished by
// the OAuth `state` param — so no extra redirect URI to register for the 2nd account.
import { ownerUserId, getIntegration, saveIntegration } from "./tokens";
import { db } from "../db";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SLOTS = ["google", "google2"];
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

function redirectUri() {
  return `${process.env.APP_BASE_URL}/api/connect/google/callback`;
}

// state carries which account slot we're filling ("google" | "google2")
export function authUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    state,
  });
  return `${AUTH}?${p.toString()}`;
}

async function emailFor(accessToken: string): Promise<string | null> {
  const r = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d.email ?? null;
}

export async function exchangeCode(code: string, slot = "google"): Promise<string | null> {
  if (!SLOTS.includes(slot)) slot = "google";
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const d = await res.json();
  if (!res.ok || !d.access_token) throw new Error(`google token exchange failed: ${JSON.stringify(d).slice(0, 200)}`);
  const uid = await ownerUserId();
  if (!uid) throw new Error("no owner user");
  const email = await emailFor(d.access_token);
  await saveIntegration(
    uid,
    slot,
    {
      access_token: d.access_token,
      refresh_token: d.refresh_token ?? null,
      scope: d.scope ?? SCOPES.join(" "),
      expires_at: d.expires_in ? new Date(Date.now() + d.expires_in * 1000).toISOString() : null,
    },
    email ? { email } : undefined
  );
  return email;
}

async function accessToken(slot: string): Promise<string | null> {
  const uid = await ownerUserId();
  if (!uid) return null;
  const i = await getIntegration(uid, slot);
  if (!i?.access_token) return null;
  const expired = i.expires_at && new Date(i.expires_at).getTime() < Date.now() + 60_000;
  if (expired && i.refresh_token) {
    const body = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      refresh_token: i.refresh_token,
      grant_type: "refresh_token",
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const d = await res.json();
    if (res.ok && d.access_token) {
      await saveIntegration(uid, slot, {
        access_token: d.access_token,
        refresh_token: i.refresh_token,
        scope: i.scope,
        expires_at: d.expires_in ? new Date(Date.now() + d.expires_in * 1000).toISOString() : null,
      });
      return d.access_token;
    }
  }
  return i.access_token;
}

async function connectedSlots(): Promise<Array<{ slot: string; email: string | null }>> {
  const uid = await ownerUserId();
  if (!uid) return [];
  const { data } = await db.from("integrations").select("provider, meta").eq("user_id", uid).in("provider", SLOTS);
  return (data || []).map((r: any) => ({ slot: r.provider, email: r.meta?.email ?? null }));
}

export async function googleConnected(): Promise<boolean> {
  return (await connectedSlots()).length > 0;
}

export async function gmailSearch(query: string, max = 5): Promise<{ ok: boolean; detail: string; results?: any[] }> {
  const slots = await connectedSlots();
  if (!slots.length) return { ok: false, detail: "Google not connected" };
  const all: any[] = [];
  for (const s of slots) {
    const t = await accessToken(s.slot);
    if (!t) continue;
    const list = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
      { headers: { Authorization: `Bearer ${t}` } }
    );
    const ld = await list.json();
    if (!list.ok) continue;
    for (const m of ld.messages || []) {
      const mm = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${t}` } }
      );
      const md = await mm.json();
      const h = (n: string) => md.payload?.headers?.find((x: any) => x.name === n)?.value;
      all.push({ inbox: s.email || s.slot, from: h("From"), subject: h("Subject"), date: h("Date"), snippet: md.snippet });
    }
  }
  return { ok: true, detail: `${all.length} result(s) across ${slots.length} inbox(es)`, results: all };
}

export async function driveSearch(query: string, max = 6): Promise<{ ok: boolean; detail: string; files?: any[] }> {
  const t = await accessToken("google");
  if (!t) return { ok: false, detail: "Google not connected" };
  const q = encodeURIComponent(`name contains '${(query || "").replace(/'/g, "")}' and trashed=false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=${max}&fields=files(id,name,mimeType,modifiedTime,webViewLink)`,
    { headers: { Authorization: `Bearer ${t}` } }
  );
  const d = await res.json();
  if (!res.ok) return { ok: false, detail: JSON.stringify(d).slice(0, 150) };
  const files = (d.files || []).map((f: any) => ({ id: f.id, name: f.name, type: f.mimeType, link: f.webViewLink, modified: f.modifiedTime }));
  return { ok: true, detail: `${files.length} file(s)`, files };
}

// read a Drive file's contents (Google Docs exported to text; other text files read directly)
export async function driveRead(fileId: string): Promise<{ ok: boolean; name?: string; text?: string; detail: string }> {
  const t = await accessToken("google");
  if (!t) return { ok: false, detail: "Google not connected" };
  const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  if (!meta.ok) return { ok: false, detail: `file not found (${meta.status})` };
  const m = await meta.json();
  const isGoogleDoc = (m.mimeType || "").startsWith("application/vnd.google-apps");
  const url = isGoogleDoc
    ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`
    : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
  if (!res.ok) return { ok: false, detail: `read failed: ${res.status}` };
  const text = (await res.text()).slice(0, 8000);
  return { ok: true, name: m.name, text, detail: `read "${m.name}"` };
}

function buildRaw(to: string, subject: string, body: string): string {
  const msg = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
  return Buffer.from(msg).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// send an email as jonny (persona gates this behind his explicit ok)
export async function gmailSend(to: string, subject: string, body: string): Promise<{ ok: boolean; detail: string }> {
  const t = await accessToken("google");
  if (!t) return { ok: false, detail: "Google not connected" };
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: buildRaw(to, subject, body) }),
  });
  const d = await res.json();
  if (!res.ok) return { ok: false, detail: JSON.stringify(d).slice(0, 150) };
  return { ok: true, detail: `✅ sent to ${to} — "${subject}"` };
}

export async function gmailDraft(to: string, subject: string, body: string): Promise<{ ok: boolean; detail: string }> {
  const t = await accessToken("google");
  if (!t) return { ok: false, detail: "Google not connected" };
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw: buildRaw(to, subject, body) } }),
  });
  const d = await res.json();
  if (!res.ok) return { ok: false, detail: JSON.stringify(d).slice(0, 150) };
  return { ok: true, detail: `draft saved for ${to} — "${subject}"` };
}

export async function calendarUpcoming(max = 10): Promise<{ ok: boolean; detail: string; events?: any[] }> {
  const t = await accessToken("google");
  if (!t) return { ok: false, detail: "Google not connected" };
  const now = new Date().toISOString();
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(now)}&maxResults=${max}&singleEvents=true&orderBy=startTime`,
    { headers: { Authorization: `Bearer ${t}` } }
  );
  const d = await res.json();
  if (!res.ok) return { ok: false, detail: JSON.stringify(d).slice(0, 150) };
  const events = (d.items || []).map((e: any) => ({
    id: e.id,
    title: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location,
  }));
  return { ok: true, detail: `${events.length} upcoming`, events };
}

export async function calendarCreate(f: {
  title: string;
  start: string;
  end?: string;
  location?: string;
}): Promise<{ ok: boolean; verified?: boolean; detail: string }> {
  const t = await accessToken("google");
  if (!t) return { ok: false, detail: "Google not connected" };
  const end = f.end || new Date(new Date(f.start).getTime() + 3600_000).toISOString();
  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({ summary: f.title, location: f.location, start: { dateTime: f.start }, end: { dateTime: end } }),
  });
  const d = await res.json();
  if (!res.ok) return { ok: false, detail: JSON.stringify(d).slice(0, 150) };
  const check = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${d.id}`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  return { ok: true, verified: check.ok, detail: check.ok ? `created & verified: "${d.summary}"` : "created but unverified" };
}

// reschedule / rename / move a calendar event (get id from calendarUpcoming)
export async function calendarUpdate(
  eventId: string,
  f: { title?: string; start?: string; end?: string; location?: string }
): Promise<{ ok: boolean; detail: string }> {
  const t = await accessToken("google");
  if (!t) return { ok: false, detail: "Google not connected" };
  const patch: any = {};
  if (f.title !== undefined) patch.summary = f.title;
  if (f.location !== undefined) patch.location = f.location;
  if (f.start) patch.start = { dateTime: f.start };
  if (f.end) patch.end = { dateTime: f.end };
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const d = await res.json();
  if (!res.ok) return { ok: false, detail: JSON.stringify(d).slice(0, 150) };
  return { ok: true, detail: `updated "${d.summary}"${f.start ? ` → ${f.start}` : ""}` };
}

export async function calendarDelete(eventId: string): Promise<{ ok: boolean; detail: string }> {
  const t = await accessToken("google");
  if (!t) return { ok: false, detail: "Google not connected" };
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${t}` },
  });
  return { ok: res.ok || res.status === 204, detail: res.ok || res.status === 204 ? `deleted event ${eventId}` : `delete failed: ${res.status}` };
}
