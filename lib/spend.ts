// spend awareness (roadmap #2): turn the usage_log token counts into dollar estimates so lexa
// can answer "what are you costing me?" honestly. it's an ESTIMATE off logged tokens — she says "~".
import { db } from "./db";

// per-1M-token USD rates. cache_read ≈ 0.1× input, cache_write (5-min TTL) ≈ 1.25× input.
// approximate + easy to edit — verify against the Anthropic pricing page if it matters.
// (sonnet-5 is intro-discounted to $2/$10 through 2026-08-31, so real spend runs a bit under this.)
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

function rate(model: string): { input: number; output: number } {
  for (const key of Object.keys(PRICING)) if (model?.startsWith(key)) return PRICING[key];
  return { input: 3, output: 15 }; // default to sonnet-tier if an unknown model shows up
}

function rowCost(r: any): number {
  const { input, output } = rate(r.model || "");
  return (
    (r.input / 1e6) * input +
    (r.cache_read / 1e6) * input * 0.1 +
    (r.cache_write / 1e6) * input * 1.25 +
    (r.output / 1e6) * output
  );
}

const round = (n: number) => Math.round(n * 10000) / 10000;

// period → ISO cutoff. rolling windows (good enough for a gauge; not tz-exact "calendar today").
export function periodSince(period: string): string | undefined {
  const now = Date.now();
  if (period === "today") return new Date(now - 24 * 3600_000).toISOString();
  if (period === "week") return new Date(now - 7 * 24 * 3600_000).toISOString();
  if (period === "month") return new Date(now - 30 * 24 * 3600_000).toISOString();
  return undefined; // all-time
}

export async function computeSpend(
  sinceIso?: string
): Promise<{ ok: boolean; total_usd: number; by_fn: Record<string, number>; calls: number; since?: string; detail: string }> {
  let q = db.from("usage_log").select("fn,model,input,cache_read,cache_write,output");
  if (sinceIso) q = q.gte("created_at", sinceIso);
  const { data, error } = await q;
  if (error) return { ok: false, total_usd: 0, by_fn: {}, calls: 0, detail: `spend read failed: ${error.message}` };

  let total = 0;
  const raw: Record<string, number> = {};
  for (const r of data || []) {
    const c = rowCost(r);
    total += c;
    raw[r.fn] = (raw[r.fn] || 0) + c;
  }
  const by_fn: Record<string, number> = {};
  for (const k of Object.keys(raw)) by_fn[k] = round(raw[k]);
  return {
    ok: true,
    total_usd: round(total),
    by_fn,
    calls: (data || []).length,
    since: sinceIso,
    detail: `~$${round(total).toFixed(4)} across ${(data || []).length} calls${sinceIso ? " in window" : " all-time"} (estimate off token logs)`,
  };
}
