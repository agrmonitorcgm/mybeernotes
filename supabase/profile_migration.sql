-- Run once in Supabase Dashboard -> SQL Editor.
-- Adds private user profiles and avatar storage to an existing Beer Diary project.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  gender text not null default '' check (gender in ('', 'male', 'female', 'other')),
  age smallint check (age is null or (age between 1 and 120)),
  birth_country text not null default '' check (char_length(birth_country) <= 80),
  political_party text not null default '' check (char_length(political_party) <= 120),
  avatar_path text,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists profiles_read_own on public.profiles;
create policy profiles_read_own on public.profiles for select to authenticated
using (user_id::text = auth.uid()::text);

drop policy if exists profiles_add_own on public.profiles;
create policy profiles_add_own on public.profiles for insert to authenticated
with check (user_id::text = auth.uid()::text);

drop policy if exists profiles_edit_own on public.profiles;
create policy profiles_edit_own on public.profiles for update to authenticated
using (user_id::text = auth.uid()::text)
with check (user_id::text = auth.uid()::text);

drop policy if exists members_update_own on public.household_members;
create policy members_update_own on public.household_members for update to authenticated
using (user_id::text = auth.uid()::text)
with check (user_id::text = auth.uid()::text);

revoke all on public.profiles from anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
grant update(display_name) on public.household_members to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-avatars', 'profile-avatars', false, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists profile_avatars_read_own on storage.objects;
create policy profile_avatars_read_own on storage.objects for select to authenticated
using (bucket_id = 'profile-avatars' and owner_id::text = auth.uid()::text);

drop policy if exists profile_avatars_add_own on storage.objects;
create policy profile_avatars_add_own on storage.objects for insert to authenticated
with check (bucket_id = 'profile-avatars' and owner_id::text = auth.uid()::text);

drop policy if exists profile_avatars_edit_own on storage.objects;
create policy profile_avatars_edit_own on storage.objects for update to authenticated
using (bucket_id = 'profile-avatars' and owner_id::text = auth.uid()::text)
with check (bucket_id = 'profile-avatars' and owner_id::text = auth.uid()::text);

drop policy if exists profile_avatars_delete_own on storage.objects;
create policy profile_avatars_delete_own on storage.objects for delete to authenticated
using (bucket_id = 'profile-avatars' and owner_id::text = auth.uid()::text);
