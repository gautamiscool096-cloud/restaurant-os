-- =====================================================================
-- Phase 6 / migration 7: bills, payments and receipts
--   * one bill per table session: every accepted order, taxes, payments,
--     amount still due
--   * staff record cash/card-at-table payments; orders flip to paid when
--     the bill is settled
--   * guests pay online through Razorpay (Route: the money settles to the
--     restaurant's linked account, minus the platform fee)
--   * the Razorpay webhook is verified INSIDE the database (HMAC with the
--     webhook secret), so the website never needs a service-role key
--   * test mode lets demos "pay" without real money; it is OFF by default
--     and only a platform admin can turn it on
-- =====================================================================

-- ---------------------------------------------------------------------
-- Platform configuration (single row, readable only by definer functions)
-- ---------------------------------------------------------------------
create table app.platform_config (
  id                       boolean primary key default true check (id),
  payments_test_mode       boolean not null default false,
  platform_fee_bps         int not null default 0 check (platform_fee_bps between 0 and 2000),
  razorpay_webhook_secret  text,
  updated_at               timestamptz not null default now()
);
insert into app.platform_config default values;

-- Platform-level actions (no restaurant) get their own audit trail.
create table app.platform_audit (
  id            bigint generated always as identity primary key,
  actor_user_id uuid,
  action        text not null,
  details       jsonb,
  created_at    timestamptz not null default now()
);
revoke all on app.platform_audit from public, anon, authenticated;
revoke all on app.platform_config from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- The bill for a session (no access checks here: callers check first)
-- ---------------------------------------------------------------------
create or replace function app.session_bill(p_restaurant_id uuid, p_session_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with o as (
    select * from public.orders
     where restaurant_id = p_restaurant_id and session_id = p_session_id
       and status in ('approved', 'preparing', 'ready', 'served')
  ), p as (
    select * from public.payments where restaurant_id = p_restaurant_id and session_id = p_session_id
  ), t as (
    select coalesce(sum(subtotal_minor), 0)::int sub, coalesce(sum(service_charge_minor), 0)::int svc,
           coalesce(sum(tax_minor), 0)::int tax, coalesce(sum(total_minor), 0)::int total
      from o
  ), paid as (
    select coalesce(sum(amount_minor) filter (where status = 'captured'), 0)::int paid from p
  )
  select jsonb_build_object(
    'session_id', s.id, 'status', s.status, 'opened_at', s.opened_at, 'closed_at', s.closed_at,
    'table', jsonb_build_object('number', dt.number, 'label', dt.label),
    'restaurant', jsonb_build_object('name', r.name, 'address', r.address, 'currency', r.currency,
                                     'logo_url', r.logo_url, 'slug', r.slug),
    'settings', jsonb_build_object('tax_percent', st.tax_percent, 'service_charge_percent', st.service_charge_percent,
                                   'prices_include_tax', st.prices_include_tax, 'receipt_footer', st.receipt_footer,
                                   'accepts_cash', st.accepts_cash, 'accepts_online', st.accepts_online),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object('name', i.name_snapshot, 'quantity', sum_q, 'unit_price_minor', i.unit_price_minor,
                                          'amount_minor', sum_q * i.unit_price_minor) order by i.name_snapshot)
        from (select i.name_snapshot, i.unit_price_minor, sum(i.quantity)::int sum_q
                from public.order_items i join o on o.id = i.order_id
               where i.restaurant_id = p_restaurant_id and i.status <> 'cancelled'
               group by 1, 2) i), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('order_number', o.order_number, 'status', o.status,
                                                            'total_minor', o.total_minor) order by o.created_at) from o), '[]'::jsonb),
    'subtotal_minor', t.sub, 'service_charge_minor', t.svc, 'tax_minor', t.tax, 'total_minor', t.total,
    'paid_minor', paid.paid, 'due_minor', greatest(t.total - paid.paid, 0),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'method', p.method, 'status', p.status,
                                                              'amount_minor', p.amount_minor, 'gateway', p.gateway,
                                                              'created_at', p.created_at) order by p.created_at)
                            from p where p.status in ('captured', 'refunded')), '[]'::jsonb),
    'test_mode', (select payments_test_mode from app.platform_config),
    'payout_ready', r.payout_account_status = 'active'
  )
  from public.table_sessions s
  join public.restaurants r on r.id = s.restaurant_id
  join public.restaurant_settings st on st.restaurant_id = s.restaurant_id
  join public.dining_tables dt on dt.restaurant_id = s.restaurant_id and dt.id = s.table_id
  cross join t cross join paid
  where s.restaurant_id = p_restaurant_id and s.id = p_session_id
