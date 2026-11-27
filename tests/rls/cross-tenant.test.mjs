// Cross-tenant leak tests: for every restaurant x every staff role x every
// tenant table, prove that nothing belonging to another restaurant can be
// read, changed, deleted, created or pointed at.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  pool, tx, id, userId, staffId, TENANTS, ROLES, PLATFORM_ADMIN, NO_TENANT_USER,
} from '../support/db.mjs';

after(() => pool.end());

const TENANT_TABLES = [
  'restaurant_settings', 'staff', 'dining_tables', 'menu_categories', 'menu_items',
  'table_sessions', 'orders', 'order_items', 'payments', 'reviews', 'audit_log',
];
// Tables each role is expected to be able to read in its own tenant.
const READABLE = {
  owner:   new Set(TENANT_TABLES),
  manager: new Set(TENANT_TABLES),
  waiter:  new Set(TENANT_TABLES.filter((t) => t !== 'audit_log')),
  chef:    new Set(TENANT_TABLES.filter((t) => !['audit_log', 'payments'].includes(t))),
  cashier: new Set(TENANT_TABLES.filter((t) => t !== 'audit_log')),
};
const rid = (tenant) => id(tenant, 'restaurant');
const others = (tenant) => TENANTS.filter((x) => x !== tenant);

describe('reads never cross tenants', () => {
  for (const tenant of TENANTS) {
    for (const role of ROLES) {
      test(`${role}@${tenant} sees only restaurant ${tenant}`, () => tx(userId(tenant, role), async (t) => {
        const [r] = await t.q(`select array_agg(id) ids from public.restaurants`);
        assert.deepEqual(r.ids, [rid(tenant)]);

        for (const table of TENANT_TABLES) {
          const rows = await t.q(
            `select restaurant_id, count(*)::int n from public.${table} group by 1`);
          const foreign = rows.filter((x) => x.restaurant_id !== rid(tenant));
          assert.deepEqual(foreign, [], `${role}@${tenant} read ${table} rows of another tenant`);
          if (READABLE[role].has(table)) {
            assert.ok(rows.length === 1 && rows[0].n > 0, `${role}@${tenant} should see own ${table}`);
          } else {
            assert.equal(rows.length, 0, `${role}@${tenant} should not see ${table}`);
          }
        }
      }));
    }
  }

  test('guessing another tenant\'s exact ids returns nothing', () => tx(userId('a', 'owner'), async (t) => {
    for (const other of others('a')) {
      const probes = [
        ['restaurants', rid(other)],
        ['staff', staffId(other, 'owner')],
        ['dining_tables', id(other, 'table', 5)],
        ['menu_items', id(other, 'item', 1)],
        ['table_sessions', id(other, 'session', 5)],
        ['orders', id(other, 'order', 2)],
        ['order_items', id(other, 'orderItem', 1)],
        ['payments', id(other, 'payment', 1)],
        ['reviews', id(other, 'review', 1)],
      ];
      for (const [table, rowId] of probes) {
        const rows = await t.q(`select 1 from public.${table} where id = $1`, [rowId]);
        assert.equal(rows.length, 0, `owner@a fetched ${table} ${rowId}`);
      }
    }
  }));

  test('a user with no restaurant sees nothing anywhere', () => tx(NO_TENANT_USER, async (t) => {
    for (const table of ['restaurants', ...TENANT_TABLES]) {
      const [{ n }] = await t.q(`select count(*)::int n from public.${table}`);
      assert.equal(n, 0, `unaffiliated user read ${table}`);
    }
  }));

  test('anon cannot read any table directly', () => tx('anon', async (t) => {
    for (const table of ['restaurants', 'platform_admins', 'table_session_secrets', ...TENANT_TABLES]) {
      const { error } = await t.try(`select * from public.${table} limit 1`);
      assert.match(String(error?.message), /permission denied/, `anon read ${table}`);
    }
  }));

  test('platform admin sees all restaurants but no tenant operational data', () => tx(PLATFORM_ADMIN, async (t) => {
    const [{ n }] = await t.q(`select count(*)::int n from public.restaurants`);
    assert.equal(n, 3);
    for (const table of TENANT_TABLES) {
      const [{ c }] = await t.q(`select count(*)::int c from public.${table}`);
      assert.equal(c, 0, `platform admin read ${table} rows directly`);
    }
  }));

  test('nobody can read customer session secrets, not even the owner', () => tx(userId('a', 'owner'), async (t) => {
    const { error } = await t.try(`select * from public.table_session_secrets`);
    assert.match(String(error?.message), /permission denied/);
  }));
});

