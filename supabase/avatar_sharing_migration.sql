-- Run once in Supabase Dashboard -> SQL Editor.
-- Lets people in one shared diary see each other's profile avatars.

alter table public.household_members
  add column if not exists avatar_path text;

create or replace function public.is_household_peer(target_user text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.household_members me
    join public.household_members peer on peer.household_id::text = me.household_id::text
    where me.user_id::text = auth.uid()::text and peer.user_id::text = target_user
  );
$$;

revoke all on function public.is_household_peer(text) from public;
grant execute on function public.is_household_peer(text) to authenticated;

grant update(display_name, avatar_path) on public.household_members to authenticated;

update public.household_members member
set avatar_path = profile.avatar_path
from public.profiles profile
where profile.user_id::text = member.user_id::text
  and profile.avatar_path is not null;

drop policy if exists profile_avatars_read_own on storage.objects;
drop policy if exists profile_avatars_read_household on storage.objects;
create policy profile_avatars_read_household on storage.objects for select to authenticated
using (
  bucket_id = 'profile-avatars'
  and (owner_id::text = auth.uid()::text or public.is_household_peer((storage.foldername(name))[1]))
);
