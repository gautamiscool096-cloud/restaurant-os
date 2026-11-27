# restaurant-os

A multi-tenant SaaS for restaurant operations. Each restaurant is an isolated tenant with four interfaces that share live order state: a customer QR menu, an owner/manager dashboard, a waiter dashboard and a kitchen display.

Stack: Next.js + Tailwind (frontend), Supabase (Postgres, RLS, Auth, Realtime), Razorpay Route and Subscriptions (payments and billing), Vercel.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Multi-tenant schema, RLS, RBAC, audit trail, seed tenants, leak tests | this PR |
| 2 | Self-serve onboarding UI (signup, restaurant profile, branding) | next |
| 3 | Customer QR menu (browse, cart, order, live status) | |
| 4 | Manager approval flow, floor view | |
| 5 | Waiter and kitchen views (realtime) | |
| 6 | Payments (Razorpay Route), receipts | |
| 7 | Analytics, exports, insights | |
| 8 | Platform super-admin console, subscription billing | |

## How tenant isolation works

The database enforces isolation. Application code does not have to get it right.

1. **Every table carries `restaurant_id`.** It is `NOT NULL`, and it cannot be changed after insert (a trigger blocks it). The only exceptions are `restaurants`, which is the tenant root, and `platform_admins`.
2. **The tenant comes from the login, never from the request.** `staff.user_id` is unique, so each auth user belongs to exactly one restaurant. `app.current_restaurant_id()` looks up the tenant from the JWT `sub`. A URL, header or request body can't pick a tenant, so a waiter at Restaurant A gets nothing from Restaurant B's dashboard even with a guessed URL.
3. **RLS is enabled and forced on every table.** Every policy compares `row.restaurant_id` with `app.current_restaurant_id()`. Role checks (`app.has_role(...)`) sit on top of that.
4. **Composite foreign keys.** Child rows reference parents by `(restaurant_id, id)`, so an order line in A can't point at a menu item, order, table, session or staff member in B. This holds even for service-role code that bypasses RLS.
5. **Customers never touch tables.** The `anon` role has no table privileges at all. The QR flow goes through a few `SECURITY DEFINER` functions (`get_public_menu`, `resolve_table`, `place_order`, `get_session_orders`, `submit_review`). These always resolve a table by the restaurant slug and the table's random QR token together. Table 5 at A and table 5 at B have different tokens, and a token is useless under another restaurant's slug.
6. **Prices are computed on the server.** `place_order` reads prices from the tenant's own menu and ignores any price the client sends. It also applies that tenant's tax and service charge settings.
7. **Billing gate.** If a tenant is suspended or cancelled, its trial has expired, or it is `past_due` beyond a 7-day grace period, `current_restaurant_id()` returns `NULL`. That tenant's dashboard data and QR menu then go dark. Staff can still read their own `restaurants` row to see the billing state. Only the platform (or a billing webhook using the service role) can change billing, suspension, slug and payout fields.
8. **Realtime.** Supabase `postgres_changes` checks every event against the subscriber's RLS. Staff only receive their own tenant's order events, with no per-channel filtering to forget.

### Roles

`platform admin` > `owner` > `manager` > `waiter` / `chef` / `cashier`

| Action | owner | manager | waiter | chef | cashier |
|---|---|---|---|---|---|
| Menu, tables, settings, branding | ✓ | ✓ | | | |
| Manage staff | ✓ (not owners) | ✓ (waiter/chef/cashier only) | | | |
| Approve / reject / edit orders | ✓ | ✓ | | | |
| Approved → preparing → ready | ✓ | ✓ | | ✓ | |
| Mark served | ✓ | ✓ | ✓ | | |
| Record cash payment | ✓ | ✓ | ✓ | | ✓ |
| See payments | ✓ | ✓ | ✓ | | ✓ |
| Audit log | ✓ | ✓ | | | |

Online payments are only ever written by the server from gateway webhooks.

Platform admins can see and suspend all restaurants and call `platform_metrics()` (restaurant counts, GMV, churn). They have no direct read access to tenants' orders, menus or staff.

### Audit trail

Every insert, update and delete on a tenant table writes to `audit_log`: who did it (user and role), when, and the old and new row. Owners and managers can read their own tenant's log. Nobody can write to or edit the log through the API.

## Layout

```
supabase/migrations/   schema (1), RLS + RBAC + triggers (2), public RPCs (3)
supabase/seed.sql      3 demo restaurants (Spice Route, Bombay Bistro, Green Leaf) + platform admin
tests/rls/             schema lint, cross-tenant leak matrix, customer QR flow, roles and billing
tests/support/         test harness and a small Supabase shim for plain Postgres
scripts/               db reset and test runner
```

## Running the tests

The suite runs against any Postgres 15+ server. It needs no Docker and no Supabase CLI:

```bash
npm ci
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

The script recreates a `restaurant_os_test` database, applies `tests/support/supabase-shim.sql` (the `anon`/`authenticated` roles and `auth.uid()`, as Supabase provides them), then all migrations and the seed, and runs every test. Each test runs in its own rolled-back transaction and switches identity per query (`anon`, a specific staff user, or the service role).

CI runs the same suite on every pull request (`.github/workflows/tenant-isolation.yml`).

**Cross-tenant QA rule:** every new feature that adds a table, RPC or role permission adds cases to `tests/rls/`. The schema lint fails automatically if a new table lacks `restaurant_id` or RLS, if a foreign key between tenant tables isn't composite, or if `anon` gains a function.

### With the Supabase CLI

```bash
supabase start
supabase db reset      # applies migrations + seed.sql
```

Every demo login uses the password `demo-password-123`. For example, `owner@spice-route.demo`, `chef@bombay-bistro.demo` and `admin@platform.demo`.
