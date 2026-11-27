-- =====================================================================
-- Phase 4 / migration 5: manager approval flow and floor view
--   * order totals are always recomputed by the database from order_items
--   * order lines can be edited (qty / add / remove) only while pending;
--     managers can cancel a single line at any time (e.g. ran out)
--   * table sessions can only be closed (never reopened) through the API
--   * staff RPCs are SECURITY INVOKER: they run as the caller, so every
--     row they touch still goes through RLS and the guard triggers
-- =====================================================================

-- ---------------------------------------------------------------------
-- Totals
-- ---------------------------------------------------------------------
create or replace function app.recompute_order_totals(p_restaurant_id uuid, p_order_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  s        public.restaurant_settings;
  v_sub    int;
  v_svc    int;
  v_tax    int;
begin
  select * into s from public.restaurant_settings where restaurant_id = p_restaurant_id;
  select coalesce(sum(i.unit_price_minor * i.quantity), 0) into v_sub
    from public.order_items i
   where i.restaurant_id = p_restaurant_id and i.order_id = p_order_id and i.status <> 'cancelled';
  v_svc := round(v_sub * s.service_charge_percent / 100.0);
  v_tax := case when s.prices_include_tax then 0 else round((v_sub + v_svc) * s.tax_percent / 100.0) end;
  update public.orders o
     set subtotal_minor = v_sub, service_charge_minor = v_svc, tax_minor = v_tax,
         total_minor = v_sub + v_svc + v_tax
   where o.restaurant_id = p_restaurant_id and o.id = p_order_id
     and (o.subtotal_minor, o.service_charge_minor, o.tax_minor, o.total_minor)
         is distinct from (v_sub, v_svc, v_tax, v_sub + v_svc + v_tax);
end $$;

create or replace function app.order_items_recompute()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform app.recompute_order_totals(coalesce(new.restaurant_id, old.restaurant_id),
                                     coalesce(new.order_id, old.order_id));
  return null;
end $$;
create trigger order_items_recompute after insert or update or delete on public.order_items
  for each row execute function app.order_items_recompute();

-- Totals are never client-editable, even by managers.
create or replace function app.guard_order_totals()
returns trigger language plpgsql set search_path = '' as $$
begin
  if app.is_client_request() and (new.subtotal_minor, new.service_charge_minor, new.tax_minor, new.total_minor)
       is distinct from (old.subtotal_minor, old.service_charge_minor, old.tax_minor, old.total_minor) then
    raise exception 'order totals are calculated by the system' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_order_totals before update on public.orders
  for each row execute function app.guard_order_totals();

-- ---------------------------------------------------------------------
-- Line edits: only while the order is pending; price always from menu
-- ---------------------------------------------------------------------
create or replace function app.order_items_edit_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_status public.order_status;
begin
  if not app.is_client_request() then
    return coalesce(new, old);
  end if;
  select o.status into v_status from public.orders o
   where o.restaurant_id = coalesce(new.restaurant_id, old.restaurant_id)
     and o.id = coalesce(new.order_id, old.order_id);

  if tg_op = 'INSERT' then
    if v_status <> 'pending' then
      raise exception 'items can only be added while the order is waiting for approval' using errcode = '42501';
    end if;
    select m.name, m.price_minor into new.name_snapshot, new.unit_price_minor
      from public.menu_items m
     where m.restaurant_id = new.restaurant_id and m.id = new.menu_item_id;
    new.status := 'pending';
    return new;
  elsif tg_op = 'DELETE' then
    if v_status <> 'pending' then
      raise exception 'items can only be removed while the order is waiting for approval' using errcode = '42501';
    end if;
    return old;
  else
    if (new.quantity, new.unit_price_minor, new.menu_item_id, new.name_snapshot)
         is distinct from (old.quantity, old.unit_price_minor, old.menu_item_id, old.name_snapshot) then
      if v_status <> 'pending' then
        raise exception 'quantities can only change while the order is waiting for approval' using errcode = '42501';
      end if;
      if new.unit_price_minor is distinct from old.unit_price_minor
         or new.menu_item_id is distinct from old.menu_item_id
         or new.name_snapshot is distinct from old.name_snapshot then
        raise exception 'only the quantity of a line can be changed' using errcode = '42501';
      end if;
    end if;
    if new.status = 'cancelled' and old.status <> 'cancelled' and not app.has_role('owner', 'manager') then
      raise exception 'only managers can cancel an item' using errcode = '42501';
    end if;
    return new;
  end if;
end $$;
-- runs before order_items_guard (trigger names fire alphabetically)
create trigger order_items_edit_guard before insert or update or delete on public.order_items
  for each row execute function app.order_items_edit_guard();

-- ---------------------------------------------------------------------
-- Table sessions: the API may only close an open session
-- ---------------------------------------------------------------------
create or replace function app.table_sessions_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not app.is_client_request() then
    return new;
  end if;
  if (new.id, new.table_id, new.opened_at) is distinct from (old.id, old.table_id, old.opened_at)
     or (old.status = 'closed' and new.status = 'open') then
    raise exception 'a table session can only be closed' using errcode = '42501';
  end if;
  if new.status = 'closed' and old.status = 'open' then
    new.closed_at := now();
  end if;
  return new;
end $$;
create trigger table_sessions_guard before update on public.table_sessions
  for each row execute function app.table_sessions_guard();

-- ---------------------------------------------------------------------
-- Staff RPCs (SECURITY INVOKER: RLS applies to everything they read/write)
-- ---------------------------------------------------------------------

-- Everything the live board and floor view need, in one round trip:
-- every active table, its open session (if any) and that session's orders.
create or replace function public.staff_board()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'table_id', t.id, 'number', t.number, 'label', t.label, 'seats', t.seats,
    'assigned_waiter_id', t.assigned_waiter_id,
    'session', case when s.id is null then null else jsonb_build_object(
        'id', s.id, 'opened_at', s.opened_at,
        'last_activity_at', greatest(s.last_activity_at, (select max(o.updated_at) from public.orders o
                                                          where o.restaurant_id = s.restaurant_id and o.session_id = s.id)))
      end,
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', o.id, 'order_number', o.order_number, 'status', o.status, 'is_paid', o.is_paid,
               'customer_note', o.customer_note, 'rejected_reason', o.rejected_reason,
               'subtotal_minor', o.subtotal_minor, 'service_charge_minor', o.service_charge_minor,
               'tax_minor', o.tax_minor, 'total_minor', o.total_minor,
               'created_at', o.created_at, 'approved_at', o.approved_at, 'by_staff', o.created_by_staff_id is not null,
               'items', coalesce((
                  select jsonb_agg(jsonb_build_object(
                           'id', i.id, 'menu_item_id', i.menu_item_id, 'name', i.name_snapshot,
                           'quantity', i.quantity, 'unit_price_minor', i.unit_price_minor,
                           'special_instructions', i.special_instructions, 'status', i.status)
                         order by i.created_at)
                  from public.order_items i where i.restaurant_id = o.restaurant_id and i.order_id = o.id), '[]'::jsonb))
             order by o.created_at)
      from public.orders o
      where o.restaurant_id = t.restaurant_id and o.session_id = s.id), '[]'::jsonb))
    order by t.number), '[]'::jsonb)
  from public.dining_tables t
  left join public.table_sessions s
    on s.restaurant_id = t.restaurant_id and s.table_id = t.id and s.status = 'open'
  where t.is_active
