-- =====================================================================
-- Demo data: three independent restaurants + a platform admin.
-- Used by `supabase db reset` locally and by the cross-tenant leak tests.
--
-- All demo logins use the password: demo-password-123
--
--   tenant          slug             users (role@slug.demo)
--   A Spice Route   spice-route      owner/manager/waiter/chef/cashier@spice-route.demo
--   B Bombay Bistro bombay-bistro    owner/manager/waiter/chef/cashier@bombay-bistro.demo
--   C Green Leaf    green-leaf       owner/manager/waiter/chef/cashier@green-leaf.demo
--   platform admin                   admin@platform.demo
--   no tenant                        drifter@nowhere.demo
--
-- IDs are deterministic so tests can aim at another tenant's exact rows.
--   0000000{a|b|c}-0000-4000-{kind}-0000000000{nn}
--   kind 8000: restaurant (nn=00) and auth users (01 owner, 02 manager,
--              03 waiter, 04 chef, 05 cashier)
--   kind 8001 staff, 8002 tables (nn = table no.), 8003 categories,
--        8004 menu items, 8005 sessions, 8006 orders, 8007 payments,
--        8008 reviews, 8009 order items
-- Every restaurant has a table number 5, on purpose (QR collision test).
-- =====================================================================

do $seed$
declare
  t        record;
  r_id     uuid;
  roles    text[] := array['owner','manager','waiter','chef','cashier'];
  i        int;
  u_id     uuid;
  pw       text := extensions.crypt('demo-password-123', extensions.gen_salt('bf'));
  has_identities boolean := to_regclass('auth.identities') is not null;
  cat      record;
  sess     uuid;
  ord      uuid;
  item     record;
