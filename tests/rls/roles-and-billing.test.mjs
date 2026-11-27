// Inside a tenant: role-based workflow rules, billing gates, platform layer,
// and self-serve onboarding.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, tx, id, userId, staffId, PLATFORM_ADMIN, NO_TENANT_USER } from '../support/db.mjs';

after(() => pool.end());

const rid = (tenant) => id(tenant, 'restaurant');
const PENDING = id('a', 'order', 3);
const APPROVED = id('a', 'order', 2);

describe('order workflow by role', () => {
  test('waiter and chef cannot approve; manager can, and is recorded as approver', () => tx(userId('a', 'waiter'), async (t) => {
    for (const role of ['waiter', 'chef', 'cashier']) {
      await t.as(userId('a', role));
      const res = await t.try(`update public.orders set status = 'approved' where id = $1`, [PENDING]);
      assert.ok(res.error || res.rowCount === 0, `${role} approved an order`);
    }
    await t.as(userId('a', 'manager'));
    await t.q(`update public.orders set status = 'approved' where id = $1`, [PENDING]);
    const [o] = await t.q(`select status, approved_by, approved_at from public.orders where id = $1`, [PENDING]);
    assert.equal(o.status, 'approved');
    assert.equal(o.approved_by, staffId('a', 'manager'));
    assert.ok(o.approved_at);

    const [audit] = await t.q(`
      select actor_user_id, actor_role, old_data ->> 'status' old_s, new_data ->> 'status' new_s
        from public.audit_log where table_name = 'orders' and record_id = $1
       order by id desc limit 1`, [PENDING]);
    assert.deepEqual(audit, { actor_user_id: userId('a', 'manager'), actor_role: 'manager', old_s: 'pending', new_s: 'approved' });
  }));

  test('chef moves approved -> preparing -> ready, but cannot touch money or skip steps', () => tx(userId('a', 'chef'), async (t) => {
    assert.ok((await t.try(`update public.orders set status = 'preparing' where id = $1`, [PENDING])).error,
      'chef started a pending order');
    assert.ok((await t.try(`update public.orders set total_minor = 1 where id = $1`, [APPROVED])).error,
      'chef changed an order total');
    await t.q(`update public.orders set status = 'preparing' where id = $1`, [APPROVED]);
    await t.q(`update public.order_items set status = 'preparing' where order_id = $1`, [APPROVED]);
    await t.q(`update public.order_items set status = 'ready' where order_id = $1`, [APPROVED]);
    await t.q(`update public.orders set status = 'ready' where id = $1`, [APPROVED]);
    assert.ok((await t.try(`update public.orders set status = 'served' where id = $1`, [APPROVED])).error,
      'chef marked an order served');
    const [i] = await t.q(`select started_at, ready_at from public.order_items where order_id = $1`, [APPROVED]);
    assert.ok(i.started_at && i.ready_at, 'prep timestamps recorded');
  }));

  test('chef cannot start items of an order that is still pending approval', () => tx(userId('a', 'chef'), async (t) => {
    const res = await t.try(`update public.order_items set status = 'preparing' where order_id = $1`, [PENDING]);
    assert.ok(res.error);
  }));

  test('waiter marks ready food served but cannot change quantities or prices', () => tx('service', async (t) => {
    await t.q(`update public.order_items set status = 'ready' where order_id = $1`, [APPROVED]);
    await t.as(userId('a', 'waiter'));
    assert.ok((await t.try(`update public.order_items set quantity = 5 where order_id = $1`, [APPROVED])).error);
    assert.ok((await t.try(`update public.order_items set unit_price_minor = 1 where order_id = $1`, [APPROVED])).error);
    await t.q(`update public.order_items set status = 'served' where order_id = $1`, [APPROVED]);
    await t.q(`update public.orders set status = 'served' where id = $1`, [APPROVED]);
    const [o] = await t.q(`select status, served_at from public.orders where id = $1`, [APPROVED]);
    assert.equal(o.status, 'served');
    assert.ok(o.served_at);
  }));

  test('waiter-added items are priced from the menu, not the client', () => tx(userId('a', 'waiter'), async (t) => {
    const [row] = await t.q(`
      insert into public.order_items (restaurant_id, order_id, menu_item_id, name_snapshot, unit_price_minor, quantity)
      values ($1, $2, $3, 'free food', 1, 1) returning name_snapshot, unit_price_minor`,
      [rid('a'), PENDING, id('a', 'item', 4)]);
    assert.equal(row.unit_price_minor, 34000);
    assert.notEqual(row.name_snapshot, 'free food');
  }));
});

