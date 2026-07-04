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
