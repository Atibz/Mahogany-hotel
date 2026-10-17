-- Preserve the audit trail when an option group is detached from a menu item.
-- Reattaching the same pair restores its mapping instead of creating duplicates.

alter table public.pos_menu_item_modifier_groups
  add column if not exists active boolean not null default true,
  add column if not exists updated_at timestamptz not null default now();

drop policy if exists pos_menu_item_modifier_groups_read on public.pos_menu_item_modifier_groups;
create policy pos_menu_item_modifier_groups_read on public.pos_menu_item_modifier_groups for select to authenticated
using (active and public.has_hotel_permission(hotel_id, 'pos.catalog.read'));

create or replace function public.assign_pos_modifier_group(target_menu_item_id uuid, target_modifier_group_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  item_record public.pos_menu_items;
  group_record public.pos_modifier_groups;
begin
  select * into item_record
  from public.pos_menu_items
  where id = target_menu_item_id and active
  for update;
  if not found then raise exception 'Active POS menu item not found'; end if;
  if not public.has_hotel_permission(item_record.hotel_id, 'pos.catalog.manage') then
    raise exception 'Not authorised to manage the POS catalog';
  end if;

  select * into group_record
  from public.pos_modifier_groups
  where id = target_modifier_group_id
    and outlet_id = item_record.outlet_id
    and hotel_id = item_record.hotel_id
    and active
  for update;
  if not found then raise exception 'Choose an active modifier group from the same outlet'; end if;

  insert into public.pos_menu_item_modifier_groups
    (hotel_id, outlet_id, menu_item_id, modifier_group_id)
  values (item_record.hotel_id, item_record.outlet_id, item_record.id, group_record.id)
  on conflict (menu_item_id, modifier_group_id)
  do update set active = true, updated_at = now();

  perform public.log_activity(item_record.hotel_id, 'pos.modifier_group_assigned', 'pos_menu_item', item_record.id,
    jsonb_build_object('modifier_group_id', group_record.id));
end;
$$;

create or replace function public.remove_pos_modifier_group(
  target_menu_item_id uuid,
  target_modifier_group_id uuid,
  change_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  item_record public.pos_menu_items;
  group_record public.pos_modifier_groups;
begin
  select * into item_record
  from public.pos_menu_items
  where id = target_menu_item_id
  for update;
  if not found then raise exception 'POS menu item not found'; end if;
  if not public.has_hotel_permission(item_record.hotel_id, 'pos.catalog.manage') then
    raise exception 'Not authorised to manage the POS catalog';
  end if;

  select * into group_record
  from public.pos_modifier_groups
  where id = target_modifier_group_id
    and outlet_id = item_record.outlet_id
    and hotel_id = item_record.hotel_id;
  if not found then raise exception 'Modifier group does not belong to this outlet'; end if;
  if nullif(trim(change_reason), '') is null then
    raise exception 'A reason is required for catalog changes';
  end if;

  update public.pos_menu_item_modifier_groups
  set active = false, updated_at = now()
  where menu_item_id = target_menu_item_id
    and modifier_group_id = target_modifier_group_id
    and active;
  if not found then raise exception 'Modifier group is not attached to this menu item'; end if;

  perform public.log_activity(item_record.hotel_id, 'pos.modifier_group_unassigned', 'pos_menu_item', target_menu_item_id,
    jsonb_build_object('modifier_group_id', target_modifier_group_id,
      'modifier_group_name', group_record.name, 'reason', trim(change_reason)));
end;
$$;

revoke all on function public.assign_pos_modifier_group(uuid, uuid),
  public.remove_pos_modifier_group(uuid, uuid, text) from public, anon;
grant execute on function public.assign_pos_modifier_group(uuid, uuid),
  public.remove_pos_modifier_group(uuid, uuid, text) to authenticated;
