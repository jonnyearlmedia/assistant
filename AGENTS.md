# AGENTS.md

This project (**lexa** — a personal AI assistant that lives in text messages) is documented for AI
agents in **[CLAUDE.md](./CLAUDE.md)**. Read that first — it has the architecture, repo map, infra
IDs, env vars, dev/deploy/verify workflow, gotchas, and house rules.

Full capability inventory + roadmap: **[docs/STATUS.md](./docs/STATUS.md)**.
Original product vision: **[SPEC.md](./SPEC.md)**.

Quick orientation for any agent:
- **Stack:** Next.js (App Router) on Vercel · Supabase Postgres · Anthropic API brain · Linq iMessage/SMS API.
- **Deploy:** push to `main` → Vercel auto-deploys. No manual deploy step.
- **Add a capability:** client method in `lib/integrations/*` → tool in `lib/tools.ts` (TOOLS + dispatch).
- **Non-negotiable:** external writes must read back and confirm before reporting success.
- **Secrets** live in Vercel env, not the repo. Ask the owner (jonny) or read them from Vercel if you
  need to hit protected endpoints.
- **Verify** every change against the live deploy and the Supabase `messages` table — don't assume.
