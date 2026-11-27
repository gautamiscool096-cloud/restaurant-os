-- =====================================================================
-- Phase 1 / migration 1: multi-tenant schema
--
-- Rules every table in `public` follows (enforced by tests/rls/schema.test.mjs):
--   * it has a NOT NULL `restaurant_id` referencing restaurants(id)
--     (restaurants itself is the tenant root; platform_admins is the only
--     platform-level table and is not tenant data)
--   * RLS is enabled and forced
--   * child rows reference parents through COMPOSITE foreign keys
--     (restaurant_id, parent_id) so a row in tenant A can never point at a
--     row in tenant B, even if application code passes the wrong id
--   * restaurant_id is immutable after insert (trigger in migration 2)
--
-- Money is stored in integer minor units (paise) to match Razorpay.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- Private schema for helpers. Not exposed through the Supabase API.
create schema if not exists app;
revoke all on schema app from public;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'cancelled');
create type public.staff_role          as enum ('owner', 'manager', 'waiter', 'chef', 'cashier');
create type public.order_status        as enum ('pending', 'approved', 'rejected', 'preparing', 'ready', 'served', 'cancelled');
create type public.order_item_status   as enum ('pending', 'preparing', 'ready', 'served', 'cancelled');
create type public.table_session_status as enum ('open', 'closed');
create type public.payment_method      as enum ('online', 'cash');
create type public.payment_status      as enum ('created', 'authorized', 'captured', 'failed', 'refunded');
create type public.settlement_status   as enum ('not_applicable', 'pending', 'settled', 'failed');

-- ---------------------------------------------------------------------
-- Tenant root
-- ---------------------------------------------------------------------
create table public.restaurants (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text not null unique
                          check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
  name                  text not null check (length(trim(name)) between 1 and 120),
  logo_url              text,
  address               text,
  cuisine_type          text,
  brand_primary_color   text not null default '#111827' check (brand_primary_color ~ '^#[0-9a-fA-F]{6}$'),
  brand_accent_color    text not null default '#f59e0b' check (brand_accent_color  ~ '^#[0-9a-fA-F]{6}$'),
  currency              char(3) not null default 'INR',
  timezone              text not null default 'Asia/Kolkata',

  -- SaaS billing (written only by platform admins / billing webhooks)
  plan                  text not null default 'standard',
  subscription_status   public.subscription_status not null default 'trialing',
  trial_ends_at         timestamptz not null default (now() + interval '14 days'),
  current_period_end    timestamptz,
  billing_customer_id   text,          -- Razorpay customer / subscription ref
  billing_subscription_id text,
  suspended_at          timestamptz,   -- platform admin kill switch
  suspended_reason      text,

  -- Payouts: Razorpay Route linked account, so money settles to the restaurant
  payout_account_id     text,
  payout_account_status text not null default 'not_connected',

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Per-tenant configuration (tax, service charge, ordering rules)
create table public.restaurant_settings (
  restaurant_id           uuid primary key references public.restaurants(id) on delete cascade,
  tax_percent             numeric(5,2) not null default 5.00   check (tax_percent between 0 and 100),
  service_charge_percent  numeric(5,2) not null default 0.00   check (service_charge_percent between 0 and 100),
  prices_include_tax      boolean not null default false,
  require_order_approval  boolean not null default true,
  accepts_cash            boolean not null default true,
  accepts_online          boolean not null default true,
  receipt_footer          text,
  order_seq               bigint not null default 0,  -- per-tenant order number counter
  updated_at              timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Platform layer (above tenants)
-- ---------------------------------------------------------------------
create table public.platform_admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Staff: one login belongs to exactly one restaurant (unique user_id)
-- ---------------------------------------------------------------------
create table public.staff (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  user_id        uuid not null unique references auth.users(id) on delete cascade,
  role           public.staff_role not null,
  display_name   text not null,
  phone          text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (restaurant_id, id)
);
create index on public.staff (restaurant_id);

-- ---------------------------------------------------------------------
-- Tables + QR
-- ---------------------------------------------------------------------
create table public.dining_tables (
  id                  uuid primary key default gen_random_uuid(),
  restaurant_id       uuid not null references public.restaurants(id) on delete cascade,
  number              int  not null check (number > 0),
  label               text,
  seats               int  not null default 4 check (seats > 0),
  -- Opaque token printed in the QR code together with the restaurant slug.
  -- Resolution always requires BOTH (slug, qr_token), so table 5 at A can
  -- never resolve to table 5 at B.
  qr_token            text not null unique default encode(extensions.gen_random_bytes(12), 'hex'),
  assigned_waiter_id  uuid,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (restaurant_id, number),
  unique (restaurant_id, id),
  foreign key (restaurant_id, assigned_waiter_id) references public.staff (restaurant_id, id) on delete set null (assigned_waiter_id)
);

-- ---------------------------------------------------------------------
-- Menu
-- ---------------------------------------------------------------------
create table public.menu_categories (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  name           text not null,
  sort_order     int  not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (restaurant_id, id),
  unique (restaurant_id, name)
);

create table public.menu_items (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  category_id    uuid not null,
  name           text not null,
  description    text,
  price_minor    int  not null check (price_minor >= 0),
  photo_url      text,
  is_veg         boolean not null default true,
  spice_level    smallint not null default 0 check (spice_level between 0 and 3),
  is_available   boolean not null default true,
  sort_order     int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, category_id) references public.menu_categories (restaurant_id, id) on delete restrict
);
create index on public.menu_items (restaurant_id, category_id);

-- ---------------------------------------------------------------------
-- Table sessions: one seating at a table; holds all sub-orders
-- ---------------------------------------------------------------------
create table public.table_sessions (
  id                 uuid primary key default gen_random_uuid(),
  restaurant_id      uuid not null references public.restaurants(id) on delete cascade,
  table_id           uuid not null,
  status             public.table_session_status not null default 'open',
  opened_at          timestamptz not null default now(),
  closed_at          timestamptz,
  last_activity_at   timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, table_id) references public.dining_tables (restaurant_id, id) on delete restrict
);
create unique index table_sessions_one_open_per_table
  on public.table_sessions (restaurant_id, table_id) where status = 'open';

-- sha256 of the bearer token handed to the customer's browser for a session.
-- Kept in its own table with RLS on and NO policies or grants, so it is never
-- readable through the API (not even by the restaurant's own staff).
create table public.table_session_secrets (
  session_id     uuid primary key,
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  token_hash     text not null unique,
  created_at     timestamptz not null default now(),
  foreign key (restaurant_id, session_id) references public.table_sessions (restaurant_id, id) on delete cascade
);

-- ---------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------
create table public.orders (
  id                    uuid primary key default gen_random_uuid(),
  restaurant_id         uuid not null references public.restaurants(id) on delete cascade,
  order_number          bigint not null,
  table_id              uuid not null,
  session_id            uuid not null,
  status                public.order_status not null default 'pending',
  customer_note         text,
  subtotal_minor        int not null default 0 check (subtotal_minor >= 0),
  tax_minor             int not null default 0 check (tax_minor >= 0),
  service_charge_minor  int not null default 0 check (service_charge_minor >= 0),
  total_minor           int not null default 0 check (total_minor >= 0),
  is_paid               boolean not null default false,
  approved_by           uuid,
  approved_at           timestamptz,
  rejected_reason       text,
  served_at             timestamptz,
  created_by_staff_id   uuid,            -- null when placed by a customer via QR
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (restaurant_id, id),
  unique (restaurant_id, order_number),
  foreign key (restaurant_id, table_id)   references public.dining_tables (restaurant_id, id) on delete restrict,
  foreign key (restaurant_id, session_id) references public.table_sessions (restaurant_id, id) on delete restrict,
  foreign key (restaurant_id, approved_by) references public.staff (restaurant_id, id) on delete set null (approved_by),
  foreign key (restaurant_id, created_by_staff_id) references public.staff (restaurant_id, id) on delete set null (created_by_staff_id)
);
create index on public.orders (restaurant_id, status, created_at);
create index on public.orders (restaurant_id, session_id);

create table public.order_items (
  id                    uuid primary key default gen_random_uuid(),
  restaurant_id         uuid not null references public.restaurants(id) on delete cascade,
  order_id              uuid not null,
  menu_item_id          uuid not null,
  name_snapshot         text not null,
  unit_price_minor      int  not null check (unit_price_minor >= 0),
  quantity              int  not null check (quantity between 1 and 99),
  special_instructions  text check (length(special_instructions) <= 500),
  status                public.order_item_status not null default 'pending',
  started_at            timestamptz,
  ready_at              timestamptz,
  served_at             timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, order_id)     references public.orders (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, menu_item_id) references public.menu_items (restaurant_id, id) on delete restrict
);
create index on public.order_items (restaurant_id, order_id);

-- ---------------------------------------------------------------------
-- Payments (per table session; covers all its sub-orders)
-- ---------------------------------------------------------------------
create table public.payments (
  id                   uuid primary key default gen_random_uuid(),
  restaurant_id        uuid not null references public.restaurants(id) on delete cascade,
  session_id           uuid not null,
  method               public.payment_method not null,
  status               public.payment_status not null default 'created',
  amount_minor         int not null check (amount_minor > 0),
  platform_fee_minor   int not null default 0 check (platform_fee_minor >= 0),
  gateway              text,             -- 'razorpay' for online
  gateway_order_id     text,
  gateway_payment_id   text unique,
  settlement_status    public.settlement_status not null default 'not_applicable',
  collected_by         uuid,             -- staff who took cash
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, session_id)   references public.table_sessions (restaurant_id, id) on delete restrict,
  foreign key (restaurant_id, collected_by) references public.staff (restaurant_id, id) on delete set null (collected_by)
);
create index on public.payments (restaurant_id, created_at);

-- ---------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------
create table public.reviews (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  session_id     uuid not null,
  rating         smallint not null check (rating between 1 and 5),
  comment        text check (length(comment) <= 2000),
  response       text,
  responded_by   uuid,
  responded_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (restaurant_id, id),
  unique (restaurant_id, session_id),     -- one review per seating
  foreign key (restaurant_id, session_id)   references public.table_sessions (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, responded_by) references public.staff (restaurant_id, id) on delete set null (responded_by)
);

-- ---------------------------------------------------------------------
-- Audit trail (written only by triggers)
-- ---------------------------------------------------------------------
create table public.audit_log (
  id             bigint generated always as identity primary key,
  -- no FK: the audit trail outlives the rows (and tenants) it describes
  restaurant_id  uuid not null,
  actor_user_id  uuid,
  actor_role     text,
  table_name     text not null,
  record_id      uuid,
  action         text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  old_data       jsonb,
  new_data       jsonb,
  created_at     timestamptz not null default now()
);
create index on public.audit_log (restaurant_id, created_at desc);
