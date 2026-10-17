-- Expense reports group by when the expense was incurred, while business_date
-- remains available as the hotel's operational date when the record was entered.
create or replace function public.get_operating_expense_summary(target_hotel_id uuid,from_date date,to_date date)
returns table(department text,approved_amount_kobo bigint,pending_amount_kobo bigint,approved_count bigint,pending_count bigint,rejected_count bigint)
language plpgsql stable security definer set search_path=public as $$
begin
 if not public.has_hotel_permission(target_hotel_id,'expenses.read') then raise exception 'Not authorised to view expense summaries'; end if;
 if from_date is null or to_date is null or from_date>to_date or to_date-from_date>92 then raise exception 'Choose a valid report period of up to 93 days'; end if;
 return query select e.department,
  coalesce(sum(e.amount_kobo) filter(where e.status='approved'),0)::bigint,
  coalesce(sum(e.amount_kobo) filter(where e.status='pending_review'),0)::bigint,
  count(*) filter(where e.status='approved'),count(*) filter(where e.status='pending_review'),count(*) filter(where e.status='rejected')
 from public.operating_expenses e where e.hotel_id=target_hotel_id and e.incurred_on between from_date and to_date
 group by e.department order by e.department;
end;
$$;

revoke all on function public.get_operating_expense_summary(uuid,date,date) from public,anon;
grant execute on function public.get_operating_expense_summary(uuid,date,date) to authenticated;