describe('writes never cross tenants', () => {
  // Use the most privileged tenant role: if the owner can't, nobody below can.
  for (const tenant of TENANTS) {
    test(`owner@${tenant} cannot update or delete other tenants' rows`, () => tx(userId(tenant, 'owner'), async (t) => {
      for (const other of others(tenant)) {
        const updates = [
          [`update public.restaurants set name = 'pwned' where id = $1`, rid(other)],
          [`update public.restaurant_settings set tax_percent = 99 where restaurant_id = $1`, rid(other)],
          [`update public.staff set display_name = 'pwned' where restaurant_id = $1`, rid(other)],
          [`update public.menu_items set price_minor = 1 where restaurant_id = $1`, rid(other)],
          [`update public.dining_tables set seats = 99 where restaurant_id = $1`, rid(other)],
          [`update public.orders set status = 'rejected' where restaurant_id = $1`, rid(other)],
          [`update public.order_items set quantity = 99 where restaurant_id = $1`, rid(other)],
          [`update public.payments set amount_minor = 1 where restaurant_id = $1`, rid(other)],
          [`update public.reviews set response = 'pwned' where restaurant_id = $1`, rid(other)],
          [`update public.table_sessions set status = 'closed' where restaurant_id = $1`, rid(other)],
          [`delete from public.menu_items where restaurant_id = $1`, rid(other)],
          [`delete from public.dining_tables where restaurant_id = $1`, rid(other)],
          [`delete from public.order_items where restaurant_id = $1`, rid(other)],
          [`delete from public.staff where restaurant_id = $1`, rid(other)],
        ];
        for (const [sql, param] of updates) {
          const res = await t.try(sql, [param]);
          assert.equal(res.rowCount, 0, `owner@${tenant} affected ${other}'s rows: ${sql}`);
        }
      }
      // and the other tenants' data is provably untouched
      await t.as('service');
      for (const other of others(tenant)) {
        const [r] = await t.q(`select name from public.restaurants where id = $1`, [rid(other)]);
        assert.notEqual(r.name, 'pwned');
        const [m] = await t.q(`select min(price_minor) p from public.menu_items where restaurant_id = $1`, [rid(other)]);
        assert.ok(m.p > 1);
      }
    }));
  }

  test('inserting rows stamped with another tenant\'s restaurant_id is rejected', () => tx(userId('a', 'owner'), async (t) => {
    const B = rid('b');
    const attempts = [
      [`insert into public.menu_categories (restaurant_id, name) values ($1, 'x')`, [B]],
      [`insert into public.menu_items (restaurant_id, category_id, name, price_minor) values ($1, $2, 'x', 100)`,
        [B, id('b', 'category', 1)]],
      [`insert into public.dining_tables (restaurant_id, number) values ($1, 99)`, [B]],
      [`insert into public.staff (restaurant_id, user_id, role, display_name) values ($1, $2, 'waiter', 'x')`,
        [B, NO_TENANT_USER]],
      [`insert into public.orders (restaurant_id, table_id, session_id) values ($1, $2, $3)`,
        [B, id('b', 'table', 5), id('b', 'session', 5)]],
      [`insert into public.payments (restaurant_id, session_id, method, amount_minor) values ($1, $2, 'cash', 100)`,
        [B, id('b', 'session', 5)]],
    ];
    for (const [sql, params] of attempts) {
      const { error } = await t.try(sql, params);
      assert.ok(error, `insert into another tenant succeeded: ${sql}`);
    }
  }));

  test('rows cannot be moved to another tenant by changing restaurant_id', () => tx(userId('a', 'owner'), async (t) => {
    for (const table of ['menu_items', 'dining_tables', 'orders', 'staff']) {
      const { error } = await t.try(
        `update public.${table} set restaurant_id = $1 where restaurant_id = $2`, [rid('b'), rid('a')]);
      assert.ok(error, `moved ${table} rows to tenant b`);
    }
  }));

  test('own rows cannot reference another tenant\'s rows (composite FKs)', () => tx(userId('a', 'manager'), async (t) => {
    const A = rid('a');
    const attempts = [
      ['menu item in A under B\'s category',
        `insert into public.menu_items (restaurant_id, category_id, name, price_minor) values ($1, $2, 'x', 100)`,
        [A, id('b', 'category', 1)]],
      ['order line in A pointing at B\'s menu item',
        `insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, unit_price_minor, quantity)
         values ($1, $2, $3, 'x', 1, 1)`,
        [A, id('a', 'order', 3), id('b', 'item', 1)]],
      ['order line in A attached to B\'s order',
        `insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, unit_price_minor, quantity)
         values ($1, $2, $3, 'x', 1, 1)`,
        [A, id('b', 'order', 3), id('a', 'item', 1)]],
      ['A order on B\'s table',
        `insert into public.orders (restaurant_id, table_id, session_id) values ($1, $2, $3)`,
        [A, id('b', 'table', 5), id('a', 'session', 5)]],
      ['A payment for B\'s session',
        `insert into public.payments (restaurant_id, session_id, method, amount_minor) values ($1, $2, 'cash', 100)`,
        [A, id('b', 'session', 5)]],
    ];
    for (const [label, sql, params] of attempts) {
      const { error } = await t.try(sql, params);
      assert.ok(error, `${label} was accepted`);
    }
    const { error } = await t.try(
      `update public.dining_tables set assigned_waiter_id = $1 where id = $2`,
      [staffId('b', 'waiter'), id('a', 'table', 1)]);
    assert.ok(error, 'assigned B\'s waiter to A\'s table');
  }));

  test('a login already used by one restaurant cannot be added to another', () => tx(userId('a', 'owner'), async (t) => {
    const { error } = await t.try(
      `insert into public.staff (restaurant_id, user_id, role, display_name) values ($1, $2, 'waiter', 'x')`,
      [rid('a'), userId('b', 'waiter')]);
    assert.ok(error, 'B\'s waiter login was attached to A');
  }));
});

