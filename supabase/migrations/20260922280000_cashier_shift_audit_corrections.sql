-- Correct cash reconciliation for fully refunded cash payments. A refunded
-- payment remains cash received, then its recorded refund reduces expected cash.

create or replace function public.cashier_shift_expected_cash(target_cashier_shift_id uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select cs.opening_float_kobo
    + coalesce((select sum(p.amount_kobo)
      from public.payments p join public.payment_methods pm on pm.id = p.payment_method_id
      where p.cashier_shift_id = cs.id and pm.code = 'cash' and p.status in ('completed', 'refunded')), 0)
    - coalesce((select sum(pr.amount_kobo)
      from public.payment_refunds pr join public.payments p on p.id = pr.payment_id
      join public.payment_methods pm on pm.id = p.payment_method_id
      where p.cashier_shift_id = cs.id and pm.code = 'cash'), 0)
  from public.cashier_shifts cs where cs.id = target_cashier_shift_id;
$$;

-- These are trigger/provisioning/internal helpers. Application users call the
-- controlled workflow functions, never these helpers directly.
revoke all on function
  public.next_document_number(uuid, text),
  public.log_activity(uuid, text, text, uuid, jsonb),
  public.validate_payment_allocation(),
  public.provision_hotel_roles(uuid),
  public.provision_invoice_read_permission(uuid),
  public.provision_room_read_permission(uuid),
  public.provision_financial_control_permissions(uuid),
  public.provision_cashier_shift_permissions(uuid),
  public.cashier_shift_expected_cash(uuid)
from public, anon, authenticated;
