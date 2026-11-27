# End-to-end flows (local)

Drives the real Next.js pages in a browser against a freshly seeded database.
`mock-supabase.mjs` is a small local stand-in for the parts of Supabase the
app uses (auth, REST, RPC). Every data request runs as the real `anon` or
`authenticated` role with JWT claims set, so RLS, grants, definer functions
and guard triggers are exercised for real. `customer-flow.mjs` covers the QR
menu; `staff-flow.mjs` covers login, manager approval, floor, isolation and
signup/onboarding; `kitchen-flow.mjs` covers the kitchen display, the waiter
screen, order timers, the offline banner and kitchen isolation;
`payments-flow.mjs` covers bills, cash and online (test mode) payments,
receipts, the webhook signature check and bill isolation;
`manage-flow.mjs` covers the menu editor, sold out from the kitchen,
settings, adding tables, staff invite codes and joining with one, role limits
and isolation;
`admin-flow.mjs` covers the platform admin console and an owner choosing a
plan after the trial ends;
`analytics-flow.mjs` needs `supabase/demo-history.sql` loaded after the seed
(30 days of past service) and covers the Analytics screen, roles and isolation.

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres TEST_DB=ros_e2e ./scripts/db-reset-local.sh
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/ros_e2e
node tests/e2e/mock-supabase.mjs &
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=local \
  npx next dev -p 3102 &
node tests/e2e/customer-flow.mjs   # needs Playwright + Chromium installed
node tests/e2e/staff-flow.mjs      # reset the database before each flow
node tests/e2e/kitchen-flow.mjs
node tests/e2e/payments-flow.mjs
node tests/e2e/manage-flow.mjs
node tests/e2e/admin-flow.mjs
psql "$TEST_DATABASE_URL" -f supabase/demo-history.sql && node tests/e2e/analytics-flow.mjs
```

Note: the seed prefixes dish names with the restaurant name; the flow expects
plain names, so run
`update public.menu_items set name = regexp_replace(name, '^(Spice Route|Bombay Bistro|Green Leaf) ', '');`
first.
