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
- **Voice-note transcription** (if Linq delivers audio parts)
- **Group chats** (Linq supports them; single-recipient today)

## 🗺️ Recommended roadmap (priority order)

1. ~~**Prompt caching**~~ — ✅ DONE (see Cost/observability above). Follow-on: consider Haiku for
   simple turns (design around the cache — caches are per-model, so route whole turns, not mid-loop).
2. **Spend awareness / cap** — `usage_log` table already records per-call tokens; build on it:
   cost rollups, warn jonny, optional monthly ceiling.
3. **Behavioral adaptation (wire it up)** — use `behavior_log` to learn jonny's procrastination pattern
   and nudge earlier for tasks he tends to skip. Highest-value "for him" feature.
4. **Commitment follow-through** — detect "I'll do X later" in chat, store it, follow up proactively.
5. **Weekly review** — Sunday-night automation: what got done/slipped, plan the week from TickTick/Notion.
6. **Time-block the backlog** — proactively propose dates/calendar blocks for his pile of undated TickTick tasks.
7. **Vision workflows** — food pic → macros into Notion; screenshot → extract event/task → set it.
8. **Tone tuning** — jonny wasn't sold on heavy gen-z. Options offered: clean&natural / warm&hype /
   dry&minimal / sharp-no-BS coach. Awaiting his pick; then retune `lib/persona.ts`.
9. Voice notes, group chats, Calendly/Box — as desired.

## Security follow-ups
- Rotate keys that were pasted in the original build chat: Anthropic, Linq, Vercel token.
- Enforce `verifyLinq` once the real Linq signature scheme is confirmed.