describe('audit trail stays inside the tenant', () => {
  test('owner@a sees audit entries for restaurant a only, including their own changes', () => tx(userId('a', 'owner'), async (t) => {
    await t.q(`update public.menu_items set price_minor = 25000 where id = $1`, [id('a', 'item', 1)]);
    const rows = await t.q(`
      select restaurant_id, actor_user_id, actor_role, action from public.audit_log
       where table_name = 'menu_items' and record_id = $1 order by id desc limit 1`, [id('a', 'item', 1)]);
    assert.equal(rows[0].actor_user_id, userId('a', 'owner'));
    assert.equal(rows[0].actor_role, 'owner');
    const [{ n }] = await t.q(`select count(*)::int n from public.audit_log where restaurant_id <> $1`, [rid('a')]);
    assert.equal(n, 0);
  }));

  test('nobody can write or erase audit entries through the API', () => tx(userId('a', 'owner'), async (t) => {
    for (const sql of [
      `delete from public.audit_log`,
      `update public.audit_log set actor_role = 'x'`,
      `insert into public.audit_log (restaurant_id, table_name, action) values ('${rid('a')}', 'x', 'INSERT')`,
    ]) {
      const { error } = await t.try(sql);
      assert.match(String(error?.message), /permission denied/, sql);
    }
  }));
});
