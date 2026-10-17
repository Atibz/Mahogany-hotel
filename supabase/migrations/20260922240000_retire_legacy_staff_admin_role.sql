-- Staff account administration is performed by the Owner and General Manager.
-- Retire the legacy staff_admin role so it cannot retain hidden database access.

delete from public.role_permissions rp
using public.roles r
where rp.role_id = r.id
  and r.code = 'staff_admin';

update public.roles
set active = false, updated_at = now()
where code = 'staff_admin' and active;
