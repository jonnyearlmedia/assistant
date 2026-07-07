// shared "text like a person" sender: split into bubbles, show typing, human-paced delay.
// reports per-bubble delivery. with durable:true, a send where NOTHING got through is
// re-enqueued on the job queue so the next tick retries it — the text never just evaporates.
// partial failures are not retried (re-sending would duplicate the bubbles that did land).
import { sendMessage, startTyping } from "./linq";
import * as mem from "./memory";
import { enqueue } from "./queue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const typingDelay = (t: string) => Math.min(1100 + t.length * 33, 4200);

export type SendResult = { bubbles: number; sent: number; failed: number; error?: string };

export async function sendBubbles(
  userId: string,
  to: string,
  chatId: string | undefined,
  text: string,
  opts: { durable?: boolean } = {}
): Promise<SendResult> {
  let bubbles = text
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (bubbles.length === 0) bubbles = [text.trim() || "…"];
  // hard anti-spam guarantee: never more than 4 bubbles. if she over-splits, merge the overflow into
  // the last bubble instead of dropping it — no content lost, but he never gets a 5+ text barrage.
  const MAX_BUBBLES = 4;
  if (bubbles.length > MAX_BUBBLES) {
    bubbles = [...bubbles.slice(0, MAX_BUBBLES - 1), bubbles.slice(MAX_BUBBLES - 1).join("\n\n")];
  }

  let sent = 0;
  let failed = 0;
  let lastError: string | undefined; // capture Linq's ACTUAL rejection (status + body) for diagnosis
  for (let i = 0; i < bubbles.length; i++) {
    await startTyping(chatId);
    await sleep(typingDelay(bubbles[i]));
    const s = await sendMessage(to, bubbles[i]);
    if (s.ok) sent++;
    else {
      failed++;
      lastError = `${s.status ? `HTTP ${s.status} ` : ""}${s.error || "unknown"}`.slice(0, 300);
      console.error("[lexa] send failed:", lastError);
    }
    await mem.logMessage(userId, "outbound", bubbles[i], {
      linq_message_id: s.messageId,
      status: s.ok ? "sent" : "failed",
    });
  }

  if (opts.durable && sent === 0 && failed > 0) {
    try {
      await enqueue("send_message", { user_id: userId, to, chat_id: chatId ?? null, text }, { userId });
    } catch (e: any) {
      console.error("[lexa] failed to enqueue send retry:", e?.message || e);
    }
  }
  return { bubbles: bubbles.length, sent, failed, error: lastError };
}
