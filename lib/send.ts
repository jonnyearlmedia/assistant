// shared "text like a person" sender: split into bubbles, show typing, human-paced delay.
import { sendMessage, startTyping } from "./linq";
import * as mem from "./memory";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const typingDelay = (t: string) => Math.min(1100 + t.length * 33, 4200);

export async function sendBubbles(
  userId: string,
  to: string,
  chatId: string | undefined,
  text: string
): Promise<number> {
  let bubbles = text
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean)
    .slice(0, 6);
  if (bubbles.length === 0) bubbles = [text.trim() || "…"];

  for (let i = 0; i < bubbles.length; i++) {
    await startTyping(chatId);
    await sleep(typingDelay(bubbles[i]));
    const sent = await sendMessage(to, bubbles[i]);
    await mem.logMessage(userId, "outbound", bubbles[i], {
      linq_message_id: sent.messageId,
      status: sent.ok ? "sent" : "failed",
    });
  }
  return bubbles.length;
}
