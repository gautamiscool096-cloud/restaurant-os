-- =====================================================================
-- Phase 2 / migration 4: self-serve onboarding support
--   * reserved slugs + slug availability check
--   * create_restaurant gains brand colours and reserved-slug protection
--   * my_context(): who am I, which restaurant, may it operate
--   * restaurant-assets storage bucket, writable only inside your own
--     restaurant's folder (<restaurant_id>/...)
-- =====================================================================

create or replace function app.is_reserved_slug(p_slug text)
returns boolean language sql immutable set search_path = '' as $$
  select lower(p_slug) = any (array[
    'admin','api','app','auth','billing','dashboard','docs','help','kitchen','login','logout',
    'menu','onboarding','platform','pricing','r','signup','static','status','support','waiter','www'
  ])
$$;

create or replace function app.slug_is_valid(p_slug text)
returns boolean language sql immutable set search_path = '' as $$
  select p_slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$' and not app.is_reserved_slug(p_slug)
$$;

-- Slugs are public anyway (they are the menu URL), so revealing whether
-- one is taken leaks nothing tenant-private.
create or replace function public.is_slug_available(p_slug text)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.slug_is_valid(lower(p_slug))
     and not exists (select 1 from public.restaurants r where r.slug = lower(p_slug))
$$;

drop function public.create_restaurant(text, text, text, text, text, text, int);

create function public.create_restaurant(
  p_name           text,
  p_slug           text,
  p_owner_name     text,
  p_address        text default null,
  p_cuisine_type   text default null,
  p_logo_url       text default null,
  p_table_count    int  default 10,
  p_primary_color  text default '#111827',
  p_accent_color   text default '#f59e0b'
) returns public.restaurants
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_slug text := lower(trim(p_slug));
  v_r    public.restaurants;
begin
  if v_uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  if exists (select 1 from public.staff where user_id = v_uid) then
    raise exception 'this account already belongs to a restaurant' using errcode = '23505';
  end if;
  if not app.slug_is_valid(v_slug) then
    raise exception 'that web address is not allowed' using errcode = '22023';
  end if;
  if exists (select 1 from public.restaurants where slug = v_slug) then
    raise exception 'that web address is already taken' using errcode = '23505';
  end if;
  if p_table_count not between 1 and 200 then
    raise exception 'table count must be between 1 and 200' using errcode = '22023';
  end if;

  insert into public.restaurants (name, slug, address, cuisine_type, logo_url,
                                  brand_primary_color, brand_accent_color)
  values (trim(p_name), v_slug, nullif(trim(p_address), ''), nullif(trim(p_cuisine_type), ''),
          p_logo_url, coalesce(p_primary_color, '#111827'), coalesce(p_accent_color, '#f59e0b'))
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

-- Session context for the app shell. Returns null when the user has no
-- restaurant yet (-> onboarding).
create or replace function public.my_context()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'staff_id', s.id,
    'role', s.role,
    'display_name', s.display_name,
    'is_platform_admin', app.is_platform_admin(),
    'operational', app.tenant_is_operational(r.id),
    'restaurant', jsonb_build_object(
      'id', r.id, 'slug', r.slug, 'name', r.name, 'logo_url', r.logo_url,
      'brand_primary_color', r.brand_primary_color, 'brand_accent_color', r.brand_accent_color,
      'subscription_status', r.subscription_status, 'trial_ends_at', r.trial_ends_at,
      'current_period_end', r.current_period_end, 'suspended', r.suspended_at is not null))
  from public.staff s
  join public.restaurants r on r.id = s.restaurant_id
  where s.user_id = auth.uid() and s.is_active
$$;

revoke all on function app.is_reserved_slug(text), app.slug_is_valid(text) from public, anon, authenticated;
revoke all on function public.is_slug_available(text) from public, anon;
revoke all on function public.create_restaurant(text, text, text, text, text, text, int, text, text) from public, anon;
revoke all on function public.my_context() from public, anon;
grant execute on function public.is_slug_available(text) to authenticated;
grant execute on function public.create_restaurant(text, text, text, text, text, text, int, text, text) to authenticated;
grant execute on function public.my_context() to authenticated;

-- ---------------------------------------------------------------------
-- Storage: logos and (later) menu photos. Public read, because they are
-- shown on the public QR menu. Writes only into "<your restaurant id>/...".
-- ---------------------------------------------------------------------
do $storage$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'storage schema not present; skipping bucket setup';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values ('restaurant-assets', 'restaurant-assets', true)
  on conflict (id) do nothing;

  execute $p$
    create policy "restaurant assets: managers write own folder"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'restaurant-assets'
        and (storage.foldername(name))[1] = (select app.current_restaurant_id())::text
        and (select app.has_role('owner', 'manager'))
      )$p$;
  execute $p$
    create policy "restaurant assets: managers update own folder"
      on storage.objects for update to authenticated
      using (
        bucket_id = 'restaurant-assets'
        and (storage.foldername(name))[1] = (select app.current_restaurant_id())::text
        and (select app.has_role('owner', 'manager'))
      )
      with check (
        bucket_id = 'restaurant-assets'
        and (storage.foldername(name))[1] = (select app.current_restaurant_id())::text
        and (select app.has_role('owner', 'manager'))
      )$p$;
  execute $p$
    create policy "restaurant assets: managers delete own folder"
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'restaurant-assets'
        and (storage.foldername(name))[1] = (select app.current_restaurant_id())::text
        and (select app.has_role('owner', 'manager'))
      )$p$;
  -- Staff can list their own folder (public URLs work for everyone anyway).
  execute $p$
    create policy "restaurant assets: staff read own folder"
      on storage.objects for select to authenticated
      using (
        bucket_id = 'restaurant-assets'
        and (storage.foldername(name))[1] = (select app.current_restaurant_id())::text
      )$p$;
end
$storage$;
