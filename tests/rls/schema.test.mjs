// Structural guards. These fail the build the moment someone adds a table,
// foreign key or function that does not follow the tenancy rules, before any
// data-level test even has a chance to miss it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, tx } from '../support/db.mjs';

after(() => pool.end());

// Tables that are allowed to have no restaurant_id column.
const NOT_TENANT_SCOPED = new Set(['restaurants', 'platform_admins']);

const publicTables = (t) => t.q(`
  select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
   order by 1`);

test('every public table carries a NOT NULL restaurant_id uuid', () => tx('service', async (t) => {
  const tables = await publicTables(t);
  assert.ok(tables.length >= 13, 'expected the full schema');
  for (const { name } of tables) {
    if (NOT_TENANT_SCOPED.has(name)) continue;
    const [col] = await t.q(`
      select data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = $1 and column_name = 'restaurant_id'`, [name]);
    assert.ok(col, `${name} has no restaurant_id`);
    assert.equal(col.data_type, 'uuid', `${name}.restaurant_id must be uuid`);
    assert.equal(col.is_nullable, 'NO', `${name}.restaurant_id must be NOT NULL`);
  }
}));

test('RLS is enabled and forced on every public table', () => tx('service', async (t) => {
  for (const { name, rls, forced } of await publicTables(t)) {
    assert.ok(rls, `RLS not enabled on ${name}`);
    assert.ok(forced, `RLS not forced on ${name}`);
  }
}));

test('anon has no privileges on any public table', () => tx('service', async (t) => {
  const rows = await t.q(`
    select table_name, privilege_type from information_schema.role_table_grants
     where table_schema = 'public' and grantee = 'anon'`);
  assert.deepEqual(rows, []);
}));

test('no API role can touch table_session_secrets', () => tx('service', async (t) => {
  const rows = await t.q(`
    select grantee, privilege_type from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'table_session_secrets'
       and grantee in ('anon', 'authenticated')`);
  assert.deepEqual(rows, []);
}));

test('foreign keys between tenant tables always include restaurant_id', () => tx('service', async (t) => {
  const fks = await t.q(`
    select con.conname, src.relname as src, dst.relname as dst,
           array(select a.attname from unnest(con.conkey) k join pg_attribute a
                   on a.attrelid = con.conrelid and a.attnum = k) as cols
      from pg_constraint con
      join pg_class src on src.oid = con.conrelid
      join pg_class dst on dst.oid = con.confrelid
      join pg_namespace n on n.oid = src.relnamespace
     where con.contype = 'f' and n.nspname = 'public'`);
  for (const fk of fks) {
    if (fk.dst === 'restaurants' || NOT_TENANT_SCOPED.has(fk.src)) continue;
    if (fk.dst === 'users') continue; // auth.users
    assert.ok(fk.cols.includes('restaurant_id'),
      `${fk.src} -> ${fk.dst} (${fk.conname}) must be a composite FK on (restaurant_id, ...)`);
  }
}));

test('every SECURITY DEFINER function pins search_path', () => tx('service', async (t) => {
  const rows = await t.q(`
    select n.nspname || '.' || p.proname as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'app') and p.prosecdef
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
  assert.deepEqual(rows, []);
}));

test('anon can execute only the customer-facing functions', () => tx('service', async (t) => {
  const rows = await t.q(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'app') and has_function_privilege('anon', p.oid, 'execute')
     order by 1`);
  assert.deepEqual(rows.map((r) => r.proname),
    ['get_public_menu', 'get_session_orders', 'guest_attach_gateway_order', 'guest_bill',
     'guest_complete_test_payment', 'guest_start_online_payment', 'place_order', 'razorpay_webhook',
     'resolve_table', 'submit_review']);
}));
