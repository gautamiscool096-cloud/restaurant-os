-- Optional demo data: 30 days of past service for the demo restaurants, so
-- the Analytics screen has something to show. Run AFTER seed.sql, only on a
-- demo or local database (never production):
--   psql "$DATABASE_URL" -f supabase/demo-history.sql
-- Deterministic (fixed random seed). Every row belongs to its own tenant.
select setseed(0.42);

do $history$
declare
  r        record;
  v_day    int;
  v_n      int;
  v_sess   uuid;
  v_order  uuid;
  v_table  uuid;
  v_open   timestamptz;
  v_t      timestamptz;
  v_total  int;
  v_items  uuid[];
  v_item   uuid;
  v_rating int;
  comments text[] := array['Lovely food, will come again', 'Service was a bit slow tonight', 'Best dal in town',
                           'Too spicy for me', 'Friendly staff', 'Great value', 'Food came cold', 'Perfect for a family dinner'];
begin
  for r in select id, slug, timezone from public.restaurants where slug in ('spice-route', 'bombay-bistro', 'green-leaf') loop
    select array_agg(id) into v_items from public.menu_items where restaurant_id = r.id and is_available;
    if v_items is null then continue; end if;

    for v_day in 1..30 loop
      for v_n in 1..(3 + floor(random() * 6))::int loop
        select id into v_table from public.dining_tables where restaurant_id = r.id order by random() limit 1;
        -- lunch (12:00-15:00) or dinner (19:00-22:30), restaurant local time
        v_open := ((current_date - v_day)::timestamp
                   + case when random() < 0.4 then interval '12 hours' + random() * interval '3 hours'
                          else interval '19 hours' + random() * interval '210 minutes' end) at time zone r.timezone;

        insert into public.table_sessions (restaurant_id, table_id, status, opened_at, last_activity_at, closed_at)
        values (r.id, v_table, 'closed', v_open, v_open, v_open + interval '70 minutes') returning id into v_sess;

        v_t := v_open + random() * interval '10 minutes';
        insert into public.orders (restaurant_id, table_id, session_id, status, created_at, updated_at,
                                   approved_at, preparing_at, ready_at, served_at, rejected_reason)
        values (r.id, v_table, v_sess, 'served', v_t, v_t, null, null, null, null, null)
        returning id into v_order;

        for i in 1..(1 + floor(random() * 4))::int loop
          v_item := v_items[1 + floor(random() * array_length(v_items, 1))::int];
          insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, unit_price_minor, quantity, status, created_at)
          select r.id, v_order, m.id, m.name, m.price_minor, 1 + floor(random() * 2)::int, 'served', v_t
            from public.menu_items m where m.id = v_item;
        end loop;

        if random() < 0.05 then
          update public.orders set status = 'rejected', rejected_reason = (array['Item finished', 'Kitchen closing', null])[1 + floor(random() * 3)::int]
           where id = v_order;
        else
          -- mostly on time, with a slow evening now and then
          update public.orders
             set approved_at  = v_t + (1 + random() * 4) * interval '1 minute'
           where id = v_order;
          update public.orders
             set preparing_at = approved_at + (1 + random() * 7) * interval '1 minute'
           where id = v_order;
          update public.orders
             set ready_at = preparing_at + (8 + random() * case when random() < 0.15 then 25 else 10 end) * interval '1 minute'
           where id = v_order;
          update public.orders
             set served_at = ready_at + (1 + random() * 5) * interval '1 minute'
           where id = v_order;

          select total_minor into v_total from public.orders where id = v_order;
          insert into public.payments (restaurant_id, session_id, method, status, amount_minor, gateway, created_at)
          values (r.id, v_sess, case when random() < 0.55 then 'cash' else 'online' end::public.payment_method, 'captured',
                  v_total, null, v_t + interval '50 minutes');

          if random() < 0.4 then
            v_rating := (array[3, 4, 4, 5, 5, 5, 2])[1 + floor(random() * 7)::int];
            insert into public.reviews (restaurant_id, session_id, rating, comment, created_at)
            values (r.id, v_sess, v_rating, case when random() < 0.6 then comments[1 + floor(random() * 8)::int] end,
                    v_t + interval '55 minutes');
          end if;
        end if;

      end loop;
    end loop;
  end loop;
end
$history$;
