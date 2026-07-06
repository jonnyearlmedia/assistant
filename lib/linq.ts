// Linq Partner API v3 — the transport that puts lexa in a real iMessage/SMS thread.
// docs: https://docs.linqapp.com  base: https://api.linqapp.com/api/partner/v3
// Linq auto-selects the best channel per recipient: iMessage -> RCS -> SMS.

import crypto from "crypto";

const BASE = process.env.LINQ_BASE_URL || "https://api.linqapp.com/api/partner/v3";
const FROM = process.env.LEXA_PHONE_NUMBER || "+13212973385"; // lexa's line

type Part =
  | { type: "text"; value: string }
  | { type: "media"; url: string }
  | { type: "reaction"; value: string };

export interface SendResult {
  ok: boolean;
  messageId?: string;
  status?: number;
  error?: string;
}

/** Send a text (and optional media) to a recipient. Returns delivery info; caller logs it. */
export async function sendMessage(
  to: string,
  text: string,
  extraParts: Part[] = []
): Promise<SendResult> {
  const key = process.env.LINQ_API_KEY;
  if (!key) return { ok: false, error: "LINQ_API_KEY not set" };

  const body = {
    from: FROM,
    to: [to],
    message: { parts: [{ type: "text", value: text }, ...extraParts] },
  };

  try {
    const res = await fetch(`${BASE}/chats`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: res.status, error: JSON.stringify(data) };
    }
    return { ok: true, status: res.status, messageId: data?.id || data?.message?.id };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Verify an inbound Linq webhook signature.
 * NOTE: exact header name + scheme to be confirmed against docs.linqapp.com/guides/webhooks.
 * Implemented as HMAC-SHA256 over the raw body with LINQ_WEBHOOK_SECRET — the common pattern.
 */
export function verifyWebhook(rawBody: string, signature: string | null): boolean {
  const secret = process.env.LINQ_WEBHOOK_SECRET;
  if (!secret) return true; // until a secret is configured, don't hard-fail (dev)
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Fetch an inbound media attachment (e.g. a photo) and return it base64-encoded for vision. */
export async function fetchMedia(
  url: string
): Promise<{ mediaType: string; data: string } | null> {
  try {
    const res = await fetch(url, {
      headers: process.env.LINQ_API_KEY ? { Authorization: `Bearer ${process.env.LINQ_API_KEY}` } : {},
    });
    if (!res.ok) return null;
    let mediaType = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (!/^image\//.test(mediaType)) return null; // only images go to vision
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4_500_000) return null; // keep payloads sane
    return { mediaType, data: buf.toString("base64") };
  } catch {
    return null;
  }
}

/**
 * Verify a Linq inbound webhook using the Svix-style signature (secret is `whsec_...`).
 * Non-fatal by design: returns {ok,reason} so the caller can log in rollout and only reject
 * once LINQ_ENFORCE_SIG=1 is set and we've confirmed the scheme against real traffic.
 */
export function verifyLinq(rawBody: string, headers: Headers): { ok: boolean; reason: string } {
  const secret = process.env.LINQ_WEBHOOK_SECRET;
  if (!secret) return { ok: true, reason: "no secret configured" };
  const id = headers.get("webhook-id") || headers.get("linq-webhook-id");
  const ts = headers.get("webhook-timestamp") || headers.get("linq-webhook-timestamp");
  const sigHeader =
    headers.get("webhook-signature") || headers.get("linq-signature") || headers.get("x-linq-signature");
  if (!id || !ts || !sigHeader) return { ok: false, reason: "missing signature headers" };
  try {
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const expected = crypto.createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64");
    const provided = sigHeader.split(" ").map((s) => (s.includes(",") ? s.split(",")[1] : s));
    const ok = provided.some((p) => {
      try {
        return crypto.timingSafeEqual(Buffer.from(p), Buffer.from(expected));
      } catch {
        return false;
      }
    });
    return { ok, reason: ok ? "verified" : "signature mismatch" };
  } catch (e: any) {
    return { ok: false, reason: `verify error: ${e?.message || e}` };
  }
}

/** Fetch a text/markdown/csv/json attachment and return its contents (so she can ingest .md files). */
export async function fetchTextAttachment(url: string): Promise<{ text: string } | null> {
  try {
    const res = await fetch(url, {
      headers: process.env.LINQ_API_KEY ? { Authorization: `Bearer ${process.env.LINQ_API_KEY}` } : {},
    });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
    const textual = /^text\/|json|markdown|csv|xml|yaml|x-yaml|javascript/.test(ct) || /\.(md|txt|csv|json|ya?ml|xml)$/i.test(url);
    if (!textual) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 300_000) return null;
    return { text: buf.toString("utf-8").slice(0, 60000) };
  } catch {
    return null;
  }
}

/** Normalize a Linq inbound webhook payload into a simple shape lexa's brain consumes. */
export interface InboundMessage {
  from: string;
  text: string;
  media: string[];
  messageId?: string;
  channel?: string;
  chatId?: string;
}

function authHeaders() {
  return { Authorization: `Bearer ${process.env.LINQ_API_KEY}`, "Content-Type": "application/json" };
}

/** Show the iMessage typing bubble (auto-clears on send; ~60s TTL). iMessage 1:1 only. */
export async function startTyping(chatId?: string): Promise<void> {
  if (!chatId || !process.env.LINQ_API_KEY) return;
  try {
    await fetch(`${BASE}/chats/${chatId}/typing`, { method: "POST", headers: authHeaders() });
  } catch {
    /* typing is best-effort; never block a reply on it */
  }
}

/** Best-effort read receipt. Endpoint isn't formally documented; we try and swallow failures. */
export async function markRead(chatId?: string): Promise<void> {
  if (!chatId || !process.env.LINQ_API_KEY) return;
  try {
    await fetch(`${BASE}/chats/${chatId}/read`, { method: "POST", headers: authHeaders() });
  } catch {
    /* if the endpoint 404s, read receipts likely need a dashboard toggle on the line */
  }
}

export function parseInbound(payload: any): InboundMessage | null {
  // matches Linq's real message.received shape (webhook_version 2026-02-03):
  // { event_type, data: { id, direction, sender_handle: {handle, is_me}, parts: [{type,value|url}], service, chat } }
  const data = payload?.data;
  if (!data) return null;

  // only real inbound messages from the other person — never react to our own echoed sends
  if (data.direction && data.direction !== "inbound") return null;
  if (data?.sender_handle?.is_me === true) return null;

  const from: string | undefined = data?.sender_handle?.handle;
  if (!from) return null;

  const parts: any[] = Array.isArray(data.parts) ? data.parts : [];
  const text = parts
    .filter((p) => p?.type === "text")
    .map((p) => p.value)
    .join("\n")
    .trim();
  const media = parts.filter((p) => p?.type === "media").map((p) => p.url).filter(Boolean);

  return {
    from,
    text,
    media,
    messageId: data.id,
    channel: data.service,
    chatId: data?.chat?.id,
  };
}
