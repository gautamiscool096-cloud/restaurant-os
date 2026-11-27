-- =====================================================================
-- Phase 1 / migration 2: tenant resolution, RBAC, RLS, guard triggers,
-- audit trail, grants, realtime.
--
-- Isolation model
--   * A logged-in user's tenant is resolved ONLY from the `staff` table
--     (staff.user_id is unique, so a login maps to exactly one restaurant).
--     Nothing the client sends (URL, header, body) is used to pick a tenant.
--   * Every tenant-table policy compares row.restaurant_id to that resolved id.
--   * If the tenant is suspended, cancelled, or its trial/grace has expired,
--     app.current_restaurant_id() returns NULL and every tenant table goes dark.
--     Staff can still read their own `restaurants` row (to see billing state).
--   * `anon` has no table privileges at all. Customers use the SECURITY
--     DEFINER functions in migration 3, which take (slug, qr_token) together.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tenant / role resolution helpers
-- ---------------------------------------------------------------------
create or replace function app.tenant_is_operational(p_restaurant_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.restaurants r
    where r.id = p_restaurant_id
      and r.suspended_at is null
      and (
            r.subscription_status = 'active'
         or (r.subscription_status = 'trialing' and r.trial_ends_at > now())
         or (r.subscription_status = 'past_due'
             and coalesce(r.current_period_end, now()) + interval '7 days' > now())
      )
  );
$$;

-- Tenant of the logged-in staff member, regardless of billing state.
create or replace function app.staff_restaurant_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.restaurant_id from public.staff s
  where s.user_id = auth.uid() and s.is_active
$$;

-- Tenant of the logged-in staff member, only while the tenant may operate.
create or replace function app.current_restaurant_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.restaurant_id from public.staff s
  where s.user_id = auth.uid() and s.is_active
    and app.tenant_is_operational(s.restaurant_id)
$$;

create or replace function app.current_role()
returns public.staff_role language sql stable security definer set search_path = '' as $$
  select s.role from public.staff s
  where s.user_id = auth.uid() and s.is_active
    and app.tenant_is_operational(s.restaurant_id)
$$;

create or replace function app.current_staff_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.id from public.staff s
  where s.user_id = auth.uid() and s.is_active
$$;

create or replace function app.has_role(variadic p_roles public.staff_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(app.current_role() = any (p_roles), false)
$$;

create or replace function app.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins p where p.user_id = auth.uid())
$$;

-- True when the statement comes straight from an API client (PostgREST
-- request as `authenticated`/`anon`), as opposed to our own SECURITY DEFINER
-- functions, migrations or the service role.
create or replace function app.is_client_request()
returns boolean language sql stable set search_path = '' as $$
  select current_user in ('authenticated', 'anon')
$$;

-- ---------------------------------------------------------------------
-- Generic guard triggers
-- ---------------------------------------------------------------------
create or replace function app.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function app.lock_restaurant_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.restaurant_id is distinct from old.restaurant_id then
    raise exception 'restaurant_id is immutable' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function app.audit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_row  jsonb := to_jsonb(coalesce(new, old));
  v_rid  uuid;
