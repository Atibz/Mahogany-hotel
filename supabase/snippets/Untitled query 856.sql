insert into public.user_roles (profile_id, role_id)
select p.id, r.id
from public.profiles p
join auth.users u on u.id = p.id
join public.roles r
  on r.hotel_id = '00000000-0000-4000-8000-000000000001'
where u.email = 'bukunmiatiba@gmail.com'
  and r.code = 'owner'
on conflict do nothing;