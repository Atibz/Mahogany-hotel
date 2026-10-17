-- Room prices are guest-facing, tax-inclusive amounts. Tax remains auditable,
-- but is extracted from the agreed room rate rather than added to it.

update public.hotel_settings
set rates_price_treatment = 'inclusive', updated_at = now()
where rates_price_treatment <> 'inclusive';

update public.tax_rules
set price_treatment = 'inclusive', updated_at = now()
where active and 'room' = any(applies_to) and price_treatment <> 'inclusive';

create or replace function public.post_room_night(target_stay_id uuid, target_service_date date)
returns table (night_post_id uuid, folio_item_id uuid, created boolean)
language plpgsql
security definer set search_path = public
as $$
declare
  stay_record public.stays;
  target_folio_id uuid;
  target_rate_period_id uuid;
  target_rate_kobo bigint;
  rate_price_treatment public.price_treatment;
  target_base_amount_kobo bigint;
  target_tax_amount_kobo bigint := 0;
  target_tax_snapshot jsonb := '[]'::jsonb;
  total_percentage_basis_points integer := 0;
  total_fixed_amount_kobo bigint := 0;
  calculated_tax_amount_kobo bigint;
  tax_amount_before_last_rule bigint := 0;
  new_folio_item_id uuid;
  new_night_post_id uuid;
  tax_rule record;
begin
  select * into stay_record from public.stays where id = target_stay_id for update;
  if not found then raise exception 'Stay not found'; end if;
  if auth.uid() is not null and not public.has_hotel_permission(stay_record.hotel_id, 'night_audit.run') then
    raise exception 'Not authorised to post room nights';
  end if;
  if stay_record.status <> 'checked_in' then raise exception 'Only active stays may receive room-night charges'; end if;
  if target_service_date < stay_record.actual_check_in_date or target_service_date >= stay_record.expected_check_out_date then
    raise exception 'Service date is outside the active stay';
  end if;

  select gf.id into target_folio_id from public.guest_folios gf
  where gf.stay_id = stay_record.id and gf.status = 'open' for update;
  if target_folio_id is null then raise exception 'Open folio not found for stay'; end if;

  select srp.id, srp.rate_kobo into target_rate_period_id, target_rate_kobo
  from public.stay_rate_periods srp
  where srp.stay_id = stay_record.id
    and srp.effective_from <= target_service_date
    and (srp.effective_to is null or srp.effective_to >= target_service_date)
  order by srp.effective_from desc limit 1;
  if target_rate_kobo is null then raise exception 'No rate period is available for this service date'; end if;

  select rates_price_treatment into rate_price_treatment
  from public.hotel_settings where hotel_id = stay_record.hotel_id;
  if rate_price_treatment is null then raise exception 'Hotel pricing settings were not found'; end if;

  select
    coalesce(sum(case when tr.basis = 'percentage' then tr.rate_basis_points else 0 end), 0),
    coalesce(sum(case when tr.basis = 'fixed' then tr.fixed_amount_kobo else 0 end), 0)
  into total_percentage_basis_points, total_fixed_amount_kobo
  from public.tax_rules tr
  where tr.hotel_id = stay_record.hotel_id
    and tr.active
    and 'room' = any(tr.applies_to)
    and tr.effective_from <= target_service_date
    and (tr.effective_to is null or tr.effective_to >= target_service_date);

  if rate_price_treatment = 'inclusive' then
    if target_rate_kobo < total_fixed_amount_kobo then
      raise exception 'The room rate is lower than its included fixed taxes';
    end if;
    target_base_amount_kobo := round(
      (target_rate_kobo - total_fixed_amount_kobo)::numeric * 10000
      / (10000 + total_percentage_basis_points)
    )::bigint;
    target_tax_amount_kobo := target_rate_kobo - target_base_amount_kobo;
  else
    target_base_amount_kobo := target_rate_kobo;
    target_tax_amount_kobo := round(target_base_amount_kobo::numeric * total_percentage_basis_points / 10000)::bigint
      + total_fixed_amount_kobo;
  end if;

  for tax_rule in
    select tr.*, row_number() over (order by tr.calculation_order, tr.id) as rule_position,
      count(*) over () as rule_count
    from public.tax_rules tr
    where tr.hotel_id = stay_record.hotel_id
      and tr.active
      and 'room' = any(tr.applies_to)
      and tr.effective_from <= target_service_date
      and (tr.effective_to is null or tr.effective_to >= target_service_date)
    order by tr.calculation_order, tr.id
  loop
    calculated_tax_amount_kobo := case
      when tax_rule.basis = 'percentage' then round(target_base_amount_kobo::numeric * tax_rule.rate_basis_points / 10000)::bigint
      else tax_rule.fixed_amount_kobo
    end;
    -- Put any rounding difference into the final tax rule so snapshot totals
    -- exactly reconcile to the folio tax column and the guest-facing total.
    if tax_rule.rule_position = tax_rule.rule_count then
      calculated_tax_amount_kobo := target_tax_amount_kobo - tax_amount_before_last_rule;
    else
      tax_amount_before_last_rule := tax_amount_before_last_rule + calculated_tax_amount_kobo;
    end if;
    target_tax_snapshot := target_tax_snapshot || jsonb_build_array(jsonb_build_object(
      'id', tax_rule.id, 'code', tax_rule.code, 'name', tax_rule.name,
      'jurisdiction', tax_rule.jurisdiction, 'basis', tax_rule.basis,
      'rate_basis_points', tax_rule.rate_basis_points, 'fixed_amount_kobo', tax_rule.fixed_amount_kobo,
      'price_treatment', rate_price_treatment, 'amount_kobo', calculated_tax_amount_kobo
    ));
  end loop;

  begin
    insert into public.folio_items (
      hotel_id, folio_id, item_type, description, department_code, service_date,
      base_amount_kobo, tax_amount_kobo, total_amount_kobo, tax_snapshot,
      reference_type, posted_by
    ) values (
      stay_record.hotel_id, target_folio_id, 'room_charge',
      'Room charge for ' || to_char(target_service_date, 'DD Mon YYYY'), 'reception', target_service_date,
      target_base_amount_kobo, target_tax_amount_kobo,
      case when rate_price_treatment = 'inclusive' then target_rate_kobo else target_rate_kobo + target_tax_amount_kobo end,
      target_tax_snapshot, 'room_night_post', auth.uid()
    ) returning id into new_folio_item_id;

    insert into public.room_night_posts (
      hotel_id, stay_id, folio_id, folio_item_id, service_date, rate_period_id,
      rate_kobo, tax_snapshot, posted_by
    ) values (
      stay_record.hotel_id, stay_record.id, target_folio_id, new_folio_item_id,
      target_service_date, target_rate_period_id, target_rate_kobo, target_tax_snapshot, auth.uid()
    ) returning id into new_night_post_id;
  exception when unique_violation then
    select rnp.id, rnp.folio_item_id into new_night_post_id, new_folio_item_id
    from public.room_night_posts rnp
    where rnp.stay_id = stay_record.id and rnp.service_date = target_service_date;
    return query select new_night_post_id, new_folio_item_id, false;
    return;
  end;

  perform public.log_activity(stay_record.hotel_id, 'folio.room_night_posted', 'room_night_post', new_night_post_id,
    jsonb_build_object(
      'stay_id', stay_record.id, 'service_date', target_service_date,
      'gross_rate_kobo', target_rate_kobo, 'tax_amount_kobo', target_tax_amount_kobo,
      'price_treatment', rate_price_treatment
    ));
  return query select new_night_post_id, new_folio_item_id, true;
end;
$$;

revoke all on function public.post_room_night(uuid, date) from public;
grant execute on function public.post_room_night(uuid, date) to authenticated;
