// shared "text like a person" sender: split into bubbles, show typing, human-paced delay.
// reports per-bubble delivery. with durable:true, a send where NOTHING got through is
// re-enqueued on the job queue so the next tick retries it — the text never just evaporates.
// partial failures are not retried (re-sending would duplicate the bubbles that did land).
import { sendMessage, startTyping } from "./linq";
import * as mem from "./memory";
import { enqueue } from "./queue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const typingDelay = (t: string) => Math.min(1100 + t.length * 33, 4200);

export type SendResult = { bubbles: number; sent: number; failed: number };

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
    .filter(Boolean)
    .slice(0, 6);
  if (bubbles.length === 0) bubbles = [text.trim() || "…"];

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < bubbles.length; i++) {
    await startTyping(chatId);
    await sleep(typingDelay(bubbles[i]));
    const s = await sendMessage(to, bubbles[i]);
    if (s.ok) sent++;
    else {
      failed++;
      console.error("[lexa] send failed:", s.error);
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
  return { bubbles: bubbles.length, sent, failed };
}
