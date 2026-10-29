-- The Owner retains emergency authority but is not part of routine staff administration.
-- This protects direct table reads as well as the staff directory UI. It does not
-- erase lawful audit evidence of any action the Owner actually performs.
create or replace function public.is_hotel_owner(target_hotel_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    join public.profiles p on p.id = ur.profile_id
    where ur.profile_id = (select auth.uid())
      and r.hotel_id = target_hotel_id and r.code = 'owner'
      and r.active and p.active
  );
$$;

create or replace function public.is_owner_profile(target_profile_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.profile_id = target_profile_id and r.code = 'owner'
  );
$$;

revoke all on function public.is_hotel_owner(uuid), public.is_owner_profile(uuid) from public, anon;
grant execute on function public.is_hotel_owner(uuid), public.is_owner_profile(uuid) to authenticated;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
using (
  id = (select auth.uid())
  or (
    not public.is_owner_profile(id)
    and exists (
      select 1 from public.user_roles ur
      join public.roles r on r.id = ur.role_id
      where ur.profile_id = profiles.id
        and public.has_hotel_permission(r.hotel_id, 'staff.read')
    )
  )
);

drop policy if exists roles_read on public.roles;
create policy roles_read on public.roles for select to authenticated
using (
  public.has_hotel_access(hotel_id)
  and (code <> 'owner' or public.is_hotel_owner(hotel_id))
);

drop policy if exists user_roles_read on public.user_roles;
create policy user_roles_read on public.user_roles for select to authenticated
using (
  profile_id = (select auth.uid())
  or (
    not public.is_owner_profile(profile_id)
    and exists (
      select 1 from public.roles r
      where r.id = role_id
        and public.has_hotel_permission(r.hotel_id, 'staff.read')
    )
  )
);
