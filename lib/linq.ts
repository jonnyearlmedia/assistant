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
}

export function parseInbound(payload: any): InboundMessage | null {
  // tolerant parser — Linq nests message under a few possible shapes; refine once we see live events.
  const msg = payload?.message ?? payload?.data?.message ?? payload;
  const from =
    payload?.from ?? msg?.from ?? payload?.chat?.participants?.[0] ?? null;
  if (!from) return null;

  const parts: any[] = msg?.parts ?? [];
  const text = parts
    .filter((p) => p?.type === "text")
    .map((p) => p.value)
    .join("\n")
    .trim() || (typeof msg?.text === "string" ? msg.text : "");
  const media = parts.filter((p) => p?.type === "media").map((p) => p.url).filter(Boolean);

  return {
    from,
    text,
    media,
    messageId: msg?.id ?? payload?.id,
    channel: msg?.channel ?? payload?.channel,
  };
}
