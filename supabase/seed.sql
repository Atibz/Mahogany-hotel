-- Development-only baseline configuration. Do not run this file against production
-- without replacing legal identity, contact, and effective-date values.

insert into public.hotels (id, legal_name, trading_name, address_line_1, city, state)
values (
  '00000000-0000-4000-8000-000000000001',
  'Mahogany Hotel',
  'Mahogany Hotel',
  'Jericho',
  'Ibadan',
  'Oyo State'
)
on conflict (id) do nothing;

insert into public.hotel_settings (
  hotel_id, business_day_cutoff_time, receipt_prefix, invoice_prefix, rates_price_treatment
)
values ('00000000-0000-4000-8000-000000000001', '02:00', 'MHR', 'MHI', 'inclusive')
on conflict (hotel_id) do nothing;

insert into public.departments (hotel_id, code, name)
values
  ('00000000-0000-4000-8000-000000000001', 'management', 'Management'),
  ('00000000-0000-4000-8000-000000000001', 'reception', 'Reception'),
  ('00000000-0000-4000-8000-000000000001', 'restaurant', 'Restaurant'),
  ('00000000-0000-4000-8000-000000000001', 'bar', 'Bar'),
  ('00000000-0000-4000-8000-000000000001', 'store', 'Store'),
  ('00000000-0000-4000-8000-000000000001', 'finance', 'Finance')
on conflict (hotel_id, code) do nothing;

insert into public.permissions (code, name, description)
values
  ('settings.read', 'View settings', 'View hotel and operational configuration.'),
  ('settings.manage', 'Manage settings', 'Change hotel and operational configuration.'),
  ('staff.read', 'View staff', 'View staff profiles and role assignments.'),
  ('staff.manage', 'Manage staff', 'Manage staff accounts and role assignments.'),
  ('audit.read', 'View audit log', 'View the activity and audit log.'),
  ('guests.read', 'View guests', 'View guest profiles and history.'),
  ('guests.create', 'Create guests', 'Create guest profiles.'),
  ('reservations.read', 'View reservations', 'View reservations and availability.'),
  ('reservations.create', 'Create reservations', 'Create reservations.'),
  ('stays.read', 'View stays', 'View active and historical stays.'),
  ('stays.check_in', 'Check in guests', 'Create active stays from reservations.'),
  ('folios.read', 'View folios', 'View guest folios and posted charges.'),
  ('night_audit.read', 'View night audit', 'View nightly posting runs.'),
  ('night_audit.run', 'Run night audit', 'Run the authorised nightly room-charge posting.')
on conflict (code) do nothing;

insert into public.roles (hotel_id, code, name, description)
values
  ('00000000-0000-4000-8000-000000000001', 'owner', 'Owner', 'Full access to the hotel.'),
  ('00000000-0000-4000-8000-000000000001', 'general_manager', 'General Manager', 'Operational management access.'),
  ('00000000-0000-4000-8000-000000000001', 'receptionist', 'Receptionist', 'Reception and guest operations.'),
  ('00000000-0000-4000-8000-000000000001', 'cashier', 'Cashier', 'Payments and receipts.'),
  ('00000000-0000-4000-8000-000000000001', 'restaurant_staff', 'Restaurant Staff', 'Restaurant POS operations.'),
  ('00000000-0000-4000-8000-000000000001', 'bar_staff', 'Bar Staff', 'Bar POS operations.'),
  ('00000000-0000-4000-8000-000000000001', 'storekeeper', 'Storekeeper', 'Inventory and supplier operations.'),
  ('00000000-0000-4000-8000-000000000001', 'accountant', 'Accountant', 'Finance and reporting operations.'),
  ('00000000-0000-4000-8000-000000000001', 'staff_admin', 'Staff Admin', 'Staff and role administration.')
