-- Run once in Supabase Dashboard -> SQL Editor.
-- Creates private shared diaries, memberships, beer entries and label storage.

create extension if not exists pgcrypto;

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Наш пивной дневник' check (char_length(name) between 1 and 80),
  invite_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id),
  unique (user_id)
);

create table if not exists public.beer_entries (
  id text primary key check (char_length(id) between 1 and 100),
  household_id uuid not null references public.households(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  tasting_date date not null,
  country text not null default '',
  abv numeric(5,2),
  brewery text not null default '',
  style text not null default '',
  price text not null default '',
  place text not null default '',
  would_again boolean,
  rating numeric(3,1),
  tags text[] not null default '{}',
  comment text not null default '',
  photo_path text,
  photo_source text,
  client_updated_at bigint not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint beer_entries_abv check (abv is null or (abv >= 0 and abv <= 100)),
  constraint beer_entries_rating check (rating is null or (rating >= 1 and rating <= 10 and rating * 2 = trunc(rating * 2))),
  constraint beer_entries_comment check (char_length(comment) <= 300)
);

create index if not exists beer_entries_household_updated_idx
  on public.beer_entries (household_id, client_updated_at desc);

create or replace function public.is_household_member(target_household uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.household_members
    where household_id::text = target_household::text and user_id::text = auth.uid()::text
  );
$$;

create or replace function public.create_shared_diary(member_name text)
returns table (household_id uuid, invite_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  new_household public.households;
  clean_name text := left(trim(member_name), 60);
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if clean_name = '' then raise exception 'Display name is required'; end if;
  if exists (select 1 from public.household_members where user_id::text = auth.uid()::text) then
    raise exception 'User already belongs to a diary';
  end if;
  insert into public.households (created_by) values (auth.uid()) returning * into new_household;
  insert into public.household_members (household_id, user_id, display_name, role)
  values (new_household.id, auth.uid(), clean_name, 'owner');
  return query select new_household.id, new_household.invite_code;
end;
$$;

create or replace function public.join_shared_diary(code text, member_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_id uuid;
  clean_name text := left(trim(member_name), 60);
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if clean_name = '' then raise exception 'Display name is required'; end if;
  if exists (select 1 from public.household_members where user_id::text = auth.uid()::text) then
    raise exception 'User already belongs to a diary';
  end if;
  select id into target_id from public.households where invite_code = upper(trim(code));
  if target_id is null then raise exception 'Invite code not found'; end if;
  insert into public.household_members (household_id, user_id, display_name, role)
  values (target_id, auth.uid(), clean_name, 'member');
  return target_id;
end;
$$;

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.beer_entries enable row level security;

drop policy if exists households_read on public.households;
create policy households_read on public.households for select to authenticated
using (public.is_household_member(id));

drop policy if exists members_read on public.household_members;
create policy members_read on public.household_members for select to authenticated
using (public.is_household_member(household_id));

drop policy if exists beer_entries_read on public.beer_entries;
create policy beer_entries_read on public.beer_entries for select to authenticated
using (public.is_household_member(household_id));

drop policy if exists beer_entries_add on public.beer_entries;
create policy beer_entries_add on public.beer_entries for insert to authenticated
with check (public.is_household_member(household_id) and created_by::text = auth.uid()::text);

drop policy if exists beer_entries_edit_own on public.beer_entries;
drop policy if exists beer_entries_edit on public.beer_entries;
create policy beer_entries_edit on public.beer_entries for update to authenticated
using (public.is_household_member(household_id))
with check (public.is_household_member(household_id));

revoke all on public.households, public.household_members, public.beer_entries from anon, authenticated;
grant select on public.households, public.household_members to authenticated;
grant select, insert, update on public.beer_entries to authenticated;
revoke all on function public.is_household_member(uuid) from public;
revoke all on function public.create_shared_diary(text) from public;
revoke all on function public.join_shared_diary(text, text) from public;
grant execute on function public.is_household_member(uuid) to authenticated;
grant execute on function public.create_shared_diary(text) to authenticated;
grant execute on function public.join_shared_diary(text, text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('beer-labels', 'beer-labels', false, 6291456, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists beer_labels_read on storage.objects;
create policy beer_labels_read on storage.objects for select to authenticated
using (
  bucket_id = 'beer-labels'
  and public.is_household_member(((storage.foldername(name))[1])::uuid)
);

drop policy if exists beer_labels_add on storage.objects;
create policy beer_labels_add on storage.objects for insert to authenticated
with check (
  bucket_id = 'beer-labels'
  and public.is_household_member(((storage.foldername(name))[1])::uuid)
);

drop policy if exists beer_labels_edit_own on storage.objects;
create policy beer_labels_edit_own on storage.objects for update to authenticated
using (
  bucket_id = 'beer-labels'
  and owner_id::text = auth.uid()::text
  and public.is_household_member(((storage.foldername(name))[1])::uuid)
)
with check (
  bucket_id = 'beer-labels'
  and owner_id::text = auth.uid()::text
  and public.is_household_member(((storage.foldername(name))[1])::uuid)
);

drop policy if exists beer_labels_delete_own on storage.objects;
create policy beer_labels_delete_own on storage.objects for delete to authenticated
using (
  bucket_id = 'beer-labels'
  and owner_id::text = auth.uid()::text
  and public.is_household_member(((storage.foldername(name))[1])::uuid)
);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'beer_entries'
  ) then
    alter publication supabase_realtime add table public.beer_entries;
  end if;
end $$;
