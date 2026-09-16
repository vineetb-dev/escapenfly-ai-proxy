-- 001_dm_sessions.sql — Maya on Facebook Messenger + Instagram DMs (16 Sep 2026)
--
-- customer_profile/ai_chats are phone-keyed; a DM customer has no phone until
-- Maya learns it mid-conversation and graduates the session (same mechanism
-- website sessions already use — see graduateSessionToPhone() in server.js).
-- Until then the only stable identity is the platform's own psid (Messenger)
-- / igsid (Instagram). This table is that identity <-> phone map plus the
-- human-handoff bookkeeping the CRM feed needs — it is NOT the conversation
-- transcript (that stays in ai_chats, keyed by a 'msgr:<psid>'/'igdm:<igsid>'
-- session key exactly like website's anonymized session keys are, until
-- graduation re-keys it to the real phone).
--
-- No RLS here, matching every other non-costing_audits/roles/staff_roles/
-- portal_credentials table in this project (see CLAUDE.md's RLS section —
-- this is a known, deliberately-deferred gap, not something to fix as a
-- side effect of an unrelated feature).

create table if not exists dm_sessions (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('messenger','instagram')),
  platform_user_id text not null,          -- psid (Messenger) or igsid (Instagram)
  page_id text,                            -- Page/IG business id the message came in on
  phone text,                              -- set once Maya learns it and the session graduates
  profile_name text,                       -- best-effort display name, if Meta's profile API is used later
  last_inbound_at timestamptz,
  handed_off boolean not null default false,
  handed_off_at timestamptz,               -- when handed_off flipped true; drives the 24h auto-resume window
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, platform_user_id)
);

create index if not exists dm_sessions_phone_idx on dm_sessions(phone) where phone is not null;
create index if not exists dm_sessions_handed_off_idx on dm_sessions(handed_off) where handed_off = true;
