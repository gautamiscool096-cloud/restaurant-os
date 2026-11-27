-- =====================================================================
-- Phase 8 / migration 9: owners run their own restaurant
--   * menu: categories and dishes (add, edit, price, veg, spice, sold out)
--   * restaurant profile, branding and bill settings
--   * tables: add more, rename, seats, retire
--   * staff: invite by one-time code (no service-role key needed), change
--     role, deactivate; managers may only manage waiter/chef/cashier
-- Writes are SECURITY INVOKER so RLS + the existing guard triggers decide;
-- only invite acceptance (a user with no restaurant yet) is DEFINER.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Menu
-- ---------------------------------------------------------------------
create or replace function public.save_menu_category(p_id uuid, p_name text, p_sort_order int default null)
returns public.menu_categories language plpgsql security invoker set search_path = '' as $$
declare v public.menu_categories;
begin
  if not app.has_role('owner', 'manager') then
    raise exception 'only owners and managers can change this' using errcode = '42501';
  end if;
  if nullif(trim(p_name), '') is null or length(trim(p_name)) > 80 then
    raise exception 'give the category a name (up to 80 characters)' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.menu_categories (restaurant_id, name, sort_order)
    values (app.current_restaurant_id(), trim(p_name),
            coalesce(p_sort_order, (select coalesce(max(sort_order), 0) + 1 from public.menu_categories)))
    returning * into v;
  else
    update public.menu_categories set name = trim(p_name), sort_order = coalesce(p_sort_order, sort_order)
     where id = p_id returning * into v;
  end if;
  if v.id is null then
    raise exception 'category not found' using errcode = 'P0002';
  end if;
  return v;
exception when unique_violation then
  raise exception 'there is already a category with that name' using errcode = '23505';
end $$;

-- p_item: {id?, category_id, name, description, price_minor, is_veg, spice_level, is_available, photo_url}
create or replace function public.save_menu_item(p_item jsonb)
returns public.menu_items language plpgsql security invoker set search_path = '' as $$
declare
  v public.menu_items;
  v_name text := trim(p_item ->> 'name');
  v_price int := (p_item ->> 'price_minor')::int;
begin
  if not app.has_role('owner', 'manager') then
    raise exception 'only owners and managers can change this' using errcode = '42501';
  end if;
  if nullif(v_name, '') is null or length(v_name) > 120 then
    raise exception 'give the dish a name (up to 120 characters)' using errcode = '22023';
  end if;
  if v_price is null or v_price < 0 or v_price > 10000000 then
    raise exception 'enter a price' using errcode = '22023';
  end if;
  if nullif(p_item ->> 'photo_url', '') is not null and (p_item ->> 'photo_url') !~ '^https://' then
    raise exception 'photo must be an https link' using errcode = '22023';
  end if;
  if (p_item ->> 'id') is null then
    insert into public.menu_items (restaurant_id, category_id, name, description, price_minor, is_veg, spice_level,
                                   is_available, photo_url, sort_order)
    values (app.current_restaurant_id(), (p_item ->> 'category_id')::uuid, v_name, nullif(trim(p_item ->> 'description'), ''),
            v_price, coalesce((p_item ->> 'is_veg')::boolean, true), coalesce((p_item ->> 'spice_level')::int, 0),
            coalesce((p_item ->> 'is_available')::boolean, true), nullif(p_item ->> 'photo_url', ''),
            (select coalesce(max(sort_order), 0) + 1 from public.menu_items where category_id = (p_item ->> 'category_id')::uuid))
    returning * into v;
  else
    update public.menu_items
       set category_id = coalesce((p_item ->> 'category_id')::uuid, category_id),
           name = v_name, description = nullif(trim(p_item ->> 'description'), ''), price_minor = v_price,
           is_veg = coalesce((p_item ->> 'is_veg')::boolean, is_veg),
           spice_level = coalesce((p_item ->> 'spice_level')::int, spice_level),
           is_available = coalesce((p_item ->> 'is_available')::boolean, is_available),
           photo_url = nullif(p_item ->> 'photo_url', '')
     where id = (p_item ->> 'id')::uuid
    returning * into v;
  end if;
  if v.id is null then
    raise exception 'dish not found' using errcode = 'P0002';
  end if;
  return v;
