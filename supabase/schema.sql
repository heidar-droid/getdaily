-- getdaily — schema mirror (additive-only; established 2026-07-20).
-- Tables created before this date (profiles, tasks, rituals, ritual_checks,
-- notes) predate this file and live only in the database; new DDL is mirrored
-- here from now on. RLS pattern everywhere: user_id = (select auth.jwt()->>'sub')
-- (Clerk JWT via Supabase third-party auth).

-- 2026-07-20 · push notifications (web push subscriptions, one row per device)
create table if not exists push_subs (
  id bigint generated always as identity primary key,
  user_id text not null default (auth.jwt() ->> 'sub'),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  ua text,
  created_at timestamptz not null default now()
);
alter table push_subs enable row level security;
create policy "own subs" on push_subs for all
  using (user_id = (select (auth.jwt() ->> 'sub')))
  with check (user_id = (select (auth.jwt() ->> 'sub')));

-- 2026-07-20 · Daily, together — crews, instants, reactions, invites, room.
-- Applied live 2026-07-20; full definitions in this repo's history and the DB.
-- Tables: crews (name, unique invite code, owner), crew_members (crew_id+user_id),
--   instants (owner, kind task|ritual, ref_id, label denormalized at capture,
--   date, storage path), reactions (instant_id+user_id+emoji of 🔥💪👏😮).
-- Helpers (security definer): my_crews(), same_crew(other).
-- RLS law: crews/members visible to members; instants readable by owner OR
--   same_crew(owner); reactions follow instant visibility; all writes self-only.
-- RPCs: create_crew(name) [one crew per user, 6 max], join_crew(code),
--   invite_info(code) [granted to anon — powers the /c/CODE landing],
--   leave_crew() [empty crews are deleted], room_status(d) [per-member counts
--   + name + avatar, never task text].
-- Storage: private bucket "instants" (1MB cap, image/jpeg), path <userId>/<uuid>.jpg;
--   policies: owner write/delete, read for owner OR same_crew(path owner).
-- push_subs: + tz column (IANA timezone captured at subscribe).