begin
  for t in
    select * from (values
      ('a', 'Spice Route',   'spice-route',   'North Indian', '#7c2d12', '#f59e0b', 5.00, 10.00, '12 MG Road, Bengaluru'),
      ('b', 'Bombay Bistro', 'bombay-bistro', 'Street food',  '#1e3a8a', '#fbbf24', 5.00,  0.00, '4 Linking Rd, Mumbai'),
      ('c', 'Green Leaf',    'green-leaf',    'Vegan',        '#14532d', '#a3e635', 18.00, 5.00, '88 Park St, Kolkata')
    ) v(k, name, slug, cuisine, c1, c2, tax, svc, addr)
  loop
    r_id := ('0000000' || t.k || '-0000-4000-8000-000000000000')::uuid;

    insert into public.restaurants (id, slug, name, cuisine_type, address,
                                    brand_primary_color, brand_accent_color,
                                    subscription_status, current_period_end)
    values (r_id, t.slug, t.name, t.cuisine, t.addr, t.c1, t.c2,
            case when t.k = 'c' then 'trialing' else 'active' end::public.subscription_status,
            now() + interval '30 days');

    insert into public.restaurant_settings (restaurant_id, tax_percent, service_charge_percent)
    values (r_id, t.tax, t.svc);

    -- staff logins
    for i in 1 .. array_length(roles, 1) loop
      u_id := ('0000000' || t.k || '-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid;
      insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                              email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
      values (u_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              roles[i] || '@' || t.slug || '.demo', pw, now(),
              '{"provider":"email","providers":["email"]}', '{}');
      if has_identities then
        execute 'insert into auth.identities (id, user_id, provider_id, provider, identity_data, created_at, updated_at)
                 values (gen_random_uuid(), $1, $1::text, ''email'', jsonb_build_object(''sub'', $1::text, ''email'', $2), now(), now())'
          using u_id, roles[i] || '@' || t.slug || '.demo';
      end if;
      insert into public.staff (id, restaurant_id, user_id, role, display_name)
      values (('0000000' || t.k || '-0000-4000-8001-0000000000' || lpad(i::text, 2, '0'))::uuid,
              r_id, u_id, roles[i]::public.staff_role, initcap(roles[i]) || ' @ ' || t.name);
    end loop;

    -- 8 tables; waiter gets tables 1-4
    insert into public.dining_tables (id, restaurant_id, number, label, qr_token, assigned_waiter_id)
    select ('0000000' || t.k || '-0000-4000-8002-0000000000' || lpad(n::text, 2, '0'))::uuid,
           r_id, n, 'Table ' || n, t.slug || '-table-' || n || '-qr',
           case when n <= 4 then ('0000000' || t.k || '-0000-4000-8001-000000000003')::uuid end
      from generate_series(1, 8) n;

    -- menu
    insert into public.menu_categories (id, restaurant_id, name, sort_order) values
      (('0000000' || t.k || '-0000-4000-8003-000000000001')::uuid, r_id, 'Starters', 1),
      (('0000000' || t.k || '-0000-4000-8003-000000000002')::uuid, r_id, 'Mains', 2),
      (('0000000' || t.k || '-0000-4000-8003-000000000003')::uuid, r_id, 'Drinks', 3);

    insert into public.menu_items (id, restaurant_id, category_id, name, description, price_minor, is_veg, spice_level, is_available, sort_order)
    select ('0000000' || t.k || '-0000-4000-8004-0000000000' || lpad(x.n::text, 2, '0'))::uuid, r_id,
           ('0000000' || t.k || '-0000-4000-8003-00000000000' || x.cat)::uuid,
           t.name || ' ' || x.name, x.descr, x.price, x.veg, x.spice, x.avail, x.n
      from (values
        (1, 1, 'Paneer Tikka',   'Char-grilled cottage cheese',   24000, true,  2, true),
        (2, 1, 'Chicken 65',     'Crispy fried chicken bites',     28000, false, 3, true),
        (3, 2, 'Dal Makhani',    'Slow-cooked black lentils',      26000, true,  1, true),
        (4, 2, 'Butter Chicken', 'Tomato-butter gravy',            34000, false, 1, true),
        (5, 2, 'Seasonal Thali', 'Chef''s daily selection',        42000, true,  2, false),
        (6, 3, 'Masala Chaas',   'Spiced buttermilk',               9000, true,  0, true)
      ) x(n, cat, name, descr, price, veg, spice, avail);

    -- one finished, paid & reviewed seating at table 1 ...
    sess := ('0000000' || t.k || '-0000-4000-8005-000000000001')::uuid;
    insert into public.table_sessions (id, restaurant_id, table_id, status, closed_at)
    values (sess, r_id, ('0000000' || t.k || '-0000-4000-8002-000000000001')::uuid, 'closed', now());
    insert into public.table_session_secrets (session_id, restaurant_id, token_hash)
    values (sess, r_id, app.sha256('demo-session-' || t.slug || '-1'));
    ord := ('0000000' || t.k || '-0000-4000-8006-000000000001')::uuid;
    insert into public.orders (id, restaurant_id, table_id, session_id, status, subtotal_minor, total_minor,
                               is_paid, approved_by, approved_at, served_at)
    values (ord, r_id, ('0000000' || t.k || '-0000-4000-8002-000000000001')::uuid, sess, 'served',
            52000, 52000, true, ('0000000' || t.k || '-0000-4000-8001-000000000002')::uuid, now(), now());
    insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, unit_price_minor, quantity, status)
    values (r_id, ord, ('0000000' || t.k || '-0000-4000-8004-000000000001')::uuid, t.name || ' Paneer Tikka', 24000, 1, 'served'),
           (r_id, ord, ('0000000' || t.k || '-0000-4000-8004-000000000002')::uuid, t.name || ' Chicken 65',   28000, 1, 'served');
    insert into public.payments (id, restaurant_id, session_id, method, status, amount_minor, collected_by)
    values (('0000000' || t.k || '-0000-4000-8007-000000000001')::uuid, r_id, sess, 'cash', 'captured', 52000,
            ('0000000' || t.k || '-0000-4000-8001-000000000005')::uuid);
    insert into public.reviews (id, restaurant_id, session_id, rating, comment)
    values (('0000000' || t.k || '-0000-4000-8008-000000000001')::uuid, r_id, sess, 5, 'Lovely food at ' || t.name);

    -- ... and a live seating at table 5 with one pending and one approved order
    sess := ('0000000' || t.k || '-0000-4000-8005-000000000005')::uuid;
    insert into public.table_sessions (id, restaurant_id, table_id)
    values (sess, r_id, ('0000000' || t.k || '-0000-4000-8002-000000000005')::uuid);
    insert into public.table_session_secrets (session_id, restaurant_id, token_hash)
    values (sess, r_id, app.sha256('demo-session-' || t.slug || '-5'));

    insert into public.orders (id, restaurant_id, table_id, session_id, status, subtotal_minor, total_minor,
                               approved_by, approved_at, customer_note)
    values (('0000000' || t.k || '-0000-4000-8006-000000000002')::uuid, r_id,
            ('0000000' || t.k || '-0000-4000-8002-000000000005')::uuid, sess, 'approved', 34000, 34000,
            ('0000000' || t.k || '-0000-4000-8001-000000000002')::uuid, now(), 'Birthday table'),
           (('0000000' || t.k || '-0000-4000-8006-000000000003')::uuid, r_id,
            ('0000000' || t.k || '-0000-4000-8002-000000000005')::uuid, sess, 'pending', 9000, 9000,
            null, null, null);
    insert into public.order_items (id, restaurant_id, order_id, menu_item_id, name_snapshot, unit_price_minor, quantity, special_instructions)
    values (('0000000' || t.k || '-0000-4000-8009-000000000001')::uuid, r_id,
            ('0000000' || t.k || '-0000-4000-8006-000000000002')::uuid,
            ('0000000' || t.k || '-0000-4000-8004-000000000004')::uuid, t.name || ' Butter Chicken', 34000, 1, 'Less spicy please'),
           (('0000000' || t.k || '-0000-4000-8009-000000000002')::uuid, r_id,
            ('0000000' || t.k || '-0000-4000-8006-000000000003')::uuid,
            ('0000000' || t.k || '-0000-4000-8004-000000000006')::uuid, t.name || ' Masala Chaas', 9000, 1, null);
  end loop;

  -- platform super-admin and a user with no restaurant
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
  values ('0000000f-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'admin@platform.demo', pw, now(), '{"provider":"email","providers":["email"]}', '{}'),
         ('0000000e-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'drifter@nowhere.demo', pw, now(), '{"provider":"email","providers":["email"]}', '{}');
  if has_identities then
    execute 'insert into auth.identities (id, user_id, provider_id, provider, identity_data, created_at, updated_at)
             select gen_random_uuid(), u.id, u.id::text, ''email'', jsonb_build_object(''sub'', u.id::text, ''email'', u.email), now(), now()
               from auth.users u where u.id in (''0000000f-0000-4000-8000-000000000001'', ''0000000e-0000-4000-8000-000000000001'')';
  end if;
  insert into public.platform_admins (user_id) values ('0000000f-0000-4000-8000-000000000001');
end
$seed$;
