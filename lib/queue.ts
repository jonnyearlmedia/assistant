// the durable job queue the schema always promised (jobs table: retries + backoff + dead-letter).
// this is what makes proactive delivery survive flaky Linq sends and overlapping cron ticks:
// work is claimed atomically, failures retry with backoff, and exhausted jobs land in 'dead'
// where they stay inspectable instead of vanishing. dedupe_key gives exactly-once semantics
// for per-day work (morning brief, check-in, automations) and the tick lease.
import { db } from "./db";

export type Job = {
  id: string;
  user_id: string | null;
  kind: string;
  run_at: string;
  payload: any;
  status: string; // pending | running | done | failed | dead
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  dedupe_key: string | null;
};

// insert a job. with dedupeKey, at most one job ever exists per key (unique index) —
// returns null when the key already exists, which callers treat as "someone else owns this".
export async function enqueue(
  kind: string,
  payload: Record<string, any>,
  opts: { userId?: string; runAt?: string; dedupeKey?: string; maxAttempts?: number } = {}
): Promise<{ id: string } | null> {
  const row = {
    kind,
    payload,
    user_id: opts.userId ?? null,
    run_at: opts.runAt ?? new Date().toISOString(),
    max_attempts: opts.maxAttempts ?? 5,
    dedupe_key: opts.dedupeKey ?? null,
  };
  if (opts.dedupeKey) {
    const { data, error } = await db
      .from("jobs")
      .upsert(row, { onConflict: "dedupe_key", ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`enqueue ${kind}: ${error.message}`);
    return data?.[0] ?? null;
  }
  const { data, error } = await db.from("jobs").insert(row).select("id").single();
  if (error) throw new Error(`enqueue ${kind}: ${error.message}`);
  return data;
}

// atomically claim due pending jobs. the status+attempts guard on the update means two
// overlapping ticks can both SELECT the same row but only one wins the claim — the loser's
// update matches zero rows. claiming also bumps run_at so the stuck-job reaper can tell
// how long a 'running' job has actually been running.
export async function claimDue(limit = 10): Promise<Job[]> {
  const now = new Date().toISOString();
  const { data } = await db
    .from("jobs")
    .select("*")
    .eq("status", "pending")
    .lte("run_at", now)
    .order("run_at")
    .limit(limit);
  const claimed: Job[] = [];
  for (const j of (data as Job[]) || []) {
    const { data: got } = await db
      .from("jobs")
      .update({ status: "running", attempts: j.attempts + 1, run_at: now })
      .eq("id", j.id)
      .eq("status", "pending")
      .eq("attempts", j.attempts)
      .select("*");
    if (got?.length) claimed.push(got[0] as Job);
  }
  return claimed;
}

export async function complete(id: string): Promise<void> {
  await db.from("jobs").update({ status: "done", last_error: null }).eq("id", id);
}

// retry with exponential backoff (2, 4, 8, 16, 32 min…), dead-letter once attempts run out.
export async function fail(job: Job, err: unknown): Promise<"retry" | "dead"> {
  const msg = String((err as any)?.message || err).slice(0, 500);
  if (job.attempts >= job.max_attempts) {
    await db.from("jobs").update({ status: "dead", last_error: msg }).eq("id", job.id);
    return "dead";
  }
  const backoffMin = Math.min(2 ** job.attempts, 60);
  await db
    .from("jobs")
    .update({
      status: "pending",
      run_at: new Date(Date.now() + backoffMin * 60_000).toISOString(),
      last_error: msg,
    })
    .eq("id", job.id);
  return "retry";
}

// tick lease: at most one full tick per time window, so a bunched-up GitHub cron run or the
// daily Vercel cron overlapping the pinger can't double-run the proactive engine. the lease
// self-expires by construction (next window = new key), so a crashed tick can't wedge it.
export async function acquireTickLease(windowMin = 5): Promise<boolean> {
  const bucket = Math.floor(Date.now() / (windowMin * 60_000));
  const got = await enqueue("tick_lease", {}, { dedupeKey: `tick-${bucket}`, maxAttempts: 0 });
  if (got) await db.from("jobs").update({ status: "done" }).eq("id", got.id);
  return !!got;
}

// a serverless invocation can die mid-job (timeout, deploy) leaving it stuck 'running'.
// anything running longer than staleMin goes back to pending; its attempt was already counted.
export async function reapStuck(staleMin = 30): Promise<number> {
  const cutoff = new Date(Date.now() - staleMin * 60_000).toISOString();
  const { data } = await db
    .from("jobs")
    .update({ status: "pending", last_error: "reaped: stuck in running" })
    .eq("status", "running")
    .lt("run_at", cutoff)
    .select("id");
  return data?.length ?? 0;
}

// keep the table tidy: completed jobs older than `days` get dropped. dead jobs are kept —
// they're the inspectable failure record.
export async function prune(days = 14): Promise<void> {
  await db
    .from("jobs")
    .delete()
    .eq("status", "done")
    .lt("created_at", new Date(Date.now() - days * 86400_000).toISOString());
}

// drain the queue: claim due jobs and run them through the provided handlers. a job whose
// handler throws goes through fail() (backoff or dead-letter); unknown kinds dead-letter
// immediately so a typo'd kind is loud, not an infinite retry loop.
export async function runJobs(
  handlers: Record<string, (job: Job) => Promise<void>>,
  limit = 10
): Promise<{ ran: number; ok: number; retried: number; dead: number }> {
  const jobs = await claimDue(limit);
  const out = { ran: 0, ok: 0, retried: 0, dead: 0 };
  for (const job of jobs) {
    out.ran++;
    const handler = handlers[job.kind];
    if (!handler) {
      await db.from("jobs").update({ status: "dead", last_error: `no handler for kind "${job.kind}"` }).eq("id", job.id);
      out.dead++;
      continue;
    }
    try {
      await handler(job);
      await complete(job.id);
      out.ok++;
    } catch (e) {
      const fate = await fail(job, e);
      if (fate === "dead") out.dead++;
      else out.retried++;
    }
  }
  return out;
}
