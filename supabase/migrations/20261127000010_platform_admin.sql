-- =====================================================================
-- Phase 9 / migration 10: platform super-admin console + subscriptions
--   * plans with monthly prices, set by the platform admin
--   * owners see their plan and can subscribe (instantly in test mode;
--     real Razorpay subscriptions arrive through the verified webhook)
--   * platform admins list restaurants, change plan / status / trial,
--     suspend and restore, and record payout (Route) accounts
--   * every platform action is written to app.platform_audit
-- =====================================================================

create table app.subscription_plans (
  code         text primary key check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name         text not null,
  price_minor  int  not null check (price_minor >= 0),
  description  text,
  sort_order   int  not null default 0,
  is_public    boolean not null default true,
  razorpay_plan_id text
);
revoke all on app.subscription_plans from public, anon, authenticated;
insert into app.subscription_plans (code, name, price_minor, description, sort_order) values
  ('standard', 'Standard', 149900, 'QR menu, ordering, kitchen and waiter screens, bills', 1),
  ('pro',      'Pro',      299900, 'Everything in Standard, plus analytics and priority support', 2);

alter table app.platform_config add column subscription_days int not null default 30 check (subscription_days between 1 and 366);

-- Is the signed-in user a platform admin? (used by the website to route them)
create or replace function public.am_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select app.is_platform_admin()
$$;

create or replace function app.require_platform_admin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_platform_admin() then
    raise exception 'platform admins only' using errcode = '42501';
  end if;
end $$;

create or replace function app.platform_log(p_action text, p_details jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into app.platform_audit (actor_user_id, action, details) values (auth.uid(), p_action, p_details)
$$;

-- ---------------------------------------------------------------------
-- Owner side: plan and subscription
-- ---------------------------------------------------------------------
-- Works even while the restaurant is paused (that is when owners need it).
create or replace function app.owner_restaurant_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.restaurant_id from public.staff s where s.user_id = auth.uid() and s.is_active and s.role = 'owner'
$$;

create or replace function public.subscription_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rid uuid := app.owner_restaurant_id(); r public.restaurants;
begin
  if v_rid is null then
    raise exception 'only the owner can see the plan' using errcode = '42501';
  end if;
  select * into r from public.restaurants where id = v_rid;
  return jsonb_build_object(
    'plan', r.plan, 'status', r.subscription_status, 'trial_ends_at', r.trial_ends_at,
    'current_period_end', r.current_period_end, 'suspended', r.suspended_at is not null,
    'operational', app.tenant_is_operational(v_rid),
    'test_mode', (select payments_test_mode from app.platform_config),
    'plans', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'price_minor', price_minor,
                                                           'description', description) order by sort_order), '[]'::jsonb)
                from app.subscription_plans where is_public));
end $$;