exception when foreign_key_violation then
  raise exception 'pick one of your categories' using errcode = '23503';
end $$;

-- Sold out / back on: the kitchen can do this too, not only managers.
create or replace function public.set_menu_item_available(p_id uuid, p_available boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not app.has_role('owner', 'manager', 'chef') then
    raise exception 'your role cannot change the menu' using errcode = '42501';
  end if;
  update public.menu_items set is_available = p_available
   where id = p_id and restaurant_id = app.current_restaurant_id();
  if not found then
    raise exception 'dish not found' using errcode = 'P0002';
  end if;
end $$;

create or replace function public.delete_menu_item(p_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if not app.has_role('owner', 'manager') then
    raise exception 'only owners and managers can change this' using errcode = '42501';
  end if;
  delete from public.menu_items where id = p_id;
  if not found then
    raise exception 'dish not found' using errcode = 'P0002';
  end if;
exception when foreign_key_violation then
  raise exception 'this dish is on past bills, so it cannot be deleted. Mark it sold out instead' using errcode = '23503';
end $$;

-- Full menu for the editor (includes unavailable dishes and empty categories).
create or replace function public.staff_menu_editor()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'name', c.name, 'sort_order', c.sort_order,
           'items', coalesce((select jsonb_agg(to_jsonb(m) - 'restaurant_id' - 'created_at' - 'updated_at'
                                               order by m.sort_order, m.name)
                                from public.menu_items m where m.category_id = c.id), '[]'::jsonb))
         order by c.sort_order, c.name), '[]'::jsonb)
  from public.menu_categories c
  where c.restaurant_id = app.current_restaurant_id()
$$;

-- ---------------------------------------------------------------------
-- Restaurant profile + bill settings
-- ---------------------------------------------------------------------
create or replace function public.restaurant_profile()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'name', r.name, 'slug', r.slug, 'address', r.address, 'cuisine_type', r.cuisine_type, 'logo_url', r.logo_url,
    'brand_primary_color', r.brand_primary_color, 'brand_accent_color', r.brand_accent_color,
    'tax_percent', s.tax_percent, 'service_charge_percent', s.service_charge_percent,
    'prices_include_tax', s.prices_include_tax, 'require_order_approval', s.require_order_approval,
    'accepts_cash', s.accepts_cash, 'accepts_online', s.accepts_online, 'receipt_footer', s.receipt_footer)
  from public.restaurants r join public.restaurant_settings s on s.restaurant_id = r.id
  where r.id = app.current_restaurant_id()
$$;