$$;

-- Orders become paid once the session's bill is fully covered.
create or replace function app.payments_sync_paid()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_total int;
  v_paid  int;
begin
  select coalesce(sum(total_minor), 0) into v_total from public.orders
   where restaurant_id = new.restaurant_id and session_id = new.session_id and status in ('approved', 'preparing', 'ready', 'served');
  select coalesce(sum(amount_minor), 0) into v_paid from public.payments
   where restaurant_id = new.restaurant_id and session_id = new.session_id and status = 'captured';
  update public.orders set is_paid = (v_total > 0 and v_paid >= v_total)
   where restaurant_id = new.restaurant_id and session_id = new.session_id
     and status in ('approved', 'preparing', 'ready', 'served')
     and is_paid is distinct from (v_total > 0 and v_paid >= v_total);
  return null;
end $$;
create trigger payments_sync_paid after insert or update of status, amount_minor on public.payments
  for each row execute function app.payments_sync_paid();

-- ---------------------------------------------------------------------
-- Staff (SECURITY INVOKER: RLS decides who can see / record)
-- ---------------------------------------------------------------------
create or replace function public.staff_session_bill(p_session_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_restaurant uuid;
begin
  if not app.has_role('owner', 'manager', 'waiter', 'cashier') then
    raise exception 'your role cannot see bills' using errcode = '42501';
  end if;
  select restaurant_id into v_restaurant from public.table_sessions where id = p_session_id;
  if v_restaurant is null then
    raise exception 'bill not found' using errcode = 'P0002';
  end if;
  return app.session_bill(v_restaurant, p_session_id);
end $$;

create or replace function public.record_cash_payment(p_session_id uuid, p_amount_minor int)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_restaurant uuid;
  v_due int;
begin
  select restaurant_id into v_restaurant from public.table_sessions where id = p_session_id;
  if v_restaurant is null then
    raise exception 'bill not found' using errcode = 'P0002';
  end if;
  v_due := (public.staff_session_bill(p_session_id) ->> 'due_minor')::int;
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'enter an amount' using errcode = '22023';
  end if;
  if p_amount_minor > v_due then
    raise exception 'that is more than the amount due' using errcode = '22023';
  end if;
  insert into public.payments (restaurant_id, session_id, method, amount_minor)
  values (v_restaurant, p_session_id, 'cash', p_amount_minor);
  return public.staff_session_bill(p_session_id);
end $$;

-- Open tables with what they owe, for the cashier / waiter list.
create or replace function public.open_bills()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if not app.has_role('owner', 'manager', 'waiter', 'cashier') then
    raise exception 'your role cannot see bills' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(b order by (b ->> 'opened_at')), '[]'::jsonb)
      from (select app.session_bill(s.restaurant_id, s.id) - 'lines' - 'settings' b
              from public.table_sessions s where s.status = 'open') x
  );
end $$;

-- ---------------------------------------------------------------------
-- Guests (SECURITY DEFINER, identified by their session token)
-- ---------------------------------------------------------------------
create or replace function app.session_for_token(p_session_token text)
returns public.table_session_secrets language sql stable security definer set search_path = '' as $$
  select * from public.table_session_secrets where token_hash = app.sha256(p_session_token)
$$;

