# End-to-end flows (local)

Drives the real Next.js pages in a browser against a freshly seeded database.
`mock-supabase.mjs` is a small local stand-in for the parts of Supabase the
app uses (auth, REST, RPC). Every data request runs as the real `anon` or
`authenticated` role with JWT claims set, so RLS, grants, definer functions
and guard triggers are exercised for real. `customer-flow.mjs` covers the QR
menu; `staff-flow.mjs` covers login, manager approval, floor, isolation and
signup/onboarding.

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres TEST_DB=ros_e2e ./scripts/db-reset-local.sh
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/ros_e2e
node tests/e2e/mock-supabase.mjs &
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=local \
  npx next dev -p 3102 &
node tests/e2e/customer-flow.mjs   # needs Playwright + Chromium installed
node tests/e2e/staff-flow.mjs      # reset the database first if you ran the other flow
```

Note: the seed prefixes dish names with the restaurant name; the flow expects
plain names, so run
`update public.menu_items set name = regexp_replace(name, '^(Spice Route|Bombay Bistro|Green Leaf) ', '');`
first.