$$;

create or replace function public.approve_order(p_order_id uuid)
returns public.orders language plpgsql security invoker set search_path = '' as $$
declare v public.orders;
begin
  update public.orders set status = 'approved'
   where id = p_order_id and status = 'pending'
  returning * into v;
  if not found then
    raise exception 'this order is no longer waiting for approval' using errcode = 'P0002';
  end if;
  return v;
end $$;

create or replace function public.reject_order(p_order_id uuid, p_reason text default null)
returns public.orders language plpgsql security invoker set search_path = '' as $$
declare v public.orders;
begin
  update public.orders
     set status = 'rejected', rejected_reason = nullif(trim(p_reason), '')
   where id = p_order_id and status = 'pending'
  returning * into v;
  if not found then
    raise exception 'this order is no longer waiting for approval' using errcode = 'P0002';
  end if;
  return v;
end $$;

-- p_lines: [{"order_item_id": uuid, "quantity": int}]  (0 = remove)
-- p_add:   [{"menu_item_id": uuid, "quantity": int, "special_instructions": text}]
create or replace function public.edit_order(p_order_id uuid, p_lines jsonb default '[]', p_add jsonb default '[]')
returns public.orders language plpgsql security invoker set search_path = '' as $$
declare
  v_order public.orders;
  l       jsonb;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order not found' using errcode = 'P0002';
  end if;

  for l in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    if (l ->> 'quantity')::int <= 0 then
      delete from public.order_items
       where id = (l ->> 'order_item_id')::uuid and order_id = p_order_id;
    else
      update public.order_items set quantity = (l ->> 'quantity')::int
       where id = (l ->> 'order_item_id')::uuid and order_id = p_order_id;
    end if;
  end loop;

  for l in select * from jsonb_array_elements(coalesce(p_add, '[]')) loop
    insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, unit_price_minor,
                                    quantity, special_instructions)
    values (v_order.restaurant_id, p_order_id, (l ->> 'menu_item_id')::uuid, '', 0,
            (l ->> 'quantity')::int, nullif(trim(l ->> 'special_instructions'), ''));
  end loop;

  if not exists (select 1 from public.order_items where order_id = p_order_id) then
    raise exception 'an order needs at least one item; reject it instead' using errcode = '22023';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  return v_order;