begin
  v_rid := case when tg_table_name = 'restaurants'
                then (v_row ->> 'id')::uuid
                else (v_row ->> 'restaurant_id')::uuid end;
  insert into public.audit_log (restaurant_id, actor_user_id, actor_role, table_name,
                                record_id, action, old_data, new_data)
  values (v_rid, auth.uid(),
          coalesce(app.current_role()::text,
                   case when app.is_platform_admin() then 'platform_admin' end,
                   current_user),
          tg_table_name, (v_row ->> 'id')::uuid, tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;

-- Attach updated_at / immutability / audit triggers to every tenant table.
do $$
declare t text;
begin
  foreach t in array array['restaurant_settings','staff','dining_tables','menu_categories',
                           'menu_items','table_sessions','table_session_secrets','orders','order_items','payments','reviews']
  loop
    execute format('create trigger lock_restaurant_id before update on public.%I
                    for each row execute function app.lock_restaurant_id()', t);
  end loop;

  foreach t in array array['restaurants','restaurant_settings','staff','dining_tables','menu_categories',
                           'menu_items','orders','order_items','payments','reviews']
  loop
    execute format('create trigger set_updated_at before update on public.%I
                    for each row execute function app.set_updated_at()', t);
  end loop;

  foreach t in array array['restaurants','restaurant_settings','staff','dining_tables','menu_categories',
                           'menu_items','orders','order_items','payments','reviews']
  loop
    execute format('create trigger audit after insert or update or delete on public.%I
                    for each row execute function app.audit()', t);
  end loop;
end $$;

-- Billing / suspension / slug columns can only be changed by platform admins
-- (or server-side by the service role, e.g. a billing webhook).
create or replace function app.guard_restaurant_platform_columns()
returns trigger language plpgsql set search_path = '' as $$
begin
  if app.is_client_request() and not app.is_platform_admin() and (
       new.slug                    is distinct from old.slug
    or new.plan                    is distinct from old.plan
    or new.subscription_status     is distinct from old.subscription_status
    or new.trial_ends_at           is distinct from old.trial_ends_at
    or new.current_period_end      is distinct from old.current_period_end
    or new.billing_customer_id     is distinct from old.billing_customer_id
    or new.billing_subscription_id is distinct from old.billing_subscription_id
    or new.suspended_at            is distinct from old.suspended_at
    or new.suspended_reason        is distinct from old.suspended_reason
    or new.payout_account_id       is distinct from old.payout_account_id
    or new.payout_account_status   is distinct from old.payout_account_status
  ) then
    raise exception 'only the platform can change billing, suspension or slug fields'
      using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_platform_columns before update on public.restaurants
  for each row execute function app.guard_restaurant_platform_columns();

-- order_seq is a server-side counter, never client-editable.
create or replace function app.guard_settings_counter()
returns trigger language plpgsql set search_path = '' as $$
begin
  if app.is_client_request() and new.order_seq is distinct from old.order_seq then
    raise exception 'order_seq is managed by the server' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_settings_counter before update on public.restaurant_settings
  for each row execute function app.guard_settings_counter();

-- Staff: nobody can mint an owner or change their own role through the API.
create or replace function app.guard_staff()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not app.is_client_request() then
    return new;
  end if;
  if tg_op = 'INSERT' and new.role = 'owner' then
    raise exception 'owners are created by onboarding only' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id then
      raise exception 'staff.user_id is immutable' using errcode = '42501';
    end if;
    if old.role = 'owner' or new.role = 'owner' then
      if new.role is distinct from old.role or not new.is_active then
        raise exception 'owner role cannot be changed through the API' using errcode = '42501';
      end if;
    end if;
    if old.user_id = auth.uid() and new.role is distinct from old.role then
      raise exception 'cannot change your own role' using errcode = '42501';
    end if;
  end if;
  -- managers may only manage floor/kitchen staff
  if app.has_role('manager') and (new.role in ('owner', 'manager')
       or (tg_op = 'UPDATE' and old.role in ('owner', 'manager') and old.user_id <> auth.uid())) then
    raise exception 'managers can only manage waiter, chef and cashier accounts' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_staff before insert or update on public.staff
  for each row execute function app.guard_staff();

-- ---------------------------------------------------------------------
-- Order workflow guards (role-aware state machine)
-- ---------------------------------------------------------------------
create or replace function app.next_order_number(p_restaurant_id uuid)
returns bigint language sql security definer set search_path = '' as $$
  update public.restaurant_settings
     set order_seq = order_seq + 1
   where restaurant_id = p_restaurant_id
  returning order_seq
$$;

create or replace function app.orders_before_insert()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.order_number := app.next_order_number(new.restaurant_id);
  if app.is_client_request() then
    new.created_by_staff_id := app.current_staff_id();
    new.status := 'pending';
    new.is_paid := false;
    new.approved_by := null;
    new.approved_at := null;
  end if;
  return new;
end $$;
create trigger orders_before_insert before insert on public.orders
  for each row execute function app.orders_before_insert();

-- Columns a non-manager is allowed to touch on an order / order item.
create or replace function app.only_changed(p_old jsonb, p_new jsonb, p_allowed text[])
returns boolean language sql immutable set search_path = '' as $$
  select (p_old - p_allowed) = (p_new - p_allowed)
$$;

create or replace function app.orders_before_update()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_role public.staff_role := app.current_role();
begin
  if new.status = 'approved' and old.status = 'pending' then
    new.approved_at := now();
    new.approved_by := coalesce(app.current_staff_id(), new.approved_by);
  end if;
  if new.status = 'served' and old.status <> 'served' then
    new.served_at := now();
  end if;

  if not app.is_client_request() or v_role in ('owner', 'manager') then
    return new;
  end if;

  if not app.only_changed(to_jsonb(old), to_jsonb(new),
                          array['status', 'served_at', 'updated_at']) then
    raise exception '% may only change order status', v_role using errcode = '42501';
  end if;

  if new.status is distinct from old.status and not (
       (v_role = 'chef'   and (old.status, new.status) in (('approved','preparing'), ('preparing','ready')))
    or (v_role = 'waiter' and new.status = 'served' and old.status in ('approved','preparing','ready'))
  ) then
    raise exception '% cannot move an order from % to %', v_role, old.status, new.status
      using errcode = '42501';
  end if;
  return new;
end $$;
create trigger orders_before_update before update on public.orders
  for each row execute function app.orders_before_update();

create or replace function app.order_items_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_role   public.staff_role := app.current_role();
  v_status public.order_status;
begin
  if tg_op = 'UPDATE' then
    if new.status = 'preparing' and old.status <> 'preparing' then new.started_at := now(); end if;
    if new.status = 'ready'     and old.status <> 'ready'     then new.ready_at   := now(); end if;
    if new.status = 'served'    and old.status <> 'served'    then new.served_at  := now(); end if;
  end if;

  if not app.is_client_request() or v_role in ('owner', 'manager') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- waiters can take orders at the table; price always comes from the menu
    if v_role <> 'waiter' then
      raise exception '% cannot add order items', v_role using errcode = '42501';
    end if;
    select o.status into v_status from public.orders o
     where o.restaurant_id = new.restaurant_id and o.id = new.order_id;
    if v_status <> 'pending' then
      raise exception 'items can only be added to pending orders' using errcode = '42501';
    end if;
    select m.name, m.price_minor into new.name_snapshot, new.unit_price_minor
      from public.menu_items m
     where m.restaurant_id = new.restaurant_id and m.id = new.menu_item_id;
    new.status := 'pending';
    return new;
  end if;

  if not app.only_changed(to_jsonb(old), to_jsonb(new),
                          array['status', 'started_at', 'ready_at', 'served_at', 'updated_at']) then
    raise exception '% may only change item status', v_role using errcode = '42501';
  end if;

  select o.status into v_status from public.orders o
   where o.restaurant_id = new.restaurant_id and o.id = new.order_id;

  if new.status is distinct from old.status and not (
       (v_role = 'chef' and v_status in ('approved','preparing','ready')
                        and (old.status, new.status) in (('pending','preparing'), ('preparing','ready')))
    or (v_role = 'waiter' and old.status = 'ready' and new.status = 'served')
  ) then
    raise exception '% cannot move an item from % to %', v_role, old.status, new.status
      using errcode = '42501';
  end if;
  return new;
end $$;
create trigger order_items_guard before insert or update on public.order_items
  for each row execute function app.order_items_guard();

-- Cash collected at the table is the only payment staff create directly;
-- online payments are created/updated by the server (service role) from
-- gateway webhooks.
create or replace function app.payments_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not app.is_client_request() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.method <> 'cash' then
      raise exception 'online payments are recorded by the gateway webhook' using errcode = '42501';
    end if;
    new.status := 'captured';
    new.settlement_status := 'not_applicable';
    new.collected_by := app.current_staff_id();
    new.gateway := null; new.gateway_order_id := null; new.gateway_payment_id := null;
    new.platform_fee_minor := 0;
  elsif tg_op = 'UPDATE' then
    if not app.has_role('owner', 'manager') then
      raise exception 'only owners and managers can edit payments' using errcode = '42501';
    end if;
    if old.method = 'online' and not app.only_changed(to_jsonb(old), to_jsonb(new), array['updated_at']) then
      raise exception 'online payments are managed by the gateway' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger payments_guard before insert or update on public.payments
  for each row execute function app.payments_guard();

-- ---------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------
alter table public.restaurants         enable row level security;
alter table public.restaurant_settings enable row level security;
alter table public.platform_admins     enable row level security;
alter table public.staff               enable row level security;
alter table public.dining_tables       enable row level security;
alter table public.menu_categories     enable row level security;
alter table public.menu_items          enable row level security;
alter table public.table_sessions      enable row level security;
alter table public.orders              enable row level security;
alter table public.order_items         enable row level security;
alter table public.payments            enable row level security;
alter table public.reviews             enable row level security;
alter table public.audit_log           enable row level security;
alter table public.table_session_secrets enable row level security;

alter table public.restaurants         force row level security;
alter table public.restaurant_settings force row level security;
alter table public.platform_admins     force row level security;
alter table public.staff               force row level security;
alter table public.dining_tables       force row level security;
alter table public.menu_categories     force row level security;
alter table public.menu_items          force row level security;
alter table public.table_sessions      force row level security;
alter table public.orders              force row level security;
alter table public.order_items         force row level security;
alter table public.payments            force row level security;
alter table public.reviews             force row level security;
alter table public.audit_log           force row level security;
alter table public.table_session_secrets force row level security;

-- restaurants -----------------------------------------------------------
create policy restaurants_select on public.restaurants for select to authenticated
  using (id = (select app.staff_restaurant_id()) or (select app.is_platform_admin()));
create policy restaurants_update on public.restaurants for update to authenticated
  using (   (id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')))
         or (select app.is_platform_admin()))
  with check (   (id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')))
              or (select app.is_platform_admin()));
-- inserts happen only through public.create_restaurant(); deletes only by service role.

-- restaurant_settings -----------------------------------------------------
create policy settings_select on public.restaurant_settings for select to authenticated
  using (restaurant_id = (select app.current_restaurant_id()));
create policy settings_update on public.restaurant_settings for update to authenticated
  using      (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')))
  with check (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')));

-- platform_admins: visible only to platform admins; managed by service role
create policy platform_admins_select on public.platform_admins for select to authenticated
  using ((select app.is_platform_admin()));

-- staff -----------------------------------------------------------------
create policy staff_select on public.staff for select to authenticated
  using (restaurant_id = (select app.current_restaurant_id()) or user_id = (select auth.uid()));
create policy staff_insert on public.staff for insert to authenticated
  with check (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')));
create policy staff_update on public.staff for update to authenticated
  using      (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')))
  with check (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')));
create policy staff_delete on public.staff for delete to authenticated
  using (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner'))
         and role <> 'owner');

-- Helper macro: tenant tables where every staff member reads, managers write
do $$
declare t text;
begin
  foreach t in array array['dining_tables','menu_categories','menu_items']
  loop
    execute format($f$
      create policy %1$s_select on public.%1$I for select to authenticated
        using (restaurant_id = (select app.current_restaurant_id()));
      create policy %1$s_insert on public.%1$I for insert to authenticated
        with check (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')));
      create policy %1$s_update on public.%1$I for update to authenticated
        using      (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')))
        with check (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')));
      create policy %1$s_delete on public.%1$I for delete to authenticated
        using (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')));
    $f$, t);
  end loop;
end $$;

-- table_sessions ----------------------------------------------------------
create policy sessions_select on public.table_sessions for select to authenticated
  using (restaurant_id = (select app.current_restaurant_id()));
create policy sessions_update on public.table_sessions for update to authenticated
  using      (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager','waiter','cashier')))
  with check (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager','waiter','cashier')));
-- sessions are opened by public.place_order() (customer) or staff RPCs.

-- orders --------------------------------------------------------------------
create policy orders_select on public.orders for select to authenticated
  using (restaurant_id = (select app.current_restaurant_id()));
create policy orders_insert on public.orders for insert to authenticated
  with check (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager','waiter')));
create policy orders_update on public.orders for update to authenticated
  using      (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager','waiter','chef')))
  with check (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager','waiter','chef')));

-- order_items -----------------------------------------------------------------
create policy order_items_select on public.order_items for select to authenticated
  using (restaurant_id = (select app.current_restaurant_id()));
create policy order_items_insert on public.order_items for insert to authenticated
  with check (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager','waiter')));
create policy order_items_update on public.order_items for update to authenticated
  using      (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager','waiter','chef')))
  with check (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager','waiter','chef')));
create policy order_items_delete on public.order_items for delete to authenticated
  using (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')));

-- payments (kitchen has no business seeing money) --------------------------------
create policy payments_select on public.payments for select to authenticated
  using (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager','waiter','cashier')));
create policy payments_insert on public.payments for insert to authenticated
  with check (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager','waiter','cashier')));
create policy payments_update on public.payments for update to authenticated
  using      (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')))
  with check (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')));

-- reviews ---------------------------------------------------------------------
create policy reviews_select on public.reviews for select to authenticated
  using (restaurant_id = (select app.current_restaurant_id()));
create policy reviews_update on public.reviews for update to authenticated
  using      (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')))
  with check (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')));

-- audit_log: owners/managers read their own tenant; nobody writes via API ---------
create policy audit_select on public.audit_log for select to authenticated
  using (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner','manager')));

-- Reviews may only change their response fields through the API.
create or replace function app.reviews_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if app.is_client_request() then
    if not app.only_changed(to_jsonb(old), to_jsonb(new),
                            array['response', 'responded_by', 'responded_at', 'updated_at']) then
      raise exception 'only the response can be edited' using errcode = '42501';
    end if;
    new.responded_by := app.current_staff_id();
    new.responded_at := now();
  end if;
  return new;
end $$;
create trigger reviews_guard before update on public.reviews
  for each row execute function app.reviews_guard();

-- ---------------------------------------------------------------------
-- Grants. Supabase grants ALL on new public tables to anon/authenticated
-- by default; take that back and grant only what the policies expect.
-- ---------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema app    from public, anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on functions from public;

grant usage on schema app to authenticated;
grant execute on function
  app.tenant_is_operational(uuid), app.staff_restaurant_id(), app.current_restaurant_id(),
  app.current_role(), app.current_staff_id(), app.has_role(public.staff_role[]),
  app.is_platform_admin(), app.is_client_request(), app.only_changed(jsonb, jsonb, text[]),
  app.set_updated_at(), app.lock_restaurant_id(), app.guard_restaurant_platform_columns(),
  app.guard_settings_counter(), app.guard_staff(), app.orders_before_insert(),
  app.orders_before_update(), app.order_items_guard(), app.payments_guard(), app.reviews_guard(),
  app.audit(), app.next_order_number(uuid)
to authenticated;

grant select, update                 on public.restaurants         to authenticated;
grant select, update                 on public.restaurant_settings to authenticated;
grant select                         on public.platform_admins     to authenticated;
grant select, insert, update, delete on public.staff               to authenticated;
grant select, insert, update, delete on public.dining_tables       to authenticated;
grant select, insert, update, delete on public.menu_categories     to authenticated;
grant select, insert, update, delete on public.menu_items          to authenticated;
grant select, update                 on public.table_sessions      to authenticated;
grant select, insert, update         on public.orders              to authenticated;
grant select, insert, update, delete on public.order_items         to authenticated;
grant select, insert, update         on public.payments            to authenticated;
grant select, update                 on public.reviews             to authenticated;
grant select                         on public.audit_log           to authenticated;
-- public.table_session_secrets: intentionally no grants and no policies.

-- ---------------------------------------------------------------------
-- Realtime: postgres_changes runs every change through the subscriber's
-- RLS policies, so staff only ever receive their own tenant's events.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.orders, public.order_items, public.table_sessions, public.payments, public.dining_tables;
  end if;
end $$;
