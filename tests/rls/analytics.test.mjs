// Phase 7: analytics are per restaurant, owner/manager only, and count
// accepted orders only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, tx, userId } from '../support/db.mjs';

after(() => pool.end());

const today = () => `current_date`;
const analytics = async (t) =>
  (await t.q(`select public.restaurant_analytics(${today()} - 7, ${today()}) a`))[0].a;

test('owner sees only their own accepted orders', () => tx(userId('a', 'owner'), async (t) => {
  const a = await analytics(t);
  assert.equal(a.totals.orders, 2, 'served order 1 + approved order 2; pending order 3 not counted');
  assert.equal(a.totals.rejected, 0);
  assert.ok(a.top_items.length > 0);
  assert.ok(a.top_items.every((i) => i.name.startsWith('Spice Route')), 'no other restaurant\'s dishes');
  assert.equal(a.reviews.count, 1);
  assert.equal(a.by_day.length, 8);
  assert.equal(a.by_hour.length, 24);
  assert.equal(a.payments.cash_minor, 52000);
}));

test('each restaurant gets its own numbers', () => tx(userId('b', 'manager'), async (t) => {
  const a = await analytics(t);
  assert.ok(a.top_items.every((i) => i.name.startsWith('Bombay Bistro')));
  assert.ok(a.reviews.latest.every((r) => !String(r.comment).includes('Spice Route')));
}));

test('rejected orders are counted separately with their reasons', () => tx(userId('a', 'manager'), async (t) => {
  await t.q(`select public.reject_order('0000000a-0000-4000-8006-000000000003', 'Item finished')`);
  const a = await analytics(t);
  assert.equal(a.totals.rejected, 1);
  assert.deepEqual(a.rejections, [{ reason: 'Item finished', count: 1 }]);
  assert.equal(a.totals.orders, 2);
}));

test('speed of service is measured per stage', () => tx(userId('a', 'chef'), async (t) => {
  await t.q(`select public.advance_order('0000000a-0000-4000-8006-000000000002', 'preparing')`);
  await t.as(userId('a', 'owner'));
  const a = await analytics(t);
  assert.equal(a.speed.to_start.n, 1);
  assert.ok(a.speed.to_start.avg >= 0);
}));

test('waiters, chefs, cashiers and guests cannot see analytics', () => tx(userId('a', 'waiter'), async (t) => {
  for (const role of ['waiter', 'chef', 'cashier']) {
    await t.as(userId('a', role));
    assert.match(String((await t.try(`select public.restaurant_analytics(current_date - 7, current_date)`)).error?.message), /only owners and managers/);
  }
  await t.as('anon');
  assert.ok((await t.try(`select public.restaurant_analytics(current_date - 7, current_date)`)).error);
}));

test('"last N days" uses the restaurant\'s own today', () => tx(userId('a', 'owner'), async (t) => {
  const [{ a }] = await t.q(`select public.restaurant_analytics_recent(1) a`);
  assert.equal(a.by_day.length, 1);
  assert.equal(a.totals.orders, 2);
  assert.ok((await t.try(`select public.restaurant_analytics_recent(7)`)).rows.length === 1);
}));

test('date range is validated', () => tx(userId('a', 'owner'), async (t) => {
  assert.match(String((await t.try(`select public.restaurant_analytics(current_date, current_date - 1)`)).error?.message), /date range/);
  assert.match(String((await t.try(`select public.restaurant_analytics(current_date - 400, current_date)`)).error?.message), /date range/);
}));
