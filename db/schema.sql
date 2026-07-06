-- lexa memory schema
-- the editable-memory + verified-write backbone. everything lexa "knows" lives here,
-- and all of it is inspectable/editable (by text or dashboard). nothing hidden, nothing locked.

create extension if not exists "pgcrypto";

-- the human
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  phone         text unique not null,              -- E.164, the Linq line's counterparty
  name          text,
  timezone      text default 'America/New_York',
  home_address  text,                              -- for drive-time "leave now" reminders
  settings      jsonb not null default '{}',       -- brief time, quiet hours, proactivity level
  onboarding_stage text default 'discovery',       -- drives the first-days proactive-learning loop
  created_at    timestamptz not null default now()
);

-- editable memory: discrete facts lexa has learned. "lexa forget that" deletes a row.
create table if not exists facts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  category    text not null default 'general',     -- routine | preference | person | health | work | ...
  key         text not null,
  value       text not null,
  source      text default 'conversation',         -- how she learned it (auditable)
  confidence  real default 0.8,
  pinned      boolean default false,               -- pinned facts never auto-expire
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  unique (user_id, category, key)
);

-- goals she holds you accountable to
create table if not exists goals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  title       text not null,
  detail      text,
  status      text not null default 'active',      -- active | paused | done | dropped
  cadence     text,                                -- how often to check in
  created_at  timestamptz not null default now()
);

-- conversationally-taught workflows & strict formats (e.g. the health_mood log format).
-- this is how lexa "learns new behavior by text" without a redeploy.
create table if not exists playbooks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null,
  trigger      text,                               -- when to run it (natural language or cron-ish)
  instructions text not null,                      -- what to do, in lexa's own words
  format       jsonb,                              -- strict schema for structured logs (notion db fields)
  target       jsonb,                              -- where it writes (e.g. notion page/db id)
  active       boolean default true,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (user_id, name)
);

-- reminders / nudges, incl. "get ready" + "leave now" with drive time
create table if not exists reminders (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  title          text not null,
  body           text,
  due_at         timestamptz not null,
  lead_time_min  int default 0,                    -- fire this many minutes before due_at
  location       text,                             -- destination for drive-time math
  recurrence     text,                             -- rrule-ish, null = one-shot
  status         text not null default 'scheduled',-- scheduled | sent | done | cancelled
  ticktick_id    text,                             -- link back to source of truth if applicable
  created_at     timestamptz not null default now()
);

-- behavioral adaptation: models your procrastination so nudges land at the right time
create table if not exists behavior_log (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  event_type   text not null,                      -- nudged | completed | snoozed | ignored | left_late
  ref          text,                               -- reminder/task id
  scheduled_at timestamptz,
  acted_at     timestamptz,
  delay_min    int,                                -- + = late, - = early
  meta         jsonb not null default '{}',
  created_at   timestamptz not null default now()
);

-- full conversation history + delivery tracking (reliability, not a black box)
create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references users(id) on delete cascade,
  direction       text not null,                   -- inbound | outbound
  channel         text default 'imessage',         -- imessage | rcs | sms
  body            text,
  media           jsonb,                            -- attachments (food pics, screenshots)
  linq_message_id text,
  status          text default 'received',         -- received | queued | sent | delivered | read | failed
  created_at      timestamptz not null default now()
);

-- outbound job queue with retries + dead-letter. this is what kills Tomo's flaky delivery.
create table if not exists jobs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references users(id) on delete cascade,
  kind        text not null,                       -- send_message | morning_brief | reminder | learn_tick
  run_at      timestamptz not null default now(),
  payload     jsonb not null default '{}',
  status      text not null default 'pending',     -- pending | running | done | failed | dead
  attempts    int not null default 0,
  max_attempts int not null default 5,
  last_error  text,
  created_at  timestamptz not null default now()
);

-- per-service standalone credentials (each integration auths on its own, not via this chat)
create table if not exists integrations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  provider      text not null,                     -- ticktick | notion | google | maps
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  scope         text,
  meta          jsonb not null default '{}',
  status        text default 'disconnected',       -- connected | disconnected | error
  updated_at    timestamptz not null default now(),
  unique (user_id, provider)
);

-- the verified-write ledger. lexa records every external write + whether she read it back
-- and confirmed it landed. she is NOT allowed to tell you "done" unless verified = true here.
create table if not exists write_audits (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references users(id) on delete cascade,
  provider     text not null,                      -- notion | ticktick | gmail
  action       text not null,                      -- e.g. log_mood | move_task | send_email
  target_ref   text,                               -- the record id we wrote/expected
  requested    jsonb,                              -- what we asked to write
  verified     boolean default false,              -- did read-back confirm it?
  verify_detail text,                              -- what we saw on read-back
  created_at   timestamptz not null default now()
);

create index if not exists idx_facts_user on facts(user_id);
create index if not exists idx_reminders_due on reminders(status, due_at);
create index if not exists idx_jobs_runnable on jobs(status, run_at);
create index if not exists idx_messages_user_time on messages(user_id, created_at desc);
create index if not exists idx_behavior_user on behavior_log(user_id, created_at desc);

-- per-API-call token accounting (written by lib/brain.ts logUsage). proves prompt-cache hits
-- and feeds spend awareness: cost ≈ input*full + cache_read*0.1x + cache_write*1.25x + output.
create table if not exists usage_log (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  fn           text not null,                      -- think | proactive
  turn         int not null default 0,             -- tool-loop turn within one think()
  model        text,
  input        int not null default 0,             -- uncached input tokens (full price)
  cache_read   int not null default 0,             -- tokens served from cache (~0.1x)
  cache_write  int not null default 0,             -- tokens written to cache (~1.25x)
  output       int not null default 0
);

create index if not exists usage_log_created_at_idx on usage_log (created_at desc);
