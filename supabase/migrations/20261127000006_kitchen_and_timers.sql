-- =====================================================================
-- Phase 5 / migration 6: kitchen display, waiter screen, order timers
--   * every order stage gets a server-side timestamp
--     (created -> approved -> preparing -> ready -> served), so screens
--     can show how long each step took and flag late orders
--   * stage timestamps come from the database clock only: no client,
--     not even a manager, can backdate or edit them
--   * an order's dishes follow the order (start cooking -> all dishes
--     cooking; ready -> all ready; served -> all served)
--   * advance_order() is SECURITY INVOKER: the role rules in
--     app.orders_before_update decide who may move an order where
-- =====================================================================

alter table public.orders
  add column preparing_at timestamptz,
  add column ready_at     timestamptz;

create index on public.orders (restaurant_id, status, approved_at);

-- ---------------------------------------------------------------------
-- Order state machine, now stamping every stage
-- ---------------------------------------------------------------------
create or replace function app.orders_before_update()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_role public.staff_role := app.current_role();
begin
  -- Stage times are written by the database only.
  if app.is_client_request() then
    new.approved_at  := old.approved_at;
    new.preparing_at := old.preparing_at;
    new.ready_at     := old.ready_at;
    new.served_at    := old.served_at;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'approved' and old.status = 'pending' then
      new.approved_at := now();
      new.approved_by := coalesce(app.current_staff_id(), new.approved_by);
    elsif new.status = 'preparing' then
      new.preparing_at := now();
    elsif new.status = 'ready' then
      new.ready_at := now();
    elsif new.status = 'served' then
      new.served_at := now();
    end if;
  end if;

  if not app.is_client_request() or v_role in ('owner', 'manager') then
    return new;
  end if;

  if not app.only_changed(to_jsonb(old), to_jsonb(new),
                          array['status', 'preparing_at', 'ready_at', 'served_at', 'updated_at']) then
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

-- ---------------------------------------------------------------------
-- Dishes follow their order. Runs as the definer after the order's own
-- role checks have passed; cancelled or already-served dishes are left
-- alone, and dishes never move backwards.
-- ---------------------------------------------------------------------
create or replace function app.orders_sync_items()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_from public.order_item_status[];
begin
  v_from := case new.status
    when 'preparing' then array['pending']::public.order_item_status[]
    when 'ready'     then array['pending', 'preparing']::public.order_item_status[]
    when 'served'    then array['pending', 'preparing', 'ready']::public.order_item_status[]
    else null end;
  if v_from is not null then
    update public.order_items i
       set status = new.status::text::public.order_item_status
     where i.restaurant_id = new.restaurant_id and i.order_id = new.id and i.status = any (v_from);
  end if;
  return null;
end $$;
create trigger orders_sync_items after update of status on public.orders
  for each row when (new.status is distinct from old.status)
  execute function app.orders_sync_items();

-- ---------------------------------------------------------------------
-- Board: now includes every stage time
-- ---------------------------------------------------------------------
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
               'created_at', o.created_at, 'approved_at', o.approved_at, 'preparing_at', o.preparing_at,
               'ready_at', o.ready_at, 'served_at', o.served_at, 'updated_at', o.updated_at,
               'by_staff', o.created_by_staff_id is not null,
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

-- ---------------------------------------------------------------------
-- One step forward for an order: start cooking, ready, served.
-- Who may take which step is enforced by app.orders_before_update.
-- ---------------------------------------------------------------------
create or replace function public.advance_order(p_order_id uuid, p_to public.order_status)
returns public.orders language plpgsql security invoker set search_path = '' as $$
declare
  v public.orders;
  v_from public.order_status[];
begin
  v_from := case p_to
    when 'preparing' then array['approved']::public.order_status[]
    when 'ready'     then array['preparing']::public.order_status[]
    when 'served'    then array['approved', 'preparing', 'ready']::public.order_status[]
    else null end;
  if v_from is null then
    raise exception 'an order can only be moved to cooking, ready or served here' using errcode = '22023';
  end if;
  update public.orders set status = p_to
   where id = p_order_id and status = any (v_from)
  returning * into v;
  if not found then
    raise exception 'this order has already moved on' using errcode = 'P0002';
  end if;
  return v;
end $$;

revoke all on function app.orders_sync_items(), public.advance_order(uuid, public.order_status) from public, anon;
grant execute on function public.advance_order(uuid, public.order_status) to authenticated;
grant execute on function public.staff_board() to authenticated;