-- Test mode: activates immediately. Live: real checkout is not switched on
-- until the platform connects Razorpay subscriptions.
create or replace function public.start_subscription(p_plan text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_rid uuid := app.owner_restaurant_id();
  v_days int := (select subscription_days from app.platform_config);
begin
  if v_rid is null then
    raise exception 'only the owner can change the plan' using errcode = '42501';
  end if;
  if not exists (select 1 from app.subscription_plans where code = p_plan and is_public) then
    raise exception 'pick one of the plans' using errcode = '22023';
  end if;
  if (select suspended_at is not null from public.restaurants where id = v_rid) then
    raise exception 'this restaurant is paused by the platform. Contact support' using errcode = '42501';
  end if;
  if not (select payments_test_mode from app.platform_config) then
    raise exception 'online plan payments are not switched on yet. Contact support to activate your plan' using errcode = '55000';
  end if;
  update public.restaurants
     set plan = p_plan, subscription_status = 'active',
         current_period_end = greatest(coalesce(current_period_end, now()), now()) + make_interval(days => v_days)
   where id = v_rid;
  perform app.platform_log('test_subscription', jsonb_build_object('restaurant_id', v_rid, 'plan', p_plan));
  return public.subscription_overview();
end $$;

-- Razorpay subscription webhooks (signature already checked by the caller).
create or replace function app.apply_subscription_event(p_event jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_sub  jsonb := p_event #> '{payload,subscription,entity}';
  v_days int := (select subscription_days from app.platform_config);
  v_n    int;
begin
  if v_sub is null then return 'ignored'; end if;
  update public.restaurants r
     set subscription_status = case p_event ->> 'event'
           when 'subscription.charged'   then 'active'
           when 'subscription.activated' then 'active'
           when 'subscription.resumed'   then 'active'
           when 'subscription.pending'   then 'past_due'
           when 'subscription.halted'    then 'past_due'
           when 'subscription.cancelled' then 'cancelled'
           when 'subscription.completed' then 'cancelled'
           else r.subscription_status::text end::public.subscription_status,
         current_period_end = case when p_event ->> 'event' in ('subscription.charged', 'subscription.activated')
           then coalesce(to_timestamp(nullif(v_sub ->> 'current_end', '')::bigint),
                         greatest(coalesce(r.current_period_end, now()), now()) + make_interval(days => v_days))
           else r.current_period_end end
   where r.billing_subscription_id = v_sub ->> 'id';
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform app.platform_log('subscription_webhook', jsonb_build_object('event', p_event ->> 'event', 'subscription', v_sub ->> 'id'));
  end if;
  return case when v_n > 0 then 'subscription' else 'ignored' end;
end $$;

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
  elsif v_event ->> 'event' like 'subscription.%' then
    return app.apply_subscription_event(v_event);
  elsif v_event ->> 'event' = 'refund.processed' then
    update public.payments set status = 'refunded'
     where gateway_payment_id = v_event #>> '{payload,refund,entity,payment_id}' and status = 'captured';
    return 'refunded';
  end if;
  return 'ignored';
end $$;


-- ---------------------------------------------------------------------
-- Platform admin console
-- ---------------------------------------------------------------------
create or replace function public.platform_restaurants(p_search text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_platform_admin();
  return (select coalesce(jsonb_agg(x order by x ->> 'created_at' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', r.id, 'name', r.name, 'slug', r.slug, 'plan', r.plan, 'status', r.subscription_status,
      'trial_ends_at', r.trial_ends_at, 'current_period_end', r.current_period_end,
      'suspended', r.suspended_at is not null, 'suspended_reason', r.suspended_reason,
      'payout_account_id', r.payout_account_id, 'payout_account_status', r.payout_account_status,
      'billing_subscription_id', r.billing_subscription_id,
      'operational', app.tenant_is_operational(r.id), 'created_at', r.created_at,
      'owner', (select s.display_name from public.staff s where s.restaurant_id = r.id and s.role = 'owner' limit 1),
      'staff', (select count(*) from public.staff s where s.restaurant_id = r.id and s.is_active),
      'orders_30d', (select count(*) from public.orders o where o.restaurant_id = r.id and o.created_at > now() - interval '30 days'),
      'gmv_30d_minor', (select coalesce(sum(amount_minor), 0) from public.payments p
                         where p.restaurant_id = r.id and p.status = 'captured' and p.created_at > now() - interval '30 days')) x
      from public.restaurants r
     where p_search is null or trim(p_search) = ''
        or r.name ilike '%' || trim(p_search) || '%' or r.slug ilike '%' || trim(p_search) || '%') t);
end $$;

-- p: {plan?, status?, extend_trial_days?, current_period_end?, suspend?: bool, suspended_reason?,
--     payout_account_id?, payout_account_status?, billing_subscription_id?}
create or replace function public.platform_update_restaurant(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old public.restaurants; v_new public.restaurants;
begin
  perform app.require_platform_admin();
  select * into v_old from public.restaurants where id = p_id for update;
  if v_old.id is null then
    raise exception 'restaurant not found' using errcode = 'P0002';
  end if;
  if p ? 'plan' and not exists (select 1 from app.subscription_plans where code = p ->> 'plan') then
    raise exception 'unknown plan' using errcode = '22023';
  end if;
  if p ? 'payout_account_status' and p ->> 'payout_account_status' not in ('not_connected', 'pending', 'active', 'rejected') then
    raise exception 'payout status must be not_connected, pending, active or rejected' using errcode = '22023';
  end if;
  if (p ->> 'suspend')::boolean and nullif(trim(p ->> 'suspended_reason'), '') is null then
    raise exception 'say why the restaurant is being paused' using errcode = '22023';
  end if;
  if coalesce((p ->> 'extend_trial_days')::int, 0) not between 0 and 365 then
    raise exception 'extend the trial by 0 to 365 days' using errcode = '22023';
  end if;
  update public.restaurants
     set plan = coalesce(p ->> 'plan', plan),
         subscription_status = coalesce((p ->> 'status')::public.subscription_status, subscription_status),
         trial_ends_at = case when coalesce((p ->> 'extend_trial_days')::int, 0) > 0
                              then greatest(trial_ends_at, now()) + make_interval(days => (p ->> 'extend_trial_days')::int)
                              else trial_ends_at end,
         current_period_end = case when p ? 'current_period_end' then nullif(p ->> 'current_period_end', '')::timestamptz
                                   else current_period_end end,
         suspended_at = case when p ? 'suspend' then case when (p ->> 'suspend')::boolean then coalesce(suspended_at, now()) end
                             else suspended_at end,
         suspended_reason = case when p ? 'suspend' then case when (p ->> 'suspend')::boolean then trim(p ->> 'suspended_reason') end
                                 else suspended_reason end,
         payout_account_id = case when p ? 'payout_account_id' then nullif(trim(p ->> 'payout_account_id'), '') else payout_account_id end,
         payout_account_status = coalesce(p ->> 'payout_account_status', payout_account_status),
         billing_subscription_id = case when p ? 'billing_subscription_id' then nullif(trim(p ->> 'billing_subscription_id'), '')
                                        else billing_subscription_id end
   where id = p_id
  returning * into v_new;
  if v_new.payout_account_status = 'active' and coalesce(v_new.payout_account_id, '') !~ '^acc_[A-Za-z0-9]+$' then
    raise exception 'an active payout account needs a Razorpay account id like acc_XXXX' using errcode = '22023';
  end if;
  perform app.platform_log('restaurant_update', jsonb_build_object('restaurant_id', p_id, 'changes', p));
  return (select x from jsonb_array_elements(public.platform_restaurants(v_new.slug)) x where x ->> 'id' = p_id::text);
exception when invalid_text_representation then
  raise exception 'check the values entered' using errcode = '22023';
end $$;

create or replace function public.platform_plans()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_platform_admin();
  return jsonb_build_object(
    'subscription_days', (select subscription_days from app.platform_config),
    'plans', (select coalesce(jsonb_agg(to_jsonb(p) order by sort_order), '[]'::jsonb) from app.subscription_plans p));
end $$;

create or replace function public.platform_save_plan(p_code text, p_name text, p_price_minor int, p_description text, p_public boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_platform_admin();
  if nullif(trim(p_name), '') is null or p_price_minor is null or p_price_minor < 0 then
    raise exception 'give the plan a name and a price' using errcode = '22023';
  end if;
  insert into app.subscription_plans (code, name, price_minor, description, is_public, sort_order)
  values (lower(trim(p_code)), trim(p_name), p_price_minor, nullif(trim(p_description), ''), coalesce(p_public, true),
          (select coalesce(max(sort_order), 0) + 1 from app.subscription_plans))
  on conflict (code) do update
     set name = excluded.name, price_minor = excluded.price_minor, description = excluded.description,
         is_public = excluded.is_public;
  perform app.platform_log('plan_saved', jsonb_build_object('code', p_code, 'price_minor', p_price_minor, 'public', p_public));
  return public.platform_plans();
exception when check_violation then
  raise exception 'plan codes are lowercase letters, numbers and _' using errcode = '22023';
end $$;

create or replace function public.platform_audit_recent(p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_platform_admin();
  return (select coalesce(jsonb_agg(to_jsonb(a) order by a.id desc), '[]'::jsonb)
            from (select * from app.platform_audit order by id desc limit least(greatest(p_limit, 1), 200)) a);
end $$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke all on function app.require_platform_admin(), app.platform_log(text, jsonb), app.owner_restaurant_id(),
  app.apply_subscription_event(jsonb)
  from public, anon, authenticated;
revoke all on function public.am_platform_admin(), public.subscription_overview(), public.start_subscription(text),
  public.platform_restaurants(text), public.platform_update_restaurant(uuid, jsonb), public.platform_plans(),
  public.platform_save_plan(text, text, int, text, boolean), public.platform_audit_recent(int)
  from public, anon, authenticated;
grant execute on function public.am_platform_admin(), public.subscription_overview(), public.start_subscription(text),
  public.platform_restaurants(text), public.platform_update_restaurant(uuid, jsonb), public.platform_plans(),
  public.platform_save_plan(text, text, int, text, boolean), public.platform_audit_recent(int)
  to authenticated;

