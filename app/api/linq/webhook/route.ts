// inbound Linq webhook: a text arrives, we ACK instantly, then reply AFTER jonny stops texting
// (debounce) so rapid-fire messages get coalesced into one coherent reply instead of stumbling.
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { verifyLinq, parseInbound, markRead, InboundMessage } from "@/lib/linq";
import { resolveUser, User, db } from "@/lib/db";
import { think } from "@/lib/brain";
import { quickTriage } from "@/lib/triage";
import { sendBubbles } from "@/lib/send";
import * as mem from "@/lib/memory";

export const runtime = "nodejs";

// how long lexa waits for silence before replying. each new text resets it (they're spamming a thought).
const SETTLE_MS = Number(process.env.SETTLE_MS || 6000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function replyAfterSettle(user: User, from: string, chatId: string | undefined, myCreatedAt: string) {
  try {
    await sleep(SETTLE_MS);
    // a newer text arrived — that later invocation will own the batch. stand down.
    if (await mem.hasNewerInbound(user.id, myCreatedAt)) return;

    const batch = await mem.pendingInbound(user.id);
    if (!batch.length) return;
    const earliest = batch[0].created_at;
    const combined = batch.map((m: any) => m.body).filter(Boolean).join("\n");
    const media = batch.flatMap((m: any) => (Array.isArray(m.media) ? m.media : []));
    await mem.markHandled(batch.map((m: any) => m.id)); // claim the batch

    // cheap Haiku triage first: pure social chatter gets a fast direct reply and skips the full
    // Sonnet tool loop. media (vision) and anything substantive fall through to the full brain.
    let reply: string;
    const triage = media.length === 0 ? await quickTriage(user, combined) : { route: "full" as const };
    if (triage.route === "quick" && triage.reply) {
      reply = triage.reply;
    } else {
      reply = await think(user, combined, media, { historyBefore: earliest });
    }

    // durable: if every bubble fails to send, the reply is queued and retried on the next tick
    await sendBubbles(user.id, from, chatId, reply, { durable: true });
  } catch (e: any) {
    console.error("[lexa] settle handler error:", e?.message || e);
  }
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const v = verifyLinq(raw, req.headers);
  if (!v.ok) {
    console.warn("[lexa] linq signature:", v.reason);
    // rollout-safe: only reject once we've confirmed the scheme against real traffic
    if (process.env.LINQ_ENFORCE_SIG === "1") {
      return NextResponse.json({ error: "bad signature" }, { status: 401 });
    }
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
    markRead(inbound.chatId); // read receipt (best-effort, fire-and-forget)
    // remember the chat id so lexa can show typing when she reaches out proactively
    if (inbound.chatId && (user as any).linq_chat_id !== inbound.chatId) {
      db.from("users").update({ linq_chat_id: inbound.chatId }).eq("id", user.id).then(() => {});
    }
    const msg = await mem.logMessage(user.id, "inbound", inbound.text, {
      channel: inbound.channel,
      media: inbound.media,
      linq_message_id: inbound.messageId,
    });
    // ACK Linq immediately; reply in the background once he's done texting (debounce)
    waitUntil(
      replyAfterSettle(user, inbound.from, inbound.chatId, msg?.created_at ?? new Date().toISOString())
    );
    return NextResponse.json({ ok: true, queued: true });
  } catch (e: any) {
    console.error("[lexa] webhook error:", e?.message || e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

// simple health check
export async function GET() {
  return NextResponse.json({ service: "lexa", status: "alive", rev: "commitments-v7" });
}
