-- Daily schema for Supabase (Postgres)
-- User ids are TEXT because auth is handled by Clerk (ids look like "user_...").
-- Every table is protected by RLS keyed on the Clerk JWT "sub" claim.

create table public.profiles (
  id         text primary key,
  name       text not null default '',
  avatar     text,
  onboarded  boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.tasks (
  id         bigint generated always as identity primary key,
  user_id    text not null default (auth.jwt() ->> 'sub'),
  date       text not null,
  text       text not null,
  done       boolean not null default false,
  done_at    timestamptz,
  position   integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.rituals (
  id         bigint generated always as identity primary key,
  user_id    text not null default (auth.jwt() ->> 'sub'),
  label      text not null,
  position   integer not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.ritual_checks (
  ritual_id  bigint not null references public.rituals(id) on delete cascade,
  user_id    text not null default (auth.jwt() ->> 'sub'),
  date       text not null,
  primary key (ritual_id, date)
);

create table public.notes (
  id         bigint generated always as identity primary key,
  user_id    text not null default (auth.jwt() ->> 'sub'),
  date       text not null,
  text       text not null,
  created_at timestamptz not null default now()
);

-- Row Level Security: each user sees only their own rows.
alter table public.profiles      enable row level security;
alter table public.tasks         enable row level security;
alter table public.rituals       enable row level security;
alter table public.ritual_checks enable row level security;
alter table public.notes         enable row level security;

create policy "own profile" on public.profiles for all
  using (id = (select auth.jwt() ->> 'sub'))
  with check (id = (select auth.jwt() ->> 'sub'));

create policy "own tasks" on public.tasks for all
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));

create policy "own rituals" on public.rituals for all
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));

create policy "own checks" on public.ritual_checks for all
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));

create policy "own notes" on public.notes for all
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));

-- Seed one starter non-negotiable when a profile is created.
create or replace function public.handle_new_profile()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  insert into public.rituals (user_id, label) values (new.id, 'Up by 10:00');
  return new;
end; $$;

create trigger on_profile_created
  after insert on public.profiles
  for each row execute function public.handle_new_profile();
