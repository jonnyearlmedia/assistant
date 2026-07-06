// the verified-write ledger (write_audits table). every external write records what was
// requested and whether read-back confirmed it — the queryable receipt behind pillar #1.
// fire-and-forget by design: bookkeeping must never delay or break the write itself.
import { db } from "./db";
import { ownerUserId } from "./integrations/tokens";

export function auditWrite(
  provider: string,
  action: string,
  a: { targetRef?: string; requested?: any; verified: boolean; detail?: string }
): void {
  Promise.resolve()
    .then(async () => {
      const uid = await ownerUserId().catch(() => null);
      await db.from("write_audits").insert({
        user_id: uid,
        provider,
        action,
        target_ref: a.targetRef ?? null,
        requested: a.requested ?? null,
        verified: a.verified,
        verify_detail: a.detail?.slice(0, 500) ?? null,
      });
    })
    .catch(() => {});
}
