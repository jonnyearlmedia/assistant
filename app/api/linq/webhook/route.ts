// inbound Linq webhook: a text arrives here, lexa thinks, lexa replies.
import { NextRequest, NextResponse } from "next/server";
import { verifyWebhook, parseInbound, sendMessage } from "@/lib/linq";
import { resolveUser } from "@/lib/db";
import { think } from "@/lib/brain";
import * as mem from "@/lib/memory";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig = req.headers.get("x-linq-signature") || req.headers.get("linq-signature");

  if (!verifyWebhook(raw, sig)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const inbound = parseInbound(payload);
  if (!inbound || !inbound.text) {
    // delivery receipts / reactions / non-message events — ack and move on
    return NextResponse.json({ ok: true, ignored: true });
  }

  // only respond to the owner's number (single-tenant for now)
  const owner = process.env.OWNER_PHONE;
  if (owner && inbound.from.replace(/\D/g, "") !== owner.replace(/\D/g, "")) {
    return NextResponse.json({ ok: true, ignored: "not owner" });
  }

  try {
    const user = await resolveUser(inbound.from);
    await mem.logMessage(user.id, "inbound", inbound.text, {
      channel: inbound.channel,
      media: inbound.media,
      linq_message_id: inbound.messageId,
    });

    const reply = await think(user, inbound.text, inbound.media);

    // send as multiple real-texter bubbles (split on blank lines) instead of one wall of text
    let bubbles = reply
      .split(/\n\s*\n+/)
      .map((b) => b.trim())
      .filter(Boolean)
      .slice(0, 6);
    if (bubbles.length === 0) bubbles = [reply.trim() || "…"];

    for (let i = 0; i < bubbles.length; i++) {
      const sent = await sendMessage(inbound.from, bubbles[i]);
      await mem.logMessage(user.id, "outbound", bubbles[i], {
        linq_message_id: sent.messageId,
        status: sent.ok ? "sent" : "failed",
      });
      if (!sent.ok) console.error("[lexa] send failed:", sent.error);
      // small human-ish gap so bubbles land in order as separate messages
      if (i < bubbles.length - 1) await new Promise((r) => setTimeout(r, 650));
    }

    return NextResponse.json({ ok: true, bubbles: bubbles.length });
  } catch (e: any) {
    console.error("[lexa] webhook error:", e?.message || e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

// simple health check
export async function GET() {
  return NextResponse.json({ service: "lexa", status: "alive", rev: "bubbles-v1" });
}
