-- Existing installations keep their current level. Sending remains off until
-- the owner explicitly changes it in Settings.
update guardrails set locked = false,
  description = 'Choose manual sending, approval before each live send, or automatic sending through your campaign provider.'
where action = 'send_live';

-- A fingerprint binds an upload to its content and destination settings.
alter table drafts add column uploaded_fingerprint text;
alter table drafts add column uploaded_provider_fingerprint text;
alter table drafts add column send_locked boolean not null default false;
alter table drafts drop constraint drafts_status_check;
alter table drafts add constraint drafts_status_check
  check (status in ('draft', 'tested', 'uploaded', 'submitting', 'submitted', 'unknown'));

-- Claim each provider campaign once before making a send request. A timeout
-- must never trigger an automatic retry: the provider may already have sent it.
create table campaign_send_attempts (
  campaign_id text primary key,
  draft_id uuid references drafts(id) on delete set null,
  status text not null check (status in ('submitting', 'submitted', 'unknown')),
  snapshot jsonb not null,
  detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
