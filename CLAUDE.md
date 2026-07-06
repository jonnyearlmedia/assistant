# CLAUDE.md — lexa

> Read this first. It's the single source of truth for what lexa is, how she's wired, and how to
> keep building her. Any AI or session should be able to continue from here with zero prior context.
> Full capability inventory + roadmap live in **docs/STATUS.md**. Original vision in **SPEC.md**.

## What lexa is

**lexa** ("lex") is jonny's personal AI assistant that lives in his **text messages** (iMessage/SMS
via the Linq API). Think "Tomo/Poke, but with a spine." She's deployed and **live** — jonny texts a
real phone number and she replies, remembers, acts on his tools, and reaches out proactively.

- **Persona:** a girl, she/her. "accountability homie." lowercase gen-z, warm but has a backbone.
  (tone is being tuned — jonny wasn't sold on the heavy gen-z voice; see STATUS roadmap.)
- **Three pillars** (all enforced in `lib/persona.ts`):
  1. **Verified writes** — never says "done" until it reads the record back and confirms it landed.
  2. **Editable memory** — everything she knows is in Postgres, editable by text or dashboard.
  3. **Backbone** — no reflexive apologizing/caving; holds her ground with evidence when she's right.

## Architecture (data flow)

```
 jonny's phone (iMessage/SMS)
      ⇅  Linq Partner API v3   (transport: send + inbound webhook)
 [ /api/linq/webhook ]  ← Linq POSTs incoming texts here (debounced, then replies)
      ↓
 [ lib/brain.ts ]  Anthropic tool-use loop (model = claude-sonnet-5)
      ↓ calls tools (lib/tools.ts → dispatch)
 ┌───────────────┬─────────────────────┬──────────────────┐
 [ memory ]       [ integrations ]       [ proactive engine ]
 Supabase         TickTick / Notion /    /api/cron/tick
 (lib/memory.ts)  Gmail×2 / GCal /       (lib/proactive.ts)
                  Drive / Maps           reminders, brief, checkin, automations
```

- **Runtime:** Next.js (App Router, Node runtime) on **Vercel**. Webhook + cron are API routes.
- **Brain:** Anthropic API (`@anthropic-ai/sdk`), model from `LEXA_MODEL` (claude-sonnet-5).
- **Memory/DB:** Supabase Postgres. Schema mirrored in `db/schema.sql`.
- **Transport:** Linq Partner API v3 (`https://api.linqapp.com/api/partner/v3`).
- **Proactivity trigger:** free GitHub Actions cron (`.github/workflows/lexa-tick.yml`, every 15 min)
  pings `/api/cron/tick` — because Vercel Hobby only allows one cron/day. Also a daily Vercel cron.

## Repo map

```
app/
  api/linq/webhook/route.ts   inbound texts: verify → debounce (waitUntil) → think → bubble replies
  api/cron/tick/route.ts      proactive heartbeat (runTick); ?force=brief|checkin to fire on demand
  api/connect/{ticktick,google,google2}[/callback]/route.ts   OAuth connect flows
  api/dashboard/route.ts      dashboard mutations (owner-only via Vercel Auth)
  dashboard/page.tsx          memory dashboard (view/edit facts, goals, playbooks, reminders, settings)
  page.tsx, layout.tsx        landing shell
lib/
  persona.ts      system prompt (identity + 3 pillars + texting style + routing + proactive learning)
  brain.ts        think() tool-use loop + composeProactive() (proactive voice) + vision/file ingestion
  tools.ts        ALL tool definitions + dispatch() switch  ← add new capabilities here
  memory.ts       Supabase memory ops (facts, goals, playbooks, reminders, places, message log, debounce)
  db.ts           lazy Supabase client + resolveUser + User type
  linq.ts         Linq transport: sendMessage, startTyping, markRead, verifyLinq, parseInbound, fetchMedia/TextAttachment
  send.ts         shared "text like a person" bubble sender (split + typing + human delay)
  proactive.ts    dispatchDueReminders, runDailyBrief, proactiveCheckin, runAutomations, runTick
  integrations/
    tokens.ts     owner resolution + OAuth token storage (integrations table)
    ticktick.ts   OAuth + full CRUD (create/list/complete/update-move/delete) verified read-back
    notion.ts     search/read/query any db + create page in any db (schema-aware) + append + Master Planner
    google.ts     Gmail search/send/draft, Calendar upcoming/create/update/delete, Drive search/read (2 gmail slots)
    maps.ts       Google Routes drive time
db/schema.sql     Postgres schema (reference; source of truth is the live Supabase project)
vercel.json       framework=nextjs + daily cron (0 15 * * * = 8am Pacific)
.github/workflows/lexa-tick.yml   15-min proactive pinger (needs LEXA_TICK_URL repo secret)
```

## Infra & IDs (values that aren't secrets)

- **GitHub:** `jonnyearlmedia/assistant`. Default branch `main` (Vercel deploys it; GitHub cron runs from it).
- **Vercel:** project `text-assistant`, team `jonny-3061's projects` (`team_5gDdDjzBZDZ2GgPWCCeVAEFM`),
  project id `prj_3R1LVrivwGd4Uc85dojUPxWbzLt0`. Deployment Protection is ON (all `.vercel.app` URLs),
  so webhook/cron URLs carry a `?x-vercel-protection-bypass=<secret>` query param.
- **Supabase:** project ref `tucemplfksloosrnhywt` (org `jonny-os`). Tables in `db/schema.sql`.
- **Linq:** phone line `+1 321-297-3385`. Webhook subscription id `f56bb81a-b64f-45ba-a4b2-acc1ec502571`
  (events: `message.received`; target = the **production** webhook URL `text-assistant-jonny-3061s-projects.vercel.app/api/linq/webhook`
  incl. the Vercel bypass secret). The old branch-preview subscription was deleted, so no code lives on a
  feature-branch URL anymore — everything runs off the production deployment of `main`.
- **Owner (jonny's cell):** `+1 707-319-8190`. Timezone: `America/Los_Angeles`.

## Secrets (names only — VALUES live in Vercel env, never in this repo)

Set in Vercel project env (Settings → Environment Variables), for Production + Preview:
`ANTHROPIC_API_KEY`, `LEXA_MODEL`, `LINQ_API_KEY`, `LEXA_PHONE_NUMBER`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` (currently holds the Supabase publishable key), `CRON_SECRET`,
`OWNER_PHONE`, `APP_BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_MAPS_API_KEY`,
`TICKTICK_CLIENT_ID`, `TICKTICK_CLIENT_SECRET`, `LINQ_WEBHOOK_SECRET`.
Optional: `LINQ_ENFORCE_SIG=1` (enforce webhook sig), `SETTLE_MS` (debounce window).
GitHub repo secret: `LEXA_TICK_URL` (full /api/cron/tick URL incl. bypass + cron key) for the pinger.

A session that needs to hit protected endpoints via curl gets the bypass/cron values from Vercel env
or from jonny — they are intentionally NOT committed. Most dev needs only git + the connected MCPs.

## Dev / deploy / verify workflow

1. **Develop:** make changes. Add new capabilities as a client method in `lib/integrations/*` +
   a tool in `lib/tools.ts` (TOOLS array) + a `dispatch()` case. Keep the verified-write pattern.
2. **Deploy:** commit and push to `main` → Vercel auto-deploys to production. (Or push a branch for a
   preview deploy + PR.) There's no manual deploy step; git integration handles it.
3. **Verify (don't trust, check):**
   - Health/rev marker: `GET /api/linq/webhook` returns `{rev: "..."}` — bump the `rev` string in that
     route on a deploy so you can confirm the new build is live.
   - Fire proactive on demand: `GET /api/cron/tick?force=brief` (or `force=checkin`) with the bypass + key.
   - Inspect behavior: query the Supabase `messages` table (via the Supabase MCP) to see what she
     actually sent — do this instead of assuming a reply worked.
   - Simulate an inbound: POST a `message.received` payload to the webhook (see `parseInbound` shape).

## Known gotchas / limitations (see docs/STATUS.md for the full list)

- **Vercel Hobby = 1 cron/day** → real proactivity relies on the GitHub Actions 15-min pinger, which
  **only runs from the default branch (`main`)** and is GitHub-"best-effort" (can be minutes late).
- **Supabase free tier pauses after ~7 days of inactivity** → she'd lose memory until unpaused.
- **Signature verification (`verifyLinq`) is log-only** unless `LINQ_ENFORCE_SIG=1`. Endpoints are
  gated by the bypass secret; if that leaks, spoofed inbound is possible.
- **Linq live location is blocked** (account entitlement error 2011); manual location works.
- **No prompt caching yet** → cost is a few cents to ~20¢/message; caching the static system+tools
  prompt would cut it 3–5x. (Top roadmap item.)
- Cost is on jonny's Anthropic key, pay-per-use, no cap.

## House rules for editing lexa

- Match the existing patterns; don't re-architect. New tools → `lib/tools.ts`. New service → new file
  in `lib/integrations/`.
- Every external write must **read back and confirm** before reporting success (the #1 pillar).
- Keep her replies short and human — the webhook splits on blank lines into bubbles with typing delays.
- When she can't do something, she says it ONCE briefly + offers the next step (no apology spirals).
- Test against the live deploy + the `messages` table; never claim it works without checking.
