# lexa

**lexa** ("lex") is a personal AI assistant that lives in your **text messages** — she remembers your
goals, manages your real tools (TickTick, Notion, Gmail, Calendar, Drive), holds you accountable, and
reaches out proactively. Built over the Linq iMessage/SMS API, with a Claude brain and Postgres memory.
"Tomo/Poke, but with a spine": she never fakes a completion, her memory is editable, and she has a backbone.

## Docs (read these to work on her)

- **[CLAUDE.md](./CLAUDE.md)** — architecture, repo map, infra, env vars, dev/deploy/verify, house rules.
- **[docs/STATUS.md](./docs/STATUS.md)** — full capability inventory + roadmap.
- **[SPEC.md](./SPEC.md)** — original product vision.

## Stack

Next.js (App Router) on Vercel · Supabase Postgres · Anthropic API · Linq Partner API v3 (iMessage/SMS)
· proactive engine via GitHub Actions cron.

## Run / deploy

Deploy is automatic: **push to `main`** and Vercel builds + ships it. Environment variables live in the
Vercel project (`text-assistant`) — see `.env.example` for the full list of names. Local type-check/build:

```bash
npm install
npm run build
```

## Layout

- `app/api/linq/webhook` — inbound texts → debounce → brain → bubble replies
- `app/api/cron/tick` — proactive engine heartbeat
- `app/dashboard` — memory dashboard
- `lib/` — brain, persona, tools, memory, transport, integrations
- `db/schema.sql` — database schema reference
