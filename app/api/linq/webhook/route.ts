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

    const sent = await sendMessage(inbound.from, reply);
    await mem.logMessage(user.id, "outbound", reply, {
      linq_message_id: sent.messageId,
      status: sent.ok ? "sent" : "failed",
    });

    if (!sent.ok) {
      // reliability: don't silently drop. surface for the retry queue.
      console.error("[lexa] send failed:", sent.error);
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[lexa] webhook error:", e?.message || e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

// simple health check
export async function GET() {
  return NextResponse.json({ service: "lexa", status: "alive" });
}