end $$;

create or replace function public.close_table_session(p_session_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.table_sessions set status = 'closed' where id = p_session_id and status = 'open';
  if not found then
    raise exception 'this table is already free' using errcode = 'P0002';
  end if;
end $$;

-- Menu lookup for the "add item" picker (staff side, RLS applies).
create or replace function public.staff_menu()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'name', m.name, 'price_minor', m.price_minor, 'is_veg', m.is_veg,
           'is_available', m.is_available, 'category', c.name)
         order by c.sort_order, m.sort_order, m.name), '[]'::jsonb)
  from public.menu_items m
  join public.menu_categories c on c.restaurant_id = m.restaurant_id and c.id = m.category_id
$$;

revoke all on function app.recompute_order_totals(uuid, uuid), app.order_items_recompute(),
  app.guard_order_totals(), app.order_items_edit_guard(), app.table_sessions_guard() from public, anon;
grant execute on function app.recompute_order_totals(uuid, uuid), app.order_items_recompute(),
  app.guard_order_totals(), app.order_items_edit_guard(), app.table_sessions_guard() to authenticated;

revoke all on function public.staff_board(), public.approve_order(uuid), public.reject_order(uuid, text),
  public.edit_order(uuid, jsonb, jsonb), public.close_table_session(uuid), public.staff_menu() from public, anon;
grant execute on function public.staff_board(), public.approve_order(uuid), public.reject_order(uuid, text),
  public.edit_order(uuid, jsonb, jsonb), public.close_table_session(uuid), public.staff_menu() to authenticated;

-- my_context now also returns the restaurant's currency.
create or replace function public.my_context()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'staff_id', s.id,
    'role', s.role,
    'display_name', s.display_name,
    'is_platform_admin', app.is_platform_admin(),
    'operational', app.tenant_is_operational(r.id),
    'restaurant', jsonb_build_object(
      'id', r.id, 'slug', r.slug, 'name', r.name, 'logo_url', r.logo_url, 'currency', r.currency,
      'brand_primary_color', r.brand_primary_color, 'brand_accent_color', r.brand_accent_color,
      'subscription_status', r.subscription_status, 'trial_ends_at', r.trial_ends_at,
      'current_period_end', r.current_period_end, 'suspended', r.suspended_at is not null))
  from public.staff s
  join public.restaurants r on r.id = s.restaurant_id
  where s.user_id = auth.uid() and s.is_active
$$;
