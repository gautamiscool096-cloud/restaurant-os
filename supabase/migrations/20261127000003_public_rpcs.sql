-- =====================================================================
-- Phase 1 / migration 3: the only entry points that cross the RLS wall.
-- Each is SECURITY DEFINER and does its own tenant scoping explicitly.
--
--   Onboarding (authenticated, no tenant yet):  create_restaurant
--   Customer QR flow (anon):                    get_public_menu, resolve_table,
--                                               place_order, get_session_orders,
--                                               submit_review
--   Platform super-admin:                       platform_metrics
-- =====================================================================

create or replace function app.sha256(p text)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(convert_to(p, 'UTF8'), 'sha256'), 'hex')
$$;

-- ---------------------------------------------------------------------
-- Self-serve onboarding: signup -> restaurant -> empty menu + default tables
-- ---------------------------------------------------------------------
create or replace function public.create_restaurant(
  p_name          text,
  p_slug          text,
  p_owner_name    text,
  p_address       text default null,
  p_cuisine_type  text default null,
  p_logo_url      text default null,
  p_table_count   int  default 10
) returns public.restaurants
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_r   public.restaurants;
begin
  if v_uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  if exists (select 1 from public.staff where user_id = v_uid) then
    raise exception 'this account already belongs to a restaurant' using errcode = '23505';
  end if;
  if p_table_count not between 1 and 200 then
    raise exception 'table count must be between 1 and 200' using errcode = '22023';
  end if;

  insert into public.restaurants (name, slug, address, cuisine_type, logo_url)
  values (trim(p_name), lower(trim(p_slug)), p_address, p_cuisine_type, p_logo_url)
  returning * into v_r;

  insert into public.restaurant_settings (restaurant_id) values (v_r.id);

  insert into public.staff (restaurant_id, user_id, role, display_name)
  values (v_r.id, v_uid, 'owner', coalesce(nullif(trim(p_owner_name), ''), 'Owner'));

  insert into public.dining_tables (restaurant_id, number, label)
  select v_r.id, n, 'Table ' || n from generate_series(1, p_table_count) n;

  insert into public.menu_categories (restaurant_id, name, sort_order)
  values (v_r.id, 'Starters', 1), (v_r.id, 'Mains', 2), (v_r.id, 'Desserts', 3), (v_r.id, 'Drinks', 4);

  return v_r;
end $$;

-- ---------------------------------------------------------------------
-- Customer: menu for a slug (branding, tax config, categories, items)
-- ---------------------------------------------------------------------
create or replace function public.get_public_menu(p_slug text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'restaurant', jsonb_build_object(
        'slug', r.slug, 'name', r.name, 'logo_url', r.logo_url,
        'brand_primary_color', r.brand_primary_color, 'brand_accent_color', r.brand_accent_color,
        'currency', r.currency, 'cuisine_type', r.cuisine_type, 'address', r.address),
    'settings', jsonb_build_object(
        'tax_percent', s.tax_percent, 'service_charge_percent', s.service_charge_percent,
        'prices_include_tax', s.prices_include_tax,
        'accepts_cash', s.accepts_cash, 'accepts_online', s.accepts_online),
    'categories', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', c.id, 'name', c.name,
                 'items', coalesce((
                    select jsonb_agg(jsonb_build_object(
                             'id', m.id, 'name', m.name, 'description', m.description,
                             'price_minor', m.price_minor, 'photo_url', m.photo_url,
                             'is_veg', m.is_veg, 'spice_level', m.spice_level,
                             'is_available', m.is_available)
                           order by m.sort_order, m.name)
                    from public.menu_items m
                    where m.restaurant_id = r.id and m.category_id = c.id), '[]'::jsonb))
               order by c.sort_order, c.name)
        from public.menu_categories c
        where c.restaurant_id = r.id and c.is_active), '[]'::jsonb))
  from public.restaurants r
  join public.restaurant_settings s on s.restaurant_id = r.id
  where r.slug = lower(p_slug)
    and app.tenant_is_operational(r.id)
$$;

