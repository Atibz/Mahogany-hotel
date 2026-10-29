-- Reapply the established GM/accountant register grant for hotels whose
-- role-permission rows drifted after the original provisioning migration.
insert into public.role_permissions(role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'finance_approvals.read'
where r.code in ('general_manager', 'accountant')
on conflict do nothing;