create or replace function public.guest_bill(p_session_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s public.table_session_secrets := app.session_for_token(p_session_token);
begin
  if s.session_id is null then
    raise exception 'bill not found' using errcode = 'P0002';
  end if;
  return app.session_bill(s.restaurant_id, s.session_id) - 'payout_ready';
end $$;

-- Creates (or reuses) a pending online payment for what is still due.
create or replace function public.guest_start_online_payment(p_session_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s     public.table_session_secrets := app.session_for_token(p_session_token);
  v_cfg app.platform_config;
  v_r   public.restaurants;
  v_due int;
  v_pay public.payments;
begin
  if s.session_id is null then
    raise exception 'bill not found' using errcode = 'P0002';
  end if;
  select * into v_cfg from app.platform_config;
  select * into v_r from public.restaurants where id = s.restaurant_id;
  if not (select accepts_online from public.restaurant_settings where restaurant_id = s.restaurant_id) then
    raise exception 'this restaurant does not take online payments' using errcode = '42501';
  end if;
  if not app.tenant_is_operational(s.restaurant_id) then
    raise exception 'this restaurant is not taking payments right now' using errcode = '42501';
  end if;
  v_due := (app.session_bill(s.restaurant_id, s.session_id) ->> 'due_minor')::int;
  if v_due <= 0 then
    raise exception 'nothing to pay' using errcode = '22023';
  end if;

  select * into v_pay from public.payments
   where restaurant_id = s.restaurant_id and session_id = s.session_id and method = 'online'
     and status = 'created' and amount_minor = v_due
   order by created_at desc limit 1;
  if v_pay.id is null then
    update public.payments set status = 'failed'
     where restaurant_id = s.restaurant_id and session_id = s.session_id and method = 'online' and status = 'created';
    insert into public.payments (restaurant_id, session_id, method, status, amount_minor, platform_fee_minor,
                                 gateway, settlement_status)
    values (s.restaurant_id, s.session_id, 'online', 'created', v_due,
            floor(v_due * v_cfg.platform_fee_bps / 10000.0)::int, 'razorpay', 'not_applicable')
    returning * into v_pay;
  end if;

  return jsonb_build_object(
    'payment_id', v_pay.id, 'amount_minor', v_pay.amount_minor, 'platform_fee_minor', v_pay.platform_fee_minor,
    'currency', v_r.currency, 'restaurant_name', v_r.name, 'gateway_order_id', v_pay.gateway_order_id,
    'payout_account_id', case when v_r.payout_account_status = 'active' then v_r.payout_account_id end,
    'test_mode', v_cfg.payments_test_mode);
end $$;

-- The website stores the Razorpay order id it created for this payment.
create or replace function public.guest_attach_gateway_order(p_session_token text, p_payment_id uuid, p_gateway_order_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  s public.table_session_secrets := app.session_for_token(p_session_token);
begin
  if p_gateway_order_id !~ '^order_[A-Za-z0-9]{6,40}$' then
    raise exception 'invalid gateway order id' using errcode = '22023';
  end if;
  update public.payments set gateway_order_id = p_gateway_order_id
   where id = p_payment_id and restaurant_id = s.restaurant_id and session_id = s.session_id
     and status = 'created' and gateway_order_id is null;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
end $$;

-- Test mode only: pretend the gateway captured the payment.
create or replace function public.guest_complete_test_payment(p_session_token text, p_payment_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.table_session_secrets := app.session_for_token(p_session_token);
begin
  if not (select payments_test_mode from app.platform_config) then
    raise exception 'test payments are switched off' using errcode = '42501';
  end if;
  update public.payments
     set status = 'captured', gateway = 'test', gateway_payment_id = 'test_' || replace(id::text, '-', '')
   where id = p_payment_id and restaurant_id = s.restaurant_id and session_id = s.session_id
     and method = 'online' and status = 'created';
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  return app.session_bill(s.restaurant_id, s.session_id) - 'payout_ready';
end $$;

-- ---------------------------------------------------------------------
-- Razorpay webhook. The website passes the raw body and the
-- X-Razorpay-Signature header; the database checks the HMAC itself.
-- ---------------------------------------------------------------------
create or replace function public.razorpay_webhook(p_body text, p_signature text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_secret text := (select razorpay_webhook_secret from app.platform_config);
  v_event  jsonb;
  v_pay    jsonb;
  v_n      int;
begin
  if v_secret is null then
    raise exception 'webhooks are not configured' using errcode = '42501';
  end if;
  if p_signature is null
     or encode(extensions.hmac(convert_to(p_body, 'UTF8'), convert_to(v_secret, 'UTF8'), 'sha256'), 'hex') <> lower(p_signature) then
    raise exception 'bad signature' using errcode = '42501';
  end if;
  v_event := p_body::jsonb;
  v_pay := v_event #> '{payload,payment,entity}';

  if v_event ->> 'event' in ('payment.captured', 'order.paid') and v_pay is not null then
    update public.payments p
       set status = 'captured', gateway_payment_id = v_pay ->> 'id',
           settlement_status = case when p.platform_fee_minor < p.amount_minor
                                     and (select payout_account_status from public.restaurants where id = p.restaurant_id) = 'active'
                                    then 'pending'::public.settlement_status else 'not_applicable'::public.settlement_status end
     where p.gateway_order_id = v_pay ->> 'order_id' and p.method = 'online'
       and p.status in ('created', 'authorized', 'failed')
       and p.amount_minor = (v_pay ->> 'amount')::int;
    get diagnostics v_n = row_count;
    return case when v_n > 0 then 'captured' else 'ignored' end;
  elsif v_event ->> 'event' = 'payment.failed' and v_pay is not null then
    update public.payments set status = 'failed'
     where gateway_order_id = v_pay ->> 'order_id' and method = 'online' and status = 'created';
    return 'failed';
  elsif v_event ->> 'event' = 'transfer.processed' then
    update public.payments set settlement_status = 'settled'
     where gateway_payment_id = v_event #>> '{payload,transfer,entity,source}' and settlement_status = 'pending';
    return 'settled';
  elsif v_event ->> 'event' = 'refund.processed' then
    update public.payments set status = 'refunded'
     where gateway_payment_id = v_event #>> '{payload,refund,entity,payment_id}' and status = 'captured';
    return 'refunded';
  end if;
  return 'ignored';
end $$;

-- ---------------------------------------------------------------------
-- Platform admin: payment settings
-- ---------------------------------------------------------------------
create or replace function public.platform_payment_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_platform_admin() then
    raise exception 'platform admins only' using errcode = '42501';
  end if;
  return (select jsonb_build_object('payments_test_mode', payments_test_mode, 'platform_fee_bps', platform_fee_bps,
                                    'webhook_secret_set', razorpay_webhook_secret is not null, 'updated_at', updated_at)
            from app.platform_config);
end $$;

create or replace function public.platform_set_payment_settings(
  p_test_mode boolean default null, p_fee_bps int default null, p_webhook_secret text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_platform_admin() then
    raise exception 'platform admins only' using errcode = '42501';
  end if;
  update app.platform_config
     set payments_test_mode = coalesce(p_test_mode, payments_test_mode),
         platform_fee_bps = coalesce(p_fee_bps, platform_fee_bps),
         razorpay_webhook_secret = coalesce(nullif(trim(p_webhook_secret), ''), razorpay_webhook_secret),
         updated_at = now();
  insert into app.platform_audit (actor_user_id, action, details)
  values (auth.uid(), 'payment_settings',
          jsonb_build_object('payments_test_mode', p_test_mode, 'platform_fee_bps', p_fee_bps,
                             'webhook_secret_changed', nullif(trim(p_webhook_secret), '') is not null));
  return public.platform_payment_settings();
end $$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke all on function app.session_bill(uuid, uuid), app.payments_sync_paid(), app.session_for_token(text)
  from public, anon, authenticated;
grant execute on function app.session_bill(uuid, uuid) to authenticated;

revoke all on function public.staff_session_bill(uuid), public.record_cash_payment(uuid, int), public.open_bills(),
  public.guest_bill(text), public.guest_start_online_payment(text), public.guest_attach_gateway_order(text, uuid, text),
  public.guest_complete_test_payment(text, uuid), public.razorpay_webhook(text, text),
  public.platform_payment_settings(), public.platform_set_payment_settings(boolean, int, text)
  from public, anon, authenticated;

grant execute on function public.staff_session_bill(uuid), public.record_cash_payment(uuid, int), public.open_bills(),
  public.platform_payment_settings(), public.platform_set_payment_settings(boolean, int, text)
  to authenticated;
grant execute on function public.guest_bill(text), public.guest_start_online_payment(text),
  public.guest_attach_gateway_order(text, uuid, text), public.guest_complete_test_payment(text, uuid),
  public.razorpay_webhook(text, text)
  to anon, authenticated;
