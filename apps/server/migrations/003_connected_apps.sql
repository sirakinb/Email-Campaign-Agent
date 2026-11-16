create table connected_apps (
  slug text primary key,
  name text not null,
  logo text,
  session_id text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
insert into guardrails (action, label, description, level, position) values
  ('connected_app_action', 'Connected app actions', 'Approve actions in apps connected through Composio. Gmail profile, search and message reads are allowed directly.', 'approve_first', 9)
on conflict (action) do nothing;