-- ---------------------------------------------------------------------
-- Customer: QR -> table. Requires slug AND token; both must match the
-- same restaurant, so a token from restaurant B is useless under A's slug.
-- ---------------------------------------------------------------------
create or replace function public.resolve_table(p_slug text, p_qr_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('table_number', t.number, 'label', t.label)
  from public.dining_tables t
  join public.restaurants r on r.id = t.restaurant_id
  where r.slug = lower(p_slug)
    and t.qr_token = p_qr_token
    and t.is_active
    and app.tenant_is_operational(r.id)
$$;

-- ---------------------------------------------------------------------
-- Customer: place an order (or an add-on to the open table session).
--   p_items: [{"menu_item_id": uuid, "quantity": int, "special_instructions": text}]
-- Prices and totals are computed here from the DB; client prices are ignored.
-- Returns the session token the browser must keep to see status / add more.
-- ---------------------------------------------------------------------
create or replace function public.place_order(
  p_slug           text,
  p_qr_token       text,
  p_items          jsonb,
  p_note           text default null,
  p_session_token  text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_table     public.dining_tables;
  v_settings  public.restaurant_settings;
  v_session   uuid;
  v_token     text := p_session_token;
  v_order     public.orders;
  v_line      jsonb;
  v_item      public.menu_items;
  v_qty       int;
  v_subtotal  int := 0;
  v_tax       int;
  v_service   int;
begin
  select t.* into v_table
    from public.dining_tables t
    join public.restaurants r on r.id = t.restaurant_id
   where r.slug = lower(p_slug) and t.qr_token = p_qr_token and t.is_active
     and app.tenant_is_operational(r.id);
  if not found then
    raise exception 'unknown table' using errcode = 'P0002';
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'order must have between 1 and 50 lines' using errcode = '22023';
  end if;

  select * into v_settings from public.restaurant_settings where restaurant_id = v_table.restaurant_id;

  -- find or open the table session
  select ts.id into v_session from public.table_sessions ts
   where ts.restaurant_id = v_table.restaurant_id and ts.table_id = v_table.id and ts.status = 'open'
   for update;

  if v_session is null then
    v_token := encode(extensions.gen_random_bytes(24), 'hex');
    insert into public.table_sessions (restaurant_id, table_id)
    values (v_table.restaurant_id, v_table.id) returning id into v_session;
    insert into public.table_session_secrets (session_id, restaurant_id, token_hash)
    values (v_session, v_table.restaurant_id, app.sha256(v_token));
  elsif p_session_token is null or not exists (
          select 1 from public.table_session_secrets s
           where s.session_id = v_session and s.token_hash = app.sha256(p_session_token)) then
    raise exception 'this table already has an open order; ask your waiter to join it'
      using errcode = '42501';
  else
    update public.table_sessions set last_activity_at = now() where id = v_session;
  end if;

  insert into public.orders (restaurant_id, table_id, session_id, customer_note, status)
  values (v_table.restaurant_id, v_table.id, v_session, nullif(trim(p_note), ''),
          case when v_settings.require_order_approval then 'pending' else 'approved' end::public.order_status)
  returning * into v_order;

  for v_line in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_line ->> 'quantity')::int;
    select m.* into v_item from public.menu_items m
     where m.restaurant_id = v_table.restaurant_id      -- tenant pin
       and m.id = (v_line ->> 'menu_item_id')::uuid
       and m.is_available;
    if not found then
      raise exception 'item % is not available', v_line ->> 'menu_item_id' using errcode = 'P0002';
    end if;
    insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot,
                                    unit_price_minor, quantity, special_instructions)
    values (v_table.restaurant_id, v_order.id, v_item.id, v_item.name, v_item.price_minor, v_qty,
            nullif(trim(v_line ->> 'special_instructions'), ''));
    v_subtotal := v_subtotal + v_item.price_minor * v_qty;
  end loop;

  v_service := round(v_subtotal * v_settings.service_charge_percent / 100.0);
  v_tax := case when v_settings.prices_include_tax then 0
                else round((v_subtotal + v_service) * v_settings.tax_percent / 100.0) end;

  update public.orders
     set subtotal_minor = v_subtotal, service_charge_minor = v_service,
         tax_minor = v_tax, total_minor = v_subtotal + v_service + v_tax
   where id = v_order.id
  returning * into v_order;

  return jsonb_build_object(
    'order_id', v_order.id, 'order_number', v_order.order_number, 'status', v_order.status,
    'subtotal_minor', v_order.subtotal_minor, 'service_charge_minor', v_order.service_charge_minor,
    'tax_minor', v_order.tax_minor, 'total_minor', v_order.total_minor,
    'session_token', v_token);
