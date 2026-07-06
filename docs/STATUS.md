# lexa — build status & roadmap

_Snapshot of what's built, what's partial, what's blocked, and what to build next._
_Last updated at the "gaps-closed" milestone (all integrations given full read/write)._

## ✅ Fully working (live in production)

**Texting / UX**
- Two-way iMessage/SMS via Linq
- Multi-bubble replies (splits on blank lines), typing indicator, read receipts
- Debounce: waits ~6s of silence, coalesces rapid-fire texts into one reply (waitUntil background)
- Vision: reads photos/screenshots
- File ingestion: reads `.md/.txt/.csv/json` attachments

**Brain / memory**
- Editable memory: facts (add/edit/forget), goals, playbooks (learn workflows by text)
- Task-routing guidance (TickTick vs Notion MASTER PLANNER vs short-term)
- Verified-writes, backbone, "say limits once" — all in `lib/persona.ts`
- Memory dashboard at `/dashboard` (view/edit facts, goals, playbooks, reminders, settings, integrations)

**Integrations (all with their own OAuth/token; verified read-back on writes)**
- **TickTick** — create (into a named list), read (today/week/all + overdue + undated backlog),
  complete, update (reschedule/rename/reprioritize/**move between lists**), delete, list projects
- **Notion** — search all, read any page, query any db, create row in any db (schema-aware → health_mood),
  append to any page, Master Planner create/list
- **Gmail** (both inboxes: jonnyearl + jonathanmurao) — search, **send**, **draft**
- **Google Calendar** — list upcoming, create, update/reschedule/move, delete
- **Google Drive** — search + read file contents (Docs export + text)
- **Maps** — live traffic drive time
- **Location (manual)** — save named places (home/gym/work), set current location by text, drive-time origins

**Cost / observability**
- **Prompt caching (LIVE, verified in prod)** — system prompt is stability-ordered blocks in
  `lib/persona.ts` (frozen persona → memory → volatile time LAST); `think()` adds a cache
  breakpoint on the last message each tool-loop turn (`withCacheMarker` in `lib/brain.ts`).
  One cold call measured: cache_write 7,837 / input 2. Warm reads bill ~0.1×; 5-min TTL,
  refreshed by every read. RULE: keep the persona blocks byte-stable and never put dynamic
  content (time, IDs) before them — that silently kills the cache.
- **usage_log table (Supabase)** — every Anthropic call writes fn/turn/model/input/cache_read/
  cache_write/output (fire-and-forget from `logUsage` in `lib/brain.ts`). Query it to verify
  cache hits and compute spend. `composeProactive` is intentionally uncached (no tools in prefix).

**Reliability layer (durable queue — shipped 2026-07-06, verify in prod after merge)**
- `lib/queue.ts` wires up the `jobs` table that had sat unused since the original schema:
  atomic claim (overlap-safe), retry with exponential backoff (2→60 min), dead-letter after
  max_attempts (kept inspectable), `dedupe_key` exactly-once, stuck-`running` reaper, prune.
- `runTick` takes a 5-min lease (`tick_lease` dedupe row) → overlapping cron fires can't
  double-run the engine. Brief/check-in/automations are enqueued with `brief-{user}-{date}`-style
  dedupe keys (exactly once per day by construction), then executed by `JOB_HANDLERS` with retries —
  a flaky Linq call no longer costs the whole brief. Reminders claim their row (scheduled→sending)
  and revert on failure. A totally-failed webhook reply re-enqueues as `send_message` (durable send).
- `lib/audit.ts` wires up the previously-unused `write_audits` ledger: every external write
  (TickTick/Notion/Gmail/GCal) records requested payload + read-back verified flag.
- POST-DEPLOY VERIFY: `GET /api/linq/webhook` → rev `durable-queue-v5`; watch a real tick land
  one `tick_lease` done-row per window in `jobs`; `?force=jobs` to drain on demand; confirm
  `write_audits` rows appear after her next external write.

**Proactive engine** (`/api/cron/tick`, driven by GitHub 15-min pinger + daily Vercel cron)
- ⚠️ HISTORY (2026-07-06): the engine was DEAD until this date — the 15-min GitHub cron only runs
  from `main`, and the code only reached `main` the morning of 07-06. First real brief sent 07-06.
  Three bugs found+fixed in the shakeout: (1) composeProactive could burn its whole max_tokens on
  adaptive thinking and text a bare "…" — thinking now disabled there, budgets raised; (2) TickTick
  reads dropped `startDate`, so time blocks were reported by their END time — start/isAllDay now
  exposed and briefs render "from X until Y"; (3) 8 duplicate past-event tasks deleted from TickTick.
  Watch: GitHub cron is best-effort — if ticks prove flaky, move to Supabase pg_cron hitting the
  tick URL (needs the Vercel bypass secret from jonny once).
- Due reminders + "leave now" (with drive time)
- Morning brief (TickTick + Notion + Calendar + unread email)
- First-days learning + evening check-in
- User-defined automations (`create_automation` → scheduled, runs full tool loop)

## ⚠️ Partial / not enforced
- **Signature verification** — `verifyLinq` (Svix/whsec_) built but **log-only**; set `LINQ_ENFORCE_SIG=1`
  once confirmed against a real Linq signature header.
- **Behavioral adaptation** — `behavior_log` table is written by reminders, but nudge timing does NOT
  yet adapt to it. (Roadmap.)
- **Automations moving to Notion mirror DBs** — jonny's TICKTICK HQ page forbids writing automations
  to the Notion mirror dbs (native sync owns them); routine tasks must be created in TickTick natively.

## 🔴 Blocked (external, not code)
- **Linq live auto-location** — `location.sharing` events return entitlement error 2011 (sandbox tier).
  DB tables + the plan exist; needs Linq to enable it. Manual location works meanwhile.

## ❌ Not built
- **Calendly, Box** integrations (accounts connected, no client built)
- ~~**Voice-note transcription**~~ — ✅ CODE DONE (`lib/integrations/transcribe.ts`): Linq audio media
  part → Deepgram nova-2 → transcript into `think()`, treated as what he said. **Needs one thing from
  jonny to switch on: a `DEEPGRAM_API_KEY` in Vercel env.** No key = voice memos fall back to the
  "couldn't open it" path (nothing breaks). Swap provider (OpenAI/Groq Whisper) is a ~10-line edit.
- **Group chats** (Linq supports them; single-recipient today)

**Subagents / capability fleet** (`lib/subagents.ts`)
- Orchestrator + specialists: the main brain uses the `delegate` tool to hand a focused sub-task to a
  worker scoped to ONE domain's tools (email / calendar / notion / tasks / research / memory) with a tight
  brief; it verifies its own writes and returns a short result. Keeps the main context lean and lets her
  fan out across independent domains. Main brain still has all tools for simple one-step work.
- **research** = web search (Anthropic server tool `web_search_20260209`, in `TOOLS` + the research domain).
- **memory_query** = `recall` tool → `searchMemory()` over the full messages table + facts (not just the
  ~20-msg window). Tradeoff: each delegated specialist is another model call (a bit more latency on complex
  tasks) in exchange for focus + parallelism + context hygiene.
- **User-defined subagents** (`subagents` table): jonny builds his own specialists BY TEXT —
  `create_subagent` (name + brief + allowed tool names, validated against the real tool set),
  `list_subagents`, `delete_subagent`. `runSubagent` falls back to a DB lookup for any non-built-in
  domain; custom specialists are injected into the system prompt so she knows her fleet. "as many as
  you want, no deploy."

## 🗺️ Recommended roadmap (priority order)

1. ~~**Prompt caching**~~ — ✅ DONE (see Cost/observability above).
   ~~Follow-on: Haiku for simple turns~~ — ✅ DONE. `lib/triage.ts` `quickTriage()` runs a cheap
   Haiku classify-or-reply on every inbound BEFORE `think()`: pure social chatter (gn/thanks/banter)
   gets a fast direct reply; anything substantive or any media falls through to the full Sonnet loop
   unchanged. Routes whole turns (caches are per-model), fail-safe to `full` on any error/ambiguity,
   cache-safe (separate model + prompt, never touches the persona/TOOLS prefix). Opt out per-user via
   `settings.triage_disabled`. Model from `LEXA_TRIAGE_MODEL` (default claude-haiku-4-5). Verify the
   split in `usage_log` (`fn='triage'` rows vs `fn='think'`).
2. ~~**Spend awareness**~~ — ✅ DONE (rollups). `lib/spend.ts` `computeSpend()` dollarizes `usage_log`
   (per-model rates: sonnet-5 $3/$15, haiku $1/$5 per 1M; cache_read 0.1×, cache_write 1.25×) behind the
   `spend_report` tool (period today|week|month|all, breakdown by fn). Estimate only — she says "~".
   Follow-on still open: proactive warn / optional monthly ceiling.
3. **Behavioral adaptation (wire it up)** — use `behavior_log` to learn jonny's procrastination pattern
   and nudge earlier for tasks he tends to skip. Highest-value "for him" feature.
4. ~~**Commitment follow-through**~~ — ✅ DONE. lexa catches "i'll do X later" via the `track_commitment`
   tool (persona-driven in `think()`), stores it in the `commitments` table, and `dispatchDueCommitments`
   (in `runTick`) follows up when `follow_up_at` passes — one nudge, then marks 'nudged' (never nags again).
   His reply resolves it kept/missed via `resolve_commitment`, logged to `behavior_log` (feeds #3 next).
5. **Weekly review / time-block the backlog** — ✅ DONE (combined). `runWeeklyPlanning` (in `runTick`,
   Sunday eve, `planning_hour`/`planning_weekday` settings, dedupe `weekly-<user>-<date>`) surfaces
   overdue + undated backlog by project + calendar, and offers to time-block the 2-3 that matter RIGHT
   THEN. Writes only after he okays (persona rule: ticktick_update due dates / gcal_create blocks,
   verified). On demand: `?force=planning`. Backlog reads via `buildBacklogContext`.
7. **Vision workflows** — food pic → macros into Notion; screenshot → extract event/task → set it.
8. ~~**Tone tuning**~~ — ✅ DONE. jonny picked **warm & hype**. `LEXA_IDENTITY` voice retuned: warm,
   encouraging, celebrates real wins, light emoji — but NOT try-hard gen-z slang (he disliked that),
   and warm ≠ pushover (backbone preserved). Easy to nudge further (less emoji / more/less hype).
9. Voice notes, group chats, Calendly/Box — as desired.

## Security follow-ups
- Rotate keys that were pasted in the original build chat: Anthropic, Linq, Vercel token.
- Enforce `verifyLinq` once the real Linq signature scheme is confirmed.