describe('payments by role', () => {
  test('kitchen cannot see payments; cashier records cash, forced to captured', () => tx(userId('a', 'chef'), async (t) => {
    const [{ n }] = await t.q(`select count(*)::int n from public.payments`);
    assert.equal(n, 0);
    await t.as(userId('a', 'cashier'));
    const [p] = await t.q(`
      insert into public.payments (restaurant_id, session_id, method, status, amount_minor, gateway_payment_id)
      values ($1, $2, 'cash', 'refunded', 43000, 'fake') returning status, collected_by, gateway_payment_id`,
      [rid('a'), id('a', 'session', 5)]);
    assert.deepEqual(p, { status: 'captured', collected_by: staffId('a', 'cashier'), gateway_payment_id: null });
  }));

  test('staff cannot fabricate online payments (only the gateway webhook can)', () => tx(userId('a', 'owner'), async (t) => {
    const res = await t.try(`
      insert into public.payments (restaurant_id, session_id, method, amount_minor) values ($1, $2, 'online', 100)`,
      [rid('a'), id('a', 'session', 5)]);
    assert.match(String(res.error?.message), /gateway webhook/);
  }));
});

describe('staff management', () => {
  test('nobody can mint an owner via the API, and managers cannot create managers', () => tx(userId('a', 'owner'), async (t) => {
    const ins = (role) => t.try(
      `insert into public.staff (restaurant_id, user_id, role, display_name) values ($1, $2, $3, 'x')`,
      [rid('a'), NO_TENANT_USER, role]);
    assert.ok((await ins('owner')).error, 'owner created another owner');
    await t.as(userId('a', 'manager'));
    assert.ok((await ins('manager')).error, 'manager created a manager');
    assert.equal((await ins('waiter')).error, null, 'manager should be able to add a waiter');
  }));

  test('staff cannot promote themselves', () => tx(userId('a', 'manager'), async (t) => {
    const res = await t.try(`update public.staff set role = 'owner' where user_id = $1`, [userId('a', 'manager')]);
    assert.ok(res.error);
  }));

  test('waiters cannot manage menu, tables or staff', () => tx(userId('a', 'waiter'), async (t) => {
    for (const sql of [
      `update public.menu_items set price_minor = 1`,
      `update public.dining_tables set seats = 1`,
      `update public.staff set display_name = 'x'`,
      `update public.restaurant_settings set tax_percent = 0`,
    ]) {
      const res = await t.try(sql);
      assert.ok(res.error || res.rowCount === 0, sql);
    }
  }));
});

describe('billing gates (subscription_status)', () => {
  test('owners cannot change their own billing, slug or suspension', () => tx(userId('a', 'owner'), async (t) => {
    for (const sql of [
      `update public.restaurants set subscription_status = 'cancelled'`,
      `update public.restaurants set plan = 'enterprise'`,
      `update public.restaurants set payout_account_id = 'acc_attacker'`,
      `update public.restaurants set trial_ends_at = now() + interval '10 years'`,
      `update public.restaurants set suspended_at = now()`,
      `update public.restaurants set slug = 'bombay-bistro-2'`,
      `update public.restaurant_settings set order_seq = 0`,
    ]) {
      assert.ok((await t.try(sql)).error, sql);
    }
    assert.equal((await t.try(`update public.restaurants set name = 'Spice Route Indiranagar'`)).error, null);
  }));

  for (const [label, sql] of [
    ['suspended', `update public.restaurants set suspended_at = now() where id = $1`],
    ['cancelled', `update public.restaurants set subscription_status = 'cancelled' where id = $1`],
    ['trial expired', `update public.restaurants set subscription_status = 'trialing', trial_ends_at = now() - interval '1 day' where id = $1`],
    ['past due beyond grace', `update public.restaurants set subscription_status = 'past_due', current_period_end = now() - interval '8 days' where id = $1`],
  ]) {
    test(`${label}: the tenant's dashboard data goes dark, other tenants unaffected`, () => tx('service', async (t) => {
      await t.q(sql, [rid('a')]);
      await t.as(userId('a', 'owner'));
      const [{ n }] = await t.q(`select count(*)::int n from public.orders`);
      assert.equal(n, 0);
      // still able to see own restaurant row (to show billing state / pay)
      const [r] = await t.q(`select id from public.restaurants`);
      assert.equal(r.id, rid('a'));
      assert.equal((await t.try(`update public.menu_items set price_minor = 1`)).rowCount, 0);
      await t.as(userId('b', 'owner'));
      const [{ m }] = await t.q(`select count(*)::int m from public.orders`);
      assert.ok(m > 0);
    }));
  }

  test('past due within the 7-day grace period keeps working', () => tx('service', async (t) => {
    await t.q(`update public.restaurants set subscription_status = 'past_due', current_period_end = now() - interval '2 days' where id = $1`, [rid('a')]);
    await t.as(userId('a', 'waiter'));
    const [{ n }] = await t.q(`select count(*)::int n from public.orders`);
    assert.ok(n > 0);
  }));
});

