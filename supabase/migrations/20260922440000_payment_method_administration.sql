-- Owner and General Manager control future payment collection methods through
-- audited RPCs. Historical payment records retain their original method identity.

insert into public.permissions (code, name, description)
values ('payment_methods.manage', 'Manage payment methods', 'Create, configure, activate, or retire payment methods for future collections.')
on conflict (code) do nothing;

create or replace function public.provision_standard_payment_methods(target_hotel_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.payment_methods (
    hotel_id, code, name, requires_reference, requires_verification, display_order
  )
  values
    (target_hotel_id, 'cash', 'Cash', false, false, 10),
    (target_hotel_id, 'pos', 'POS', true, false, 20),
    (target_hotel_id, 'bank_transfer', 'Bank transfer', true, true, 30),
    (target_hotel_id, 'other', 'Other', false, false, 40)
  on conflict (hotel_id, code) do nothing;
$$;

select public.provision_standard_payment_methods(id) from public.hotels;

create or replace function public.handle_hotel_payment_method_provisioning()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.provision_standard_payment_methods(new.id);
  perform public.provision_payment_method_management_permissions(new.id);
  return new;
end;
$$;

drop trigger if exists zzzzzzzz_hotel_payment_method_provisioning on public.hotels;
create trigger zzzzzzzz_hotel_payment_method_provisioning
after insert on public.hotels
for each row execute function public.handle_hotel_payment_method_provisioning();

create or replace function public.provision_payment_method_management_permissions(target_hotel_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id
  from public.roles r
  join public.permissions p on p.code = 'payment_methods.manage'
  where r.hotel_id = target_hotel_id
    and r.code = 'general_manager'
  on conflict do nothing;
$$;

select public.provision_payment_method_management_permissions(id) from public.hotels;

create or replace function public.create_payment_method(
  target_hotel_id uuid,
  method_code text,
  method_name text,
  requires_reference_value boolean default false,
  requires_verification_value boolean default false,
  display_order_value integer default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  normalized_code text := lower(trim(method_code));
  normalized_name text := trim(method_name);
  new_method_id uuid;
  next_display_order integer;
begin
  if not public.has_hotel_permission(target_hotel_id, 'payment_methods.manage') then
    raise exception 'Not authorised to manage payment methods';
  end if;
  if normalized_code !~ '^[a-z][a-z0-9_]{1,48}$' then
    raise exception 'Payment method code must use lowercase letters, numbers, and underscores';
  end if;
  if normalized_name is null or length(normalized_name) > 100 then
    raise exception 'Payment method name must be between 1 and 100 characters';
  end if;
  if normalized_code = 'cash' and requires_verification_value then
    raise exception 'Cash cannot require payment verification';
  end if;
  if display_order_value is null then
    select coalesce(max(display_order), 0) + 10 into next_display_order
    from public.payment_methods
    where hotel_id = target_hotel_id;
  else
    next_display_order := display_order_value;
  end if;
  if next_display_order < 0 or next_display_order > 32767 then
    raise exception 'Display order must be between 0 and 32767';
  end if;

  insert into public.payment_methods (
    hotel_id, code, name, requires_reference, requires_verification, display_order
  )
  values (
    target_hotel_id, normalized_code, normalized_name, requires_reference_value,
    requires_verification_value, next_display_order::smallint
  )
  returning id into new_method_id;

  perform public.log_activity(target_hotel_id, 'payment_method.created', 'payment_method', new_method_id,
    jsonb_build_object(
      'code', normalized_code,
      'name', normalized_name,
      'requires_reference', requires_reference_value,
      'requires_verification', requires_verification_value,
      'display_order', next_display_order
    ));
  return new_method_id;
end;
$$;

create or replace function public.update_payment_method(
  target_payment_method_id uuid,
  method_code text,
  method_name text,
  requires_reference_value boolean,
  requires_verification_value boolean,
  is_active boolean,
  display_order_value integer
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  target_method public.payment_methods;
  normalized_code text := lower(trim(method_code));
  normalized_name text := trim(method_name);
begin
  select * into target_method
  from public.payment_methods
  where id = target_payment_method_id
  for update;
  if not found then
    raise exception 'Payment method not found';
  end if;
  if not public.has_hotel_permission(target_method.hotel_id, 'payment_methods.manage') then
    raise exception 'Not authorised to manage payment methods';
  end if;
  if normalized_code !~ '^[a-z][a-z0-9_]{1,48}$' then
    raise exception 'Payment method code must use lowercase letters, numbers, and underscores';
  end if;
  if normalized_name is null or length(normalized_name) > 100 then
    raise exception 'Payment method name must be between 1 and 100 characters';
  end if;
  if display_order_value < 0 or display_order_value > 32767 then
    raise exception 'Display order must be between 0 and 32767';
  end if;
  if normalized_code = 'cash' and requires_verification_value then
    raise exception 'Cash cannot require payment verification';
  end if;
  if exists (select 1 from public.payments where payment_method_id = target_method.id)
    and (normalized_code <> target_method.code or normalized_name <> target_method.name) then
    raise exception 'A payment method already used in a payment cannot be renamed; deactivate it and create a replacement instead';
  end if;

  update public.payment_methods
  set code = normalized_code,
      name = normalized_name,
      requires_reference = requires_reference_value,
      requires_verification = requires_verification_value,
      active = is_active,
      display_order = display_order_value::smallint,
      updated_at = now()
  where id = target_method.id;

  perform public.log_activity(target_method.hotel_id, 'payment_method.updated', 'payment_method', target_method.id,
    jsonb_build_object(
      'previous', jsonb_build_object(
        'code', target_method.code,
        'name', target_method.name,
        'requires_reference', target_method.requires_reference,
        'requires_verification', target_method.requires_verification,
        'active', target_method.active,
        'display_order', target_method.display_order
      ),
      'current', jsonb_build_object(
        'code', normalized_code,
        'name', normalized_name,
        'requires_reference', requires_reference_value,
        'requires_verification', requires_verification_value,
        'active', is_active,
        'display_order', display_order_value
      )
    ));
end;
$$;

revoke all on function public.provision_standard_payment_methods(uuid), public.handle_hotel_payment_method_provisioning(), public.provision_payment_method_management_permissions(uuid), public.create_payment_method(uuid, text, text, boolean, boolean, integer), public.update_payment_method(uuid, text, text, boolean, boolean, boolean, integer) from public;
grant execute on function public.create_payment_method(uuid, text, text, boolean, boolean, integer), public.update_payment_method(uuid, text, text, boolean, boolean, boolean, integer) to authenticated;