create or replace function public.update_restaurant_profile(p jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_rid uuid := app.current_restaurant_id();
begin
  if not app.has_role('owner', 'manager') then
    raise exception 'only owners and managers can change settings' using errcode = '42501';
  end if;
  if p ? 'name' and nullif(trim(p ->> 'name'), '') is null then
    raise exception 'the restaurant needs a name' using errcode = '22023';
  end if;
  if (p ->> 'logo_url') is not null and (p ->> 'logo_url') <> '' and (p ->> 'logo_url') !~ '^https://' then
    raise exception 'logo must be an https link' using errcode = '22023';
  end if;
  update public.restaurants
     set name = coalesce(nullif(trim(p ->> 'name'), ''), name),
         address = case when p ? 'address' then nullif(trim(p ->> 'address'), '') else address end,
         cuisine_type = case when p ? 'cuisine_type' then nullif(trim(p ->> 'cuisine_type'), '') else cuisine_type end,
         logo_url = case when p ? 'logo_url' then nullif(p ->> 'logo_url', '') else logo_url end,
         brand_primary_color = coalesce(p ->> 'brand_primary_color', brand_primary_color),
         brand_accent_color = coalesce(p ->> 'brand_accent_color', brand_accent_color)
   where id = v_rid;
  update public.restaurant_settings
     set tax_percent = coalesce((p ->> 'tax_percent')::numeric, tax_percent),
         service_charge_percent = coalesce((p ->> 'service_charge_percent')::numeric, service_charge_percent),
         prices_include_tax = coalesce((p ->> 'prices_include_tax')::boolean, prices_include_tax),
         require_order_approval = coalesce((p ->> 'require_order_approval')::boolean, require_order_approval),
         accepts_cash = coalesce((p ->> 'accepts_cash')::boolean, accepts_cash),
         accepts_online = coalesce((p ->> 'accepts_online')::boolean, accepts_online),
         receipt_footer = case when p ? 'receipt_footer' then nullif(trim(p ->> 'receipt_footer'), '') else receipt_footer end
   where restaurant_id = v_rid;
  if not (select accepts_cash or accepts_online from public.restaurant_settings where restaurant_id = v_rid) then
    raise exception 'guests need at least one way to pay' using errcode = '22023';
  end if;
  return public.restaurant_profile();
exception when check_violation then
  raise exception 'check the colours (like #1a2b3c) and percentages (0 to 100)' using errcode = '23514';
end $$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create or replace function public.add_dining_tables(p_count int)
returns int language plpgsql security invoker set search_path = '' as $$
declare v_from int;
begin
  if not app.has_role('owner', 'manager') then
    raise exception 'only owners and managers can change this' using errcode = '42501';
  end if;
  if p_count not between 1 and 100 then
    raise exception 'add between 1 and 100 tables' using errcode = '22023';
  end if;
  select coalesce(max(number), 0) into v_from from public.dining_tables where restaurant_id = app.current_restaurant_id();
  insert into public.dining_tables (restaurant_id, number)
  select app.current_restaurant_id(), v_from + g from generate_series(1, p_count) g;
  return v_from + p_count;
end $$;

create or replace function public.update_dining_table(p_id uuid, p_label text, p_seats int, p_active boolean)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if not app.has_role('owner', 'manager') then
    raise exception 'only owners and managers can change this' using errcode = '42501';
  end if;
  if p_seats is not null and p_seats not between 1 and 50 then
    raise exception 'seats must be between 1 and 50' using errcode = '22023';
  end if;
  update public.dining_tables
     set label = case when p_label is null then label else nullif(trim(p_label), '') end,
         seats = coalesce(p_seats, seats), is_active = coalesce(p_active, is_active)
   where id = p_id;
  if not found then
    raise exception 'table not found' using errcode = 'P0002';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Staff invites (one-time codes; only the hash is stored)
-- ---------------------------------------------------------------------
create table public.staff_invites (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  role           public.staff_role not null check (role <> 'owner'),
  display_name   text not null check (length(trim(display_name)) between 1 and 80),
  code_hash      text not null unique,
  created_by     uuid,
  expires_at     timestamptz not null default (now() + interval '7 days'),
  used_at        timestamptz,
  used_by        uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, created_by) references public.staff (restaurant_id, id) on delete set null (created_by)
);
create index on public.staff_invites (restaurant_id);
alter table public.staff_invites enable row level security;
alter table public.staff_invites force row level security;
create policy staff_invites_select on public.staff_invites for select to authenticated
  using (restaurant_id = (select app.current_restaurant_id()) and (select app.has_role('owner', 'manager')));
grant select on public.staff_invites to authenticated;
create trigger set_updated_at before update on public.staff_invites
  for each row execute function app.set_updated_at();
create trigger lock_restaurant_id before update on public.staff_invites
  for each row execute function app.lock_restaurant_id();
create trigger audit after insert or update or delete on public.staff_invites
  for each row execute function app.audit();

create or replace function public.create_staff_invite(p_role public.staff_role, p_display_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text := upper(substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 4) || '-' ||
                       substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 4));
  v public.staff_invites;
begin
  if not app.has_role('owner', 'manager') then
    raise exception 'only owners and managers can invite staff' using errcode = '42501';
  end if;
  if p_role = 'owner' then
    raise exception 'a restaurant has one owner' using errcode = '42501';
  end if;
  if app.has_role('manager') and p_role = 'manager' then
    raise exception 'managers can only invite waiters, chefs and cashiers' using errcode = '42501';
  end if;
  if not app.tenant_is_operational(app.current_restaurant_id()) then
    raise exception 'this restaurant is not active' using errcode = '42501';
  end if;
  insert into public.staff_invites (restaurant_id, role, display_name, code_hash, created_by)
  values (app.current_restaurant_id(), p_role, trim(p_display_name), app.sha256(v_code), app.current_staff_id())
  returning * into v;
  return jsonb_build_object('id', v.id, 'code', v_code, 'role', v.role, 'display_name', v.display_name, 'expires_at', v.expires_at);