describe('platform super-admin', () => {
  test('can suspend a tenant and read platform metrics; tenants cannot read metrics', () => tx(PLATFORM_ADMIN, async (t) => {
    await t.q(`update public.restaurants set suspended_at = now(), suspended_reason = 'fraud' where id = $1`, [rid('c')]);
    const [{ m }] = await t.q(`select public.platform_metrics() m`);
    assert.equal(m.restaurants_total, 3);
    assert.equal(m.restaurants_suspended, 1);
    assert.equal(m.gmv_minor_all_time, 3 * 52000);
    await t.as(userId('a', 'owner'));
    assert.match(String((await t.try(`select public.platform_metrics()`)).error?.message), /platform admins only/);
  }));

  test('tenant owners cannot make themselves platform admins', () => tx(userId('a', 'owner'), async (t) => {
    const res = await t.try(`insert into public.platform_admins (user_id) values ($1)`, [userId('a', 'owner')]);
    assert.match(String(res.error?.message), /permission denied/);
  }));
});

describe('self-serve onboarding', () => {
  test('a new user creates a restaurant with an empty menu and default tables, isolated from everyone', () => tx(NO_TENANT_USER, async (t) => {
    const [{ new_id: newId }] = await t.q(
      `select (public.create_restaurant('Dosa Den', 'dosa-den', 'Asha', 'Indiranagar', 'South Indian', null, 6)).id as new_id`);
    const [me] = await t.q(`select role, restaurant_id from public.staff where user_id = $1`, [NO_TENANT_USER]);
    assert.equal(me.role, 'owner');
    const [{ tables }] = await t.q(`select count(*)::int tables from public.dining_tables`);
    assert.equal(tables, 6);
    const [{ items }] = await t.q(`select count(*)::int items from public.menu_items`);
    assert.equal(items, 0);
    const [{ cats }] = await t.q(`select count(*)::int cats from public.menu_categories`);
    assert.ok(cats > 0);
    const rs = await t.q(`select id, subscription_status from public.restaurants`);
    assert.equal(rs.length, 1);
    assert.equal(rs[0].id, newId);
    assert.equal(me.restaurant_id, newId);
    assert.equal(rs[0].subscription_status, 'trialing');

    await t.as(userId('a', 'owner'));
    const [{ n }] = await t.q(`select count(*)::int n from public.restaurants where slug = 'dosa-den'`);
    assert.equal(n, 0);
  }));

  test('existing staff cannot open a second restaurant; anon cannot onboard; slugs are unique', () => tx(userId('a', 'waiter'), async (t) => {
    assert.match(String((await t.try(`select public.create_restaurant('X', 'x-place', 'x')`)).error?.message),
      /already belongs/);
    await t.as(NO_TENANT_USER);
    assert.ok((await t.try(`select public.create_restaurant('X', 'spice-route', 'x')`)).error, 'duplicate slug accepted');
    await t.as('anon');
    assert.match(String((await t.try(`select public.create_restaurant('X', 'x-place', 'x')`)).error?.message),
      /permission denied/);
  }));
});
