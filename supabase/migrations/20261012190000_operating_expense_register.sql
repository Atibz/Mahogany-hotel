-- Record operating expenses for internal review without creating journal entries,
-- paying funds, calculating tax, or treating collections/receivables as revenue.
create table public.operating_expenses (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  expense_number text not null,
  business_date date not null,
  incurred_on date not null,
  department text not null check (department in ('hotel','restaurant','bar')),
  category text not null check (length(trim(category)) between 2 and 80),
  description text not null check (length(trim(description)) between 3 and 500),
  payee text not null check (length(trim(payee)) between 2 and 160),
  amount_kobo bigint not null check (amount_kobo > 0),
  paid_via text not null check (length(trim(paid_via)) between 2 and 80),
  evidence_reference text check (evidence_reference is null or length(trim(evidence_reference)) <= 160),
  status text not null default 'pending_review' check (status in ('pending_review','approved','rejected')),
  submitted_by uuid not null references public.profiles(id) on delete restrict,
  submitted_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id) on delete restrict,
  reviewed_at timestamptz,
  review_note text,
  unique (hotel_id, expense_number),
  check ((status='pending_review' and reviewed_by is null and reviewed_at is null and review_note is null)
      or (status in ('approved','rejected') and reviewed_by is not null and reviewed_by is distinct from submitted_by and reviewed_at is not null and nullif(trim(review_note),'') is not null))
);
create index operating_expenses_hotel_date_idx on public.operating_expenses(hotel_id,business_date desc,submitted_at desc);
create index operating_expenses_hotel_status_idx on public.operating_expenses(hotel_id,status,business_date desc);

insert into public.permissions(code,name,description) values
 ('expenses.read','View operating expenses','View expense records and review summaries.'),
 ('expenses.submit','Submit operating expenses','Record expenses already paid for internal review.'),
 ('expenses.review','Review operating expenses','Approve or reject submitted expense records with an independent note.')
on conflict(code) do nothing;

create or replace function public.provision_operating_expense_permissions(target_hotel_id uuid)
returns void language sql security definer set search_path=public as $$
 insert into public.role_permissions(role_id,permission_id)
 select r.id,p.id from public.roles r join public.permissions p on
  (r.code='general_manager' and p.code in ('expenses.read','expenses.submit','expenses.review'))
  or (r.code='accountant' and p.code in ('expenses.read','expenses.submit'))
 where r.hotel_id=target_hotel_id on conflict do nothing;
$$;
select public.provision_operating_expense_permissions(id) from public.hotels;

create or replace function public.handle_hotel_operating_expense_permission_provisioning()
returns trigger language plpgsql security definer set search_path=public as $$
begin perform public.provision_operating_expense_permissions(new.id); return new; end;
$$;
drop trigger if exists zzzzzzzzzzz_hotel_operating_expense_permissions on public.hotels;
create trigger zzzzzzzzzzz_hotel_operating_expense_permissions after insert on public.hotels
for each row execute function public.handle_hotel_operating_expense_permission_provisioning();

revoke all on public.operating_expenses from public,anon,authenticated;
grant select on public.operating_expenses to authenticated;
alter table public.operating_expenses enable row level security;
create policy operating_expenses_read on public.operating_expenses for select to authenticated
using (public.has_hotel_permission(hotel_id,'expenses.read'));

create or replace function public.submit_operating_expense(
 target_hotel_id uuid, department_value text, category_value text, description_value text,
 payee_value text, amount_value_kobo bigint, paid_via_value text, evidence_reference_value text,
 incurred_on_value date default current_date
) returns uuid language plpgsql security definer set search_path=public as $$
declare expense_id uuid; expense_no text;
begin
 if not public.has_hotel_permission(target_hotel_id,'expenses.submit') then raise exception 'Not authorised to submit operating expenses'; end if;
 if department_value not in ('hotel','restaurant','bar') then raise exception 'Choose a valid operating department'; end if;
 if nullif(trim(category_value),'') is null or nullif(trim(description_value),'') is null or nullif(trim(payee_value),'') is null or nullif(trim(paid_via_value),'') is null then
  raise exception 'Category, description, payee, and paid-via details are required';
 end if;
 if amount_value_kobo is null or amount_value_kobo<=0 then raise exception 'Expense amount must be greater than zero'; end if;
 if incurred_on_value is null or incurred_on_value>(now() at time zone (select h.timezone from public.hotels h where h.id=target_hotel_id))::date then raise exception 'Expense date cannot be in the future'; end if;
 expense_no:=public.next_document_number(target_hotel_id,'EXP');
 insert into public.operating_expenses(hotel_id,expense_number,business_date,incurred_on,department,category,description,payee,amount_kobo,paid_via,evidence_reference,submitted_by)
 values(target_hotel_id,expense_no,public.hotel_business_date(target_hotel_id),incurred_on_value,trim(department_value),trim(category_value),trim(description_value),trim(payee_value),amount_value_kobo,trim(paid_via_value),nullif(trim(evidence_reference_value),''),auth.uid()) returning id into expense_id;
 perform public.log_activity(target_hotel_id,'expense.submitted','operating_expense',expense_id,jsonb_build_object('expense_number',expense_no,'department',department_value,'amount_kobo',amount_value_kobo,'evidence_reference',nullif(trim(evidence_reference_value),'')));
 return expense_id;
end;
$$;

create or replace function public.review_operating_expense(target_expense_id uuid,decision_value text,note_value text)
returns void language plpgsql security definer set search_path=public as $$
declare e public.operating_expenses;
begin
 select * into e from public.operating_expenses where id=target_expense_id for update;
 if not found then raise exception 'Expense record not found'; end if;
 if not public.has_hotel_permission(e.hotel_id,'expenses.review') then raise exception 'Not authorised to review operating expenses'; end if;
 if e.status<>'pending_review' then raise exception 'Only pending expenses can be reviewed'; end if;
 if e.submitted_by=auth.uid() then raise exception 'The submitter cannot review their own expense'; end if;
 if decision_value not in ('approved','rejected') then raise exception 'Choose approve or reject'; end if;
 if nullif(trim(note_value),'') is null then raise exception 'A review note is required'; end if;
 update public.operating_expenses set status=decision_value,reviewed_by=auth.uid(),reviewed_at=now(),review_note=trim(note_value) where id=e.id;
 perform public.log_activity(e.hotel_id,case when decision_value='approved' then 'expense.approved' else 'expense.rejected' end,'operating_expense',e.id,jsonb_build_object('expense_number',e.expense_number,'amount_kobo',e.amount_kobo,'review_note',trim(note_value)));
end;
$$;

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
 from public.operating_expenses e where e.hotel_id=target_hotel_id and e.business_date between from_date and to_date
 group by e.department order by e.department;
end;
$$;

revoke all on function public.provision_operating_expense_permissions(uuid),public.handle_hotel_operating_expense_permission_provisioning(),public.submit_operating_expense(uuid,text,text,text,text,bigint,text,text,date),public.review_operating_expense(uuid,text,text),public.get_operating_expense_summary(uuid,date,date) from public,anon;
grant execute on function public.submit_operating_expense(uuid,text,text,text,text,bigint,text,text,date),public.review_operating_expense(uuid,text,text),public.get_operating_expense_summary(uuid,date,date) to authenticated;
