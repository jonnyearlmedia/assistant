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

**Proactive engine** (`/api/cron/tick`, driven by GitHub 15-min pinger + daily Vercel cron)
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
- **Voice-note transcription** (if Linq delivers audio parts)
- **Group chats** (Linq supports them; single-recipient today)

## 🚨 ASAP / core reliability backlog

These are the only items that should interrupt normal "teach lexa new workflows" work. They protect
the core promise and operating cost.

1. **Verified-write audit + fixes** — audit every external write path and make sure it reads back or
   otherwise confirms the real external record before returning success. Start with:
   - `lib/integrations/ticktick.ts`: `completeTask`, `deleteTask`, `updateTask`
   - `lib/integrations/google.ts`: `gmailSend`, `gmailDraft`, `calendarUpdate`, `calendarDelete`
   - `lib/integrations/notion.ts`: `appendText`, generic create/read-back detail
   - `lib/tools.ts`: make tool results honestly expose `verified:false` or failure when read-back fails
   Acceptance: lexa never says "done" for TickTick/Notion/Gmail/Calendar writes unless the integration
   read-back/verification step proves it landed. If verification is impossible for an API action,
   return that explicitly and phrase the user reply as unverified.
2. **Spend/cache visibility** — build a tiny dashboard/API readout from `usage_log` for daily tokens,
   estimated spend, cache hit rate, and recent `cache_read`/`cache_write` values. Acceptance:
   jonny can quickly see whether prompt caching is warm (`cache_read` ~7k+ on repeated `think()` calls)
   and whether any change has unexpectedly raised cost.

Cache warning for agents: do not casually edit `lib/persona.ts`, `TOOLS` order/schemas in `lib/tools.ts`,
or the system/message cache structure in `lib/brain.ts` while doing these items. Changes before cache
breakpoints can invalidate Anthropic prompt caching and multiply costs.

## 🗺️ Agent to-do backlog / recommended roadmap

Use this as the general backlog for Codex/Claude sessions. Security cleanup is intentionally not
included here for now per jonny; keep the security notes below separate.

### Need / core
1. ~~**Prompt caching**~~ — ✅ DONE (see Cost/observability above). Follow-on: consider Haiku for
   simple turns only if the routing design preserves cache economics; caches are per-model, so route
   whole turns, not mid-loop.
2. **Verified-write reliability** — keep this as priority zero whenever touching integrations. Every
   external write should read back or otherwise verify the real record before lexa says it is done.
   See the ASAP backlog above for concrete audit targets.
3. **Cost + cache dashboard** — `usage_log` already records per-call tokens; build a small dashboard/API
   view for daily spend, cache hit rate, warm/cold calls, and warnings if `cache_read` drops unexpectedly.
4. **Better failure visibility** — add an operator-facing view/log for failed proactive sends, cron/tick
   misses, integration write failures, Supabase errors, and recent tool-call failures. Goal: fewer silent
   weird states when lexa appears to have gone quiet.

### Highest-value features
1. **Commitment follow-through** — detect "I'll do X later" / "remind me to actually..." / soft promises
   in chat, store them, and follow up proactively. This is core to the accountability-homie product.
2. **Behavior-aware nudges** — wire `behavior_log` into reminder timing so lexa learns patterns like
   "jonny skips gym when nudged at night" and moves nudges earlier or changes framing.
3. **Scheduler manual execution** — Jonny's attached scheduler manuals were imported into live Supabase
   memory on 2026-07-06 as pinned facts, saved places, and 9 active playbooks (`scheduler_*`,
   `ticktick_project_routing`, `daily_routine_guardrails`, `travel_and_event_blocks`,
   `school_math_182_assignments`, `vph_client_workflow`, `completion_and_cleanup_rules`). Next step:
   make the tools/dashboard fully support editing and executing those rules.
4. **Weekly review** — Sunday-night recap: what got done, what slipped, what's coming, what should move
   into TickTick/Notion, and one concrete plan for the week.
5. **Backlog time-blocking** — read TickTick/Notion backlog and propose calendar blocks or dated TickTick
   tasks for undated work instead of letting the backlog sit as a pile.
6. **Tone tuning** — pick the durable lexa voice and update carefully. Options previously discussed:
   clean&natural / warm&hype / dry&minimal / sharp-no-BS coach. Because persona text is cache-sensitive,
   flag cache impact before editing `lib/persona.ts`.

### Likely nice-to-have features
1. **Screenshot → task/event extraction** — parse screenshots into tasks, calendar events, or Notion logs
   and ask for confirmation before writing.
2. **Food/health vision workflows** — food photo → macros/meal note/mood or health log into Notion using
   the learned tracker schema.
3. **Voice notes** — if Linq delivers audio parts, transcribe and route the content through the normal
   tool loop so voice messages can create tasks, notes, reminders, or summaries.
4. **Memory/playbook transparency** — improve "what are you tracking about me?" and dashboard cleanup so
   jonny can quickly inspect, edit, or delete facts/playbooks without code.
5. **Better memory/playbook editor** — make teaching lexa workflows easier: structured playbook editor,
   target selection, test-run button, and clear active/inactive controls.
6. **Group chats** — add when jonny wants lexa involved with other people; lower priority than private
   accountability unless a real use case appears.
7. **Calendly / Box** — build only if they become part of jonny's actual daily workflow; accounts may be
   connected, but they are not worth prioritizing over accountability features yet.

### Build / infrastructure improvements
1. **Richer TickTick task fields** — the imported scheduler manual expects scheduled tasks with `projectId`,
   `startDate`, `dueDate`, `timeZone`, `isAllDay`, rich `content`, and reminders. Current `ticktick_create_task`
   / `ticktick_update` are simpler. Extend `lib/integrations/ticktick.ts` and `lib/tools.ts` only after
   flagging cache impact, then verify with live TickTick read-back.
2. **Dashboard workflow editor** — dashboard currently shows/deletes playbooks but cannot edit them. Add
   create/edit/pause controls for playbooks, facts, places, and scheduler settings so Jonny can maintain
   these rules without texting giant manuals or changing code.
3. **Real migrations** — introduce a migration workflow instead of relying only on `db/schema.sql`, so
   future schema changes are repeatable and auditable.
4. **Live smoke-test checklist** — document or script the post-deploy checks: health rev, webhook simulate,
   Supabase `messages`, Supabase `usage_log`, and one safe tool-loop path.
5. **Mocked integration tests** — add tests around write verification semantics for TickTick/Notion/Gmail/
   Calendar so regressions cannot reintroduce phantom "done" replies.
6. **Admin/operator dashboard panels** — add panels for `messages`, `usage_log`, failed sends, recent tool
   calls, recent proactive ticks, and failed integration operations.

## Security follow-ups
- Rotate keys that were pasted in the original build chat: Anthropic, Linq, Vercel token.
- Enforce `verifyLinq` once the real Linq signature scheme is confirmed.
