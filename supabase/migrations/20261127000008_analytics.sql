-- =====================================================================
-- Phase 7 / migration 8: analytics for owners and managers
--   * sales, orders, busy hours, best and worst sellers, payment split,
--     speed of service per stage, late orders, rejections and reviews
--   * SECURITY INVOKER + explicit restaurant filter: RLS still applies, so
--     a restaurant only ever sees its own numbers
--   * days are counted in the restaurant's own time zone
-- =====================================================================

create or replace function public.restaurant_analytics(p_from date, p_to date)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_rid uuid := app.current_restaurant_id();
  v_tz  text;
  v_start timestamptz;
  v_end   timestamptz;
begin
  if not app.has_role('owner', 'manager') then
    raise exception 'only owners and managers can see analytics' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'pick a date range of up to a year' using errcode = '22023';
  end if;
  select timezone into v_tz from public.restaurants where id = v_rid;
  v_start := p_from::timestamp at time zone v_tz;
  v_end   := (p_to + 1)::timestamp at time zone v_tz;

  return (
    with o as (            -- accepted orders in range
      select * from public.orders
       where restaurant_id = v_rid and created_at >= v_start and created_at < v_end
         and status in ('approved', 'preparing', 'ready', 'served')
    ), allo as (           -- every order in range, incl. rejected / pending
      select * from public.orders
       where restaurant_id = v_rid and created_at >= v_start and created_at < v_end
    ), items as (
      select i.* from public.order_items i join o on o.id = i.order_id
       where i.restaurant_id = v_rid and i.status <> 'cancelled'
    ), pay as (
      select * from public.payments
       where restaurant_id = v_rid and status = 'captured' and created_at >= v_start and created_at < v_end
    ), rev as (
      select * from public.reviews where restaurant_id = v_rid and created_at >= v_start and created_at < v_end
    ), mins as (
      select extract(epoch from approved_at - created_at) / 60 to_approve,
             extract(epoch from preparing_at - approved_at) / 60 to_start,
             extract(epoch from ready_at - preparing_at) / 60 cooking,
             extract(epoch from served_at - ready_at) / 60 to_serve,
             extract(epoch from served_at - approved_at) / 60 total
        from o
    )
    select jsonb_build_object(
      'range', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', v_tz),
      'totals', (select jsonb_build_object(
          'sales_minor', coalesce(sum(total_minor), 0),
          'orders', count(*),
          'avg_order_minor', coalesce(round(avg(total_minor)), 0),
          'tables_served', count(distinct session_id),
          'collected_minor', (select coalesce(sum(amount_minor), 0) from pay),
          'rejected', (select count(*) from allo where status = 'rejected'),
          'items_sold', (select coalesce(sum(quantity), 0) from items))
        from o),
      'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'orders', coalesce(x.n, 0), 'sales_minor', coalesce(x.s, 0))
                                           order by d), '[]'::jsonb)
                   from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
                   left join (select (created_at at time zone v_tz)::date as d_day, count(*) n, sum(total_minor) s from o group by 1) x
                     on x.d_day = d::date),
      'by_hour', (select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'orders', coalesce(x.n, 0)) order by h), '[]'::jsonb)
                    from generate_series(0, 23) h
                    left join (select extract(hour from created_at at time zone v_tz)::int hr, count(*) n from o group by 1) x
                      on x.hr = h),
      'top_items', (select coalesce(jsonb_agg(t order by (t ->> 'quantity')::int desc, t ->> 'name'), '[]'::jsonb) from (
                      select jsonb_build_object('name', name_snapshot, 'quantity', sum(quantity), 'sales_minor', sum(quantity * unit_price_minor)) t
                        from items group by name_snapshot order by sum(quantity) desc, name_snapshot limit 10) x),
      'slow_items', (select coalesce(jsonb_agg(jsonb_build_object('name', m.name, 'quantity', coalesce(x.q, 0))
                                               order by coalesce(x.q, 0), m.name), '[]'::jsonb)
                       from (select m.name from public.menu_items m where m.restaurant_id = v_rid and m.is_available) m
                       left join (select name_snapshot, sum(quantity) q from items group by 1) x on x.name_snapshot = m.name
                      where coalesce(x.q, 0) <= 1),
      'payments', (select jsonb_build_object(
          'cash_minor', coalesce(sum(amount_minor) filter (where method = 'cash'), 0),
          'online_minor', coalesce(sum(amount_minor) filter (where method = 'online'), 0),
          'platform_fee_minor', coalesce(sum(platform_fee_minor) filter (where method = 'online'), 0))
        from pay),
      'speed', (select jsonb_build_object(
          'to_approve', jsonb_build_object('avg', round(avg(to_approve)::numeric, 1), 'median', round((percentile_cont(0.5) within group (order by to_approve))::numeric, 1), 'n', count(to_approve)),
          'to_start',   jsonb_build_object('avg', round(avg(to_start)::numeric, 1),   'median', round((percentile_cont(0.5) within group (order by to_start))::numeric, 1),   'n', count(to_start)),
          'cooking',    jsonb_build_object('avg', round(avg(cooking)::numeric, 1),    'median', round((percentile_cont(0.5) within group (order by cooking))::numeric, 1),    'n', count(cooking)),
          'to_serve',   jsonb_build_object('avg', round(avg(to_serve)::numeric, 1),   'median', round((percentile_cont(0.5) within group (order by to_serve))::numeric, 1),   'n', count(to_serve)),
          'total',      jsonb_build_object('avg', round(avg(total)::numeric, 1),      'median', round((percentile_cont(0.5) within group (order by total))::numeric, 1),      'n', count(total)),
          'late_orders', count(*) filter (where total >= 30),
          'slow_orders', count(*) filter (where total >= 20 and total < 30))
        from mins),
      'rejections', (select coalesce(jsonb_agg(jsonb_build_object('reason', reason, 'count', n) order by n desc), '[]'::jsonb) from (
                       select coalesce(nullif(trim(rejected_reason), ''), 'No reason given') reason, count(*) n
                         from allo where status = 'rejected' group by 1 order by 2 desc limit 5) x),
      'reviews', (select jsonb_build_object(
          'count', count(*), 'average', round(avg(rating)::numeric, 2),
          'by_rating', (select jsonb_object_agg(r, (select count(*) from rev where rating = r)) from generate_series(1, 5) r),
          'latest', (select coalesce(jsonb_agg(jsonb_build_object('rating', rating, 'comment', comment, 'created_at', created_at)
                                               order by created_at desc), '[]'::jsonb)
                       from (select * from rev where comment is not null order by created_at desc limit 5) l))
        from rev)
    )
  );
end $$;

-- "Last N days, including today", where today is the restaurant's today.
create or replace function public.restaurant_analytics_recent(p_days int)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select public.restaurant_analytics(d - (greatest(least(p_days, 366), 1) - 1), d)
    from (select (now() at time zone r.timezone)::date d
            from public.restaurants r where r.id = app.current_restaurant_id()) x
$$;

revoke all on function public.restaurant_analytics(date, date), public.restaurant_analytics_recent(int)
  from public, anon, authenticated;
grant execute on function public.restaurant_analytics(date, date), public.restaurant_analytics_recent(int) to authenticated;
