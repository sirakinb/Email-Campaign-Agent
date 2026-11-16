create extension if not exists pgcrypto;

-- Conversations ------------------------------------------------------------

create table threads (
  id              uuid primary key default gen_random_uuid(),
  title           text not null default 'New thread',
  status          text not null default 'open' check (status in ('open', 'settled')),
  hidden          boolean not null default false,
  series          text,
  sdk_session_id  text,
  created_via     text not null default 'chat' check (created_via in ('chat', 'text', 'email', 'automation')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  settled_at      timestamptz,
  last_message_at timestamptz not null default now()
);

create table messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references threads(id) on delete cascade,
  role        text not null check (role in ('user', 'agent', 'system')),
  channel     text not null default 'chat' check (channel in ('chat', 'text', 'email', 'automation')),
  body        text not null,
  meta        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index messages_thread_idx on messages (thread_id, created_at);

-- One row per visible step of agent activity (tool calls, searches, writes).
create table run_steps (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references threads(id) on delete cascade,
  job_id      uuid,
  label       text not null,
  detail      text,
  status      text not null default 'done' check (status in ('running', 'done', 'failed')),
  created_at  timestamptz not null default now()
);
create index run_steps_thread_idx on run_steps (thread_id, created_at);

-- Maps an outside conversation (an email thread, a text conversation) to ours.
create table channel_links (
  channel      text not null,
  external_id  text not null,
  thread_id    uuid not null references threads(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (channel, external_id)
);

-- Work queue between the switchboard and the agent's computer ----------------

create table agent_jobs (
  id           uuid primary key default gen_random_uuid(),
  thread_id    uuid not null references threads(id) on delete cascade,
  prompt       text not null,
  channel      text not null default 'chat',
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  error        text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
create index agent_jobs_queue_idx on agent_jobs (status, created_at);

-- Email drafts the agent writes; uploaded to Zoho Campaigns as drafts ---------

create table drafts (
  id                uuid primary key default gen_random_uuid(),
  thread_id         uuid references threads(id) on delete set null,
  name              text not null,
  subject           text not null,
  subject_b         text,
  preheader         text,
  html              text not null,
  listing_ids       jsonb not null default '[]',
  send_on           date,
  status            text not null default 'draft' check (status in ('draft', 'tested', 'uploaded')),
  zoho_campaign_id  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Guardrails and approvals ----------------------------------------------------

create table guardrails (
  action       text primary key,
  label        text not null,
  description  text not null,
  level        text not null check (level in ('draft_only', 'approve_first', 'autonomous')),
  locked       boolean not null default false,
  position     int not null default 0
);

create table approvals (
  id           uuid primary key default gen_random_uuid(),
  thread_id    uuid references threads(id) on delete set null,
  action       text not null references guardrails(action),
  title        text not null,
  summary      text not null default '',
  payload      jsonb not null default '{}',
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'done', 'failed')),
  result       jsonb,
  decided_via  text,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);
create index approvals_status_idx on approvals (status, created_at);

-- Memory the agent keeps between threads -------------------------------------

create table memories (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  body              text not null,
  source_thread_id  uuid references threads(id) on delete set null,
  created_at        timestamptz not null default now()
);

-- Scheduled work --------------------------------------------------------------

create table automations (
  id           text primary key,
  label        text not null,
  description  text not null,
  cron         text not null,
  kind         text not null check (kind in ('sync', 'prompt')),
  prompt       text,
  enabled      boolean not null default true,
  last_run_at  timestamptz,
  last_status  text,
  position     int not null default 0
);

-- Outside services ------------------------------------------------------------

create table connections (
  id          text primary key,
  label       text not null,
  detail      text not null default '',
  status      text not null default 'not_connected' check (status in ('connected', 'not_connected', 'error')),
  secrets     jsonb not null default '{}',
  checked_at  timestamptz,
  position    int not null default 0
);

create table settings (
  key    text primary key,
  value  jsonb not null
);

-- Synced copy of the systems of record ---------------------------------------
-- Filled by the dlt pipeline in /pipelines. Zoho stays the source of truth.

create table zoho_campaigns (
  id            text primary key,
  name          text not null,
  status        text not null,
  type          text,
  subject       text,
  preheader     text,
  sender_email  text,
  sender_name   text,
  list_ids      jsonb not null default '[]',
  list_names    jsonb not null default '[]',
  topic_id      text,
  topic_name    text,
  created_at    timestamptz,
  updated_at    timestamptz,
  -- parsed from the name: "2026-11-06 Fall 2026 Email 9 North Philly Combined"
  send_date     date,
  series        text,
  email_number  int,
  theme         text,
  synced_at     timestamptz not null default now()
);
create index zoho_campaigns_date_idx on zoho_campaigns (send_date desc nulls last);

create table zoho_reports (
  campaign_id     text primary key references zoho_campaigns(id) on delete cascade,
  sent            int not null default 0,
  opens           int not null default 0,          -- unique opens, all kinds
  opens_reliable  int,                             -- opens by a person, not Apple Mail privacy or bots
  opens_mpp       int,                             -- Apple Mail automatic opens
  opens_bot       int,
  clicks          int not null default 0,          -- unique clicks
  clicks_bot      int,
  hard_bounced    int not null default 0,
  soft_bounced    int not null default 0,
  optout          int not null default 0,
  spam            int not null default 0,
  detailed        boolean not null default false,  -- false when only the list summary is known
  synced_at       timestamptz not null default now()
);

create table zoho_links (
  campaign_id    text not null references zoho_campaigns(id) on delete cascade,
  link_id        text not null,
  url            text not null,
  unique_clicks  int not null default 0,
  primary key (campaign_id, link_id)
);

create table zoho_lists (
  id            text primary key,
  name          text not null,
  active        int,
  bounced       int,
  unsubscribed  int,
  synced_at     timestamptz not null default now()
);

create table listings (
  id            text primary key,           -- AppFolio listing uuid
  url           text not null,
  address       text not null,
  city          text,
  neighborhood  text,
  rent          int,
  rent_text     text,
  beds          numeric,
  baths         numeric,
  sqft          int,
  available     text,
  title         text,
  description   text,
  pets          text,
  photo_url     text,
  tour_url      text,
  flags         jsonb not null default '[]', -- things that look inconsistent on the page
  active        boolean not null default true,
  first_seen_at timestamptz not null default now(),
  synced_at     timestamptz not null default now()
);

create table sync_runs (
  id           uuid primary key default gen_random_uuid(),
  source       text not null,
  status       text not null,
  detail       text,
  rows         int,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

-- Defaults --------------------------------------------------------------------

insert into guardrails (action, label, description, level, locked, position) values
  ('plan',            'Plan sends and write briefs',     'Propose what to send next and why.',                                           'autonomous',    false, 1),
  ('write_draft',     'Write email drafts',              'Write subject lines and email content here, in the command center.',           'autonomous',    false, 2),
  ('send_test',       'Send test emails to you',         'Send a draft from the agent''s address to your inbox so you can read it.',     'autonomous',    false, 3),
  ('generate_media',  'Create images',                   'Generate or edit images and host them for use in an email.',                   'approve_first', false, 4),
  ('upload_draft',    'Upload drafts to Zoho Campaigns', 'Create or update a draft campaign in Zoho. Drafts are never scheduled.',       'approve_first', false, 5),
  ('list_hygiene',    'Clean mailing lists',             'Remove bounced addresses from a Zoho Campaigns list.',                         'approve_first', false, 6),
  ('save_memory',     'Save to memory',                  'Keep a lesson or preference for future threads.',                              'approve_first', false, 7),
  ('send_live',       'Send campaigns live',             'Not available here. You send from Zoho.',                                      'draft_only',    true,  8);

insert into automations (id, label, description, cron, kind, prompt, enabled, position) values
  ('sync',           'Sync Zoho and listings',  'Refresh campaigns, results and AppFolio listings.',                       '0 6 * * *',   'sync',   null, true, 1),
  ('plan_week',      'Plan the week''s sends',  'Every Monday, propose this week''s two emails from current listings.',    '0 8 * * 1',   'prompt',
   'Plan this week''s sends. Look at current listings and how the last six sends performed, then propose two emails for this week (Tuesday and Thursday) with a one-line reason for each. Write the drafts and send me tests.', false, 2),
  ('review_results', 'Review results',          'Two days after each send, compare it with the previous six.',             '0 9 * * 4,0', 'prompt',
   'Review the most recent send that is at least two days old and has not been reviewed in this thread list. Compare opens and clicks with the previous six sends, say what likely helped or hurt, and note anything worth remembering.', false, 3),
  ('bounce_check',   'Check for hard bounces',  'Weekly, list hard bounces from recent sends and ask to remove them.',     '0 7 * * 5',   'prompt',
   'Check the last four sends for hard bounces. If there are any, ask for approval to remove them from the Leads list.', false, 4);

insert into connections (id, label, detail, position) values
  ('zoho_campaigns', 'Zoho Campaigns', 'Campaigns, results and lists. Drafts are uploaded here.', 1),
  ('zoho_crm',       'Zoho CRM',       'Contacts and leads, read only.',                          2),
  ('appfolio',       'AppFolio listings', 'Public listings page, read on a schedule.',            3),
  ('agentmail',      'Email',          'The agent''s own inbox.',                                 4),
  ('photon',         'Text',           'iMessage through Photon.',                                5),
  ('instabox',       'Agent computer', 'The machine the agent runs on.',                          6),
  ('media',          'Images',         'FAL for generation, Cloudinary for hosting.',             7);

insert into settings (key, value) values
  ('agent',    '{"name": "Penny", "enabled": true}'),
  ('brand',    '{"name": "Your company", "product": "Command center", "accent": "#a855f7"}'),
  ('defaults', '{"sender_email": "", "sender_name": "Your company", "list_id": "", "list_name": "Leads", "topic_id": "", "topic_name": "Marketing", "listings_url": ""}');

-- Inbound messages already handled, so a redelivery is not processed twice.
create table inbound_seen (
  channel      text not null,
  external_id  text not null,
  seen_at      timestamptz not null default now(),
  primary key (channel, external_id)
);