end $$;

create or replace function public.revoke_staff_invite(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not app.has_role('owner', 'manager') then
    raise exception 'only owners and managers can manage invites' using errcode = '42501';
  end if;
  delete from public.staff_invites
   where id = p_id and restaurant_id = app.current_restaurant_id() and used_at is null;
  if not found then
    raise exception 'invite not found' using errcode = 'P0002';
  end if;
end $$;

-- A signed-in user with no restaurant joins with the code they were given.
create or replace function public.accept_staff_invite(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v public.staff_invites;
begin
  if v_uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  if exists (select 1 from public.staff where user_id = v_uid) then
    raise exception 'this account already belongs to a restaurant' using errcode = '23505';
  end if;
  select * into v from public.staff_invites
   where code_hash = app.sha256(upper(trim(p_code))) and used_at is null and expires_at > now()
   for update;
  if v.id is null then
    raise exception 'that code is not valid or has expired' using errcode = 'P0002';
  end if;
  insert into public.staff (restaurant_id, user_id, role, display_name)
  values (v.restaurant_id, v_uid, v.role, v.display_name);
  update public.staff_invites set used_at = now(), used_by = v_uid where id = v.id;
  return jsonb_build_object('restaurant_id', v.restaurant_id, 'role', v.role);
end $$;

-- Team list for the staff screen.
create or replace function public.staff_team()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if not app.has_role('owner', 'manager') then
    raise exception 'only owners and managers can see the team' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'display_name', s.display_name, 'role', s.role,
                                                         'is_active', s.is_active, 'is_me', s.user_id = auth.uid())
                                        order by s.role, s.display_name), '[]'::jsonb)
                from public.staff s where s.restaurant_id = app.current_restaurant_id()),
    'invites', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'display_name', i.display_name, 'role', i.role,
                                                           'expires_at', i.expires_at) order by i.created_at desc), '[]'::jsonb)
                  from public.staff_invites i
                 where i.restaurant_id = app.current_restaurant_id() and i.used_at is null and i.expires_at > now()));
end $$;

create or replace function public.update_staff_member(p_staff_id uuid, p_role public.staff_role default null, p_active boolean default null)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if not app.has_role('owner', 'manager') then
    raise exception 'only owners and managers can change this' using errcode = '42501';
  end if;
  update public.staff set role = coalesce(p_role, role), is_active = coalesce(p_active, is_active)
   where id = p_staff_id;
  if not found then
    raise exception 'staff member not found' using errcode = 'P0002';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke all on function public.save_menu_category(uuid, text, int), public.save_menu_item(jsonb),
  public.set_menu_item_available(uuid, boolean), public.delete_menu_item(uuid), public.staff_menu_editor(),
  public.restaurant_profile(), public.update_restaurant_profile(jsonb), public.add_dining_tables(int),
  public.update_dining_table(uuid, text, int, boolean), public.create_staff_invite(public.staff_role, text),
  public.revoke_staff_invite(uuid), public.accept_staff_invite(text), public.staff_team(),
  public.update_staff_member(uuid, public.staff_role, boolean)
  from public, anon, authenticated;
grant execute on function public.save_menu_category(uuid, text, int), public.save_menu_item(jsonb),
  public.set_menu_item_available(uuid, boolean), public.delete_menu_item(uuid), public.staff_menu_editor(),
  public.restaurant_profile(), public.update_restaurant_profile(jsonb), public.add_dining_tables(int),
  public.update_dining_table(uuid, text, int, boolean), public.create_staff_invite(public.staff_role, text),
  public.revoke_staff_invite(uuid), public.accept_staff_invite(text), public.staff_team(),
  public.update_staff_member(uuid, public.staff_role, boolean)
  to authenticated;
