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
    title: e.summary,
    start: e.start?.dateTime || e.start?.date,
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
