// Google (Gmail + Calendar + Drive). OAuth2 with refresh. Sending gmail is gated behind confirmation.
import { ownerUserId, getIntegration, saveIntegration } from "./tokens";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.readonly",
  "openid",
  "email",
];

function redirectUri() {
  return `${process.env.APP_BASE_URL}/api/connect/google/callback`;
}

export function authUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH}?${p.toString()}`;
}

export async function exchangeCode(code: string): Promise<void> {
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
  await saveIntegration(uid, "google", {
    access_token: d.access_token,
    refresh_token: d.refresh_token ?? null,
    scope: d.scope ?? SCOPES.join(" "),
    expires_at: d.expires_in ? new Date(Date.now() + d.expires_in * 1000).toISOString() : null,
  });
}

// returns a valid access token, refreshing if expired
async function accessToken(): Promise<string | null> {
  const uid = await ownerUserId();
  if (!uid) return null;
  const i = await getIntegration(uid, "google");
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
      await saveIntegration(uid, "google", {
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

export async function googleConnected(): Promise<boolean> {
  return !!(await accessToken());
}

export async function gmailSearch(query: string, max = 5): Promise<{ ok: boolean; detail: string; results?: any[] }> {
  const t = await accessToken();
  if (!t) return { ok: false, detail: "Google not connected" };
  const list = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
    { headers: { Authorization: `Bearer ${t}` } }
  );
  const ld = await list.json();
  if (!list.ok) return { ok: false, detail: JSON.stringify(ld).slice(0, 150) };
  const ids = (ld.messages || []).map((m: any) => m.id);
  const results = [];
  for (const id of ids) {
    const m = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${t}` } }
    );
    const md = await m.json();
    const h = (n: string) => md.payload?.headers?.find((x: any) => x.name === n)?.value;
    results.push({ from: h("From"), subject: h("Subject"), date: h("Date"), snippet: md.snippet });
  }
  return { ok: true, detail: `${results.length} result(s)`, results };
}

export async function calendarUpcoming(max = 10): Promise<{ ok: boolean; detail: string; events?: any[] }> {
  const t = await accessToken();
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
  const t = await accessToken();
  if (!t) return { ok: false, detail: "Google not connected" };
  const end = f.end || new Date(new Date(f.start).getTime() + 3600_000).toISOString();
  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: f.title,
      location: f.location,
      start: { dateTime: f.start },
      end: { dateTime: end },
    }),
  });
  const d = await res.json();
  if (!res.ok) return { ok: false, detail: JSON.stringify(d).slice(0, 150) };
  // verified read-back
  const check = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${d.id}`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  return { ok: true, verified: check.ok, detail: check.ok ? `created & verified: "${d.summary}"` : "created but unverified" };
}
