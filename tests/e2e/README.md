# Customer QR flow, end to end (local)

Drives the real Next.js customer pages in a phone-sized browser against a
freshly seeded database. `mock-rest.mjs` is a tiny local stand-in for
Supabase's `/rest/v1/rpc/*` endpoint: it calls the same SQL functions as the
`anon` role, so RLS and the definer functions are exercised for real.

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres TEST_DB=ros_e2e ./scripts/db-reset-local.sh
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/ros_e2e
node tests/e2e/mock-rest.mjs &
NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=local \
  npx next dev -p 3102 &
node tests/e2e/customer-flow.mjs   # needs Playwright + Chromium installed
```

Note: the seed prefixes dish names with the restaurant name; the flow expects
plain names, so run
`update public.menu_items set name = regexp_replace(name, '^(Spice Route|Bombay Bistro|Green Leaf) ', '');`
first.