end $$;

-- ---------------------------------------------------------------------
-- Customer: live status of everything ordered in this seating
-- ---------------------------------------------------------------------
create or replace function public.get_session_orders(p_session_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'order_id', o.id, 'order_number', o.order_number, 'status', o.status,
           'total_minor', o.total_minor, 'is_paid', o.is_paid, 'created_at', o.created_at,
           'items', (select jsonb_agg(jsonb_build_object(
                              'name', i.name_snapshot, 'quantity', i.quantity,
                              'unit_price_minor', i.unit_price_minor, 'status', i.status,
                              'special_instructions', i.special_instructions) order by i.created_at)
                       from public.order_items i
                      where i.restaurant_id = o.restaurant_id and i.order_id = o.id))
         order by o.created_at), '[]'::jsonb)
  from public.table_session_secrets s
  join public.orders o on o.restaurant_id = s.restaurant_id and o.session_id = s.session_id
  where s.token_hash = app.sha256(p_session_token)
$$;

-- ---------------------------------------------------------------------
-- Customer: rating once something has been served
-- ---------------------------------------------------------------------
create or replace function public.submit_review(p_session_token text, p_rating int, p_comment text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_s  public.table_session_secrets;
  v_id uuid;
begin
  select * into v_s from public.table_session_secrets where token_hash = app.sha256(p_session_token);
  if not found then
    raise exception 'unknown session' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.orders o
                  where o.restaurant_id = v_s.restaurant_id and o.session_id = v_s.session_id
                    and (o.status = 'served' or o.is_paid)) then
    raise exception 'you can review after your food is served' using errcode = '42501';
  end if;
  insert into public.reviews (restaurant_id, session_id, rating, comment)
  values (v_s.restaurant_id, v_s.session_id, p_rating, nullif(trim(p_comment), ''))
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Platform super-admin metrics (aggregates only; no tenant row access)
-- ---------------------------------------------------------------------
create or replace function public.platform_metrics()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_platform_admin() then
    raise exception 'platform admins only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'restaurants_total', (select count(*) from public.restaurants),
    'restaurants_by_status', (select jsonb_object_agg(subscription_status, n) from
        (select subscription_status, count(*) n from public.restaurants group by 1) x),
    'restaurants_suspended', (select count(*) from public.restaurants where suspended_at is not null),
    'gmv_minor_all_time', (select coalesce(sum(amount_minor), 0) from public.payments where status = 'captured'),
    'gmv_minor_30d', (select coalesce(sum(amount_minor), 0) from public.payments
                       where status = 'captured' and created_at > now() - interval '30 days'),
    'cancelled_30d', (select count(*) from public.audit_log
                       where table_name = 'restaurants' and action = 'UPDATE'
                         and new_data ->> 'subscription_status' = 'cancelled'
                         and old_data ->> 'subscription_status' <> 'cancelled'
                         and created_at > now() - interval '30 days')
  );
end $$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke all on function app.sha256(text) from public, anon, authenticated;
revoke all on function public.create_restaurant(text, text, text, text, text, text, int) from public, anon;
revoke all on function public.get_public_menu(text)                    from public;
revoke all on function public.resolve_table(text, text)                from public;
revoke all on function public.place_order(text, text, jsonb, text, text) from public;
revoke all on function public.get_session_orders(text)                 from public;
revoke all on function public.submit_review(text, int, text)           from public;
revoke all on function public.platform_metrics()                       from public, anon;

grant execute on function public.create_restaurant(text, text, text, text, text, text, int) to authenticated;
grant execute on function public.get_public_menu(text)                       to anon, authenticated;
grant execute on function public.resolve_table(text, text)                   to anon, authenticated;
grant execute on function public.place_order(text, text, jsonb, text, text)  to anon, authenticated;
grant execute on function public.get_session_orders(text)                    to anon, authenticated;
grant execute on function public.submit_review(text, int, text)              to anon, authenticated;
grant execute on function public.platform_metrics()                          to authenticated;