on conflict (hotel_id, code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.hotel_id = '00000000-0000-4000-8000-000000000001'
  and (
    (r.code = 'general_manager' and p.code in ('settings.read', 'settings.manage', 'staff.read', 'audit.read', 'guests.read', 'guests.create', 'reservations.read', 'reservations.create', 'stays.read', 'stays.check_in', 'folios.read', 'night_audit.read', 'night_audit.run'))
    or (r.code = 'staff_admin' and p.code in ('settings.read', 'staff.read', 'staff.manage', 'audit.read'))
    or (r.code = 'receptionist' and p.code in ('guests.read', 'guests.create', 'reservations.read', 'reservations.create', 'stays.read', 'stays.check_in', 'folios.read'))
  )
on conflict do nothing;

insert into public.payment_methods (hotel_id, code, name, requires_reference, requires_verification, display_order)
values
  ('00000000-0000-4000-8000-000000000001', 'cash', 'Cash', false, false, 1),
  ('00000000-0000-4000-8000-000000000001', 'pos', 'POS', true, false, 2),
  ('00000000-0000-4000-8000-000000000001', 'bank_transfer', 'Bank transfer', true, true, 3),
  ('00000000-0000-4000-8000-000000000001', 'other', 'Other', true, false, 4)
on conflict (hotel_id, code) do nothing;

insert into public.tax_rules (
  hotel_id, code, name, jurisdiction, basis, rate_basis_points, price_treatment,
  calculation_order, applies_to, excluded_tax_codes, effective_from
)
values
  (
    '00000000-0000-4000-8000-000000000001',
    'federal_vat',
    'Federal VAT',
    'federal',
    'percentage',
    750,
    'inclusive',
    10,
    array['room', 'restaurant', 'bar', 'other'],
    array['oyo_horct'],
    current_date
  ),
  (
    '00000000-0000-4000-8000-000000000001',
    'oyo_horct',
    'Oyo Hotels Occupancy and Restaurant Consumption Tax',
    'state',
    'percentage',
    500,
    'inclusive',
    20,
    array['room', 'restaurant', 'bar', 'other'],
    array['federal_vat'],
    current_date
  )
on conflict (hotel_id, code, effective_from) do nothing;

-- Realistic operational fixtures for a clean local database reset. These UUIDs and
-- document numbers are reserved for development data. Do not copy this section into
-- a production database or replace it with real guest information.

insert into public.room_types (
  id, hotel_id, name, description, base_rate_kobo, capacity, amenities, size_sqft
)
values
  (
    '10000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    'Standard',
    'Comfortable room for individual travellers and couples.',
    4500000,
    2,
    '["Wi-Fi", "Air conditioning", "Television"]'::jsonb,
    260
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    'Deluxe',
    'Larger room with a work area and upgraded amenities.',
    6500000,
    2,
    '["Wi-Fi", "Air conditioning", "Smart TV", "Mini fridge"]'::jsonb,
    340
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000001',
    'Executive Suite',
    'Suite with a separate lounge for longer or executive stays.',
    9500000,
    3,
    '["Wi-Fi", "Air conditioning", "Smart TV", "Mini fridge", "Lounge"]'::jsonb,
    520
  )
on conflict (hotel_id, name) do nothing;

insert into public.rooms (id, hotel_id, room_type_id, room_number, amenities)
select fixture.id, fixture.hotel_id, rt.id, fixture.room_number, fixture.amenities
from (values
  ('20000000-0000-4000-8000-000000000101'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 'Standard', '101', '[]'::jsonb),
  ('20000000-0000-4000-8000-000000000102'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 'Standard', '102', '["Quiet side"]'::jsonb),
  ('20000000-0000-4000-8000-000000000103'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 'Standard', '103', '[]'::jsonb),
  ('20000000-0000-4000-8000-000000000201'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 'Deluxe', '201', '["Balcony"]'::jsonb),
  ('20000000-0000-4000-8000-000000000202'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 'Deluxe', '202', '[]'::jsonb),
  ('20000000-0000-4000-8000-000000000203'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 'Deluxe', '203', '[]'::jsonb),
  ('20000000-0000-4000-8000-000000000301'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 'Executive Suite', '301', '["City view"]'::jsonb),
  ('20000000-0000-4000-8000-000000000302'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 'Executive Suite', '302', '["Corner room"]'::jsonb)
) as fixture(id, hotel_id, room_type_name, room_number, amenities)
join public.room_types rt
  on rt.hotel_id = fixture.hotel_id and rt.name = fixture.room_type_name
on conflict (hotel_id, room_number) do nothing;

insert into public.guests (id, hotel_id, full_name, phone, email, address, identification_type, identification_reference, notes)
values
  ('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Ada Okafor', '+234 803 555 0101', 'ada.okafor@example.test', 'Ibadan, Oyo State', 'National ID', 'DEMO-NIN-001', 'Development fixture: returning business traveller.'),
  ('30000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Tunde Adebayo', '+234 803 555 0102', 'tunde.adebayo@example.test', 'Lagos, Lagos State', 'Driving licence', 'DEMO-DL-002', 'Development fixture: prefers a quiet room.'),
  ('30000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'Zainab Musa', '+234 803 555 0103', 'zainab.musa@example.test', 'Abuja, FCT', 'International passport', 'DEMO-PPT-003', 'Development fixture: airport pickup requested.'),
  ('30000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'Chidi Nwosu', '+234 803 555 0104', 'chidi.nwosu@example.test', 'Enugu, Enugu State', 'National ID', 'DEMO-NIN-004', 'Development fixture: late arrival expected.'),
  ('30000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', 'Yetunde Balogun', '+234 803 555 0105', 'yetunde.balogun@example.test', 'Akure, Ondo State', 'Voter card', 'DEMO-PVC-005', 'Development fixture: family booking enquiry.')
on conflict (id) do nothing;

with business_day as (
  select public.hotel_business_date('00000000-0000-4000-8000-000000000001') as value
)
insert into public.reservations (
  id, hotel_id, reservation_number, guest_id, room_type_id, room_id,
  check_in_date, check_out_date, adults, children, agreed_rate_kobo,
  deposit_expected_kobo, booking_source, status, notes
)
select
  fixture.id,
  '00000000-0000-4000-8000-000000000001',
  fixture.reservation_number,
  fixture.guest_id,
  rt.id,
  r.id,
  business_day.value + fixture.arrival_offset,
  business_day.value + fixture.departure_offset,
  fixture.adults,
  fixture.children,
  fixture.agreed_rate_kobo,
  fixture.deposit_expected_kobo,
  fixture.booking_source,
  fixture.status::public.reservation_status,
  fixture.notes
from (values
  ('40000000-0000-4000-8000-000000000001'::uuid, 'DEMO-RES-001', '30000000-0000-4000-8000-000000000001'::uuid, 'Standard', '101', 0, 2, 1::smallint, 0::smallint, 4500000::bigint, 4500000::bigint, 'Direct', 'confirmed', 'Arrival today; use for the reservation check-in workflow.'),
  ('40000000-0000-4000-8000-000000000002'::uuid, 'DEMO-RES-002', '30000000-0000-4000-8000-000000000002'::uuid, 'Standard', '102', 1, 4, 2::smallint, 0::smallint, 4500000::bigint, 0::bigint, 'Telephone', 'confirmed', 'Future confirmed reservation with an assigned room.'),
  ('40000000-0000-4000-8000-000000000003'::uuid, 'DEMO-RES-003', '30000000-0000-4000-8000-000000000003'::uuid, 'Deluxe', null, 2, 5, 1::smallint, 0::smallint, 6500000::bigint, 6500000::bigint, 'Website', 'pending', 'Pending reservation awaiting room assignment and confirmation.'),
  ('40000000-0000-4000-8000-000000000004'::uuid, 'DEMO-RES-004', '30000000-0000-4000-8000-000000000004'::uuid, 'Deluxe', '201', 5, 7, 2::smallint, 0::smallint, 6000000::bigint, 6000000::bigint, 'Corporate', 'confirmed', 'Confirmed reservation with a valid discount below the 20 percent approval threshold.'),
  ('40000000-0000-4000-8000-000000000005'::uuid, 'DEMO-RES-005', '30000000-0000-4000-8000-000000000005'::uuid, 'Executive Suite', null, 7, 10, 2::smallint, 1::smallint, 9500000::bigint, 0::bigint, 'Walk-in enquiry', 'pending', 'Future family booking awaiting room assignment.')
) as fixture(
  id, reservation_number, guest_id, room_type_name, room_number,
  arrival_offset, departure_offset, adults, children, agreed_rate_kobo,
  deposit_expected_kobo, booking_source, status, notes
)
cross join business_day
join public.room_types rt
  on rt.hotel_id = '00000000-0000-4000-8000-000000000001'
 and rt.name = fixture.room_type_name
left join public.rooms r
  on r.hotel_id = '00000000-0000-4000-8000-000000000001'
 and r.room_number = fixture.room_number
where not exists (
  select 1 from public.reservations existing
  where existing.hotel_id = '00000000-0000-4000-8000-000000000001'
    and existing.reservation_number = fixture.reservation_number
);

insert into public.maintenance_tickets (
  id, hotel_id, room_id, ticket_number, description, priority, status
)
select
  '50000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  r.id,
  'DEMO-MNT-001',
  'Air conditioner is not cooling consistently.',
  'normal',
  'open'
from public.rooms r
where r.hotel_id = '00000000-0000-4000-8000-000000000001'
  and r.room_number = '203'
  and not exists (
    select 1 from public.maintenance_tickets mt
    where mt.hotel_id = r.hotel_id and mt.ticket_number = 'DEMO-MNT-001'
  );

-- Development-only audit volume for search, category, pagination, and CSV
-- acceptance testing. These are explicitly marked fixtures and never belong in
-- a production seed.
insert into public.activity_logs (
  hotel_id, actor_id, action, entity_type, entity_id, metadata, occurred_at
)
select
  '00000000-0000-4000-8000-000000000001',
  null,
  case (fixture_number - 1) % 8
    when 0 then 'maintenance.reported'
    when 1 then 'staff.invited'
    when 2 then 'staff.role_reassigned'
    when 3 then 'reservation.discount_requested'
    when 4 then 'finance_approval.requested'
    when 5 then 'finance_approval.approved'
    when 6 then 'payment.refunded'
    else 'folio.adjusted'
  end,
  case (fixture_number - 1) % 8
    when 0 then 'maintenance_ticket'
    when 1 then 'profile'
    when 2 then 'profile'
    when 3 then 'reservation'
    when 4 then 'finance_approval_request'
    when 5 then 'finance_approval_request'
    when 6 then 'payment_refund'
    else 'folio_item'
  end,
  gen_random_uuid(),
  jsonb_build_object(
    'development_fixture', true,
    'fixture_batch', 'audit-register-v1',
    'fixture_number', fixture_number,
    'amount_kobo', case when (fixture_number - 1) % 8 in (3, 6, 7) then 4500000 else null end,
    'reason', 'Development-only audit register acceptance fixture'
  ),
  now() - ((fixture_number - 1) * interval '10 minutes')
from generate_series(1, 56) as fixture(fixture_number)
where not exists (
  select 1 from public.activity_logs
  where metadata ->> 'fixture_batch' = 'audit-register-v1'
);
