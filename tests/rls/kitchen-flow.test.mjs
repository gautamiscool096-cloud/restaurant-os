// Phase 5: kitchen and waiter steps, stage timestamps, cross-tenant safety.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, tx, id, userId } from '../support/db.mjs';

after(() => pool.end());

const APPROVED_A = id('a', 'order', 2); // 1 x Butter Chicken, approved
const PENDING_A = id('a', 'order', 3);
const APPROVED_B = id('b', 'order', 2);
const advance = (t, orderId, to) => t.q(`select * from public.advance_order($1, $2)`, [orderId, to]).then((r) => r[0]);
const itemStatuses = async (t, orderId) =>
  (await t.q(`select status from public.order_items where order_id = $1 order by created_at`, [orderId])).map((r) => r.status);

describe('kitchen and waiter steps', () => {
  test('chef starts cooking and marks ready; waiter serves; every stage is time-stamped', () => tx(userId('a', 'chef'), async (t) => {
    let o = await advance(t, APPROVED_A, 'preparing');
    assert.equal(o.status, 'preparing');
    assert.ok(o.preparing_at, 'preparing_at set');
    assert.deepEqual(await itemStatuses(t, APPROVED_A), ['preparing']);

    o = await advance(t, APPROVED_A, 'ready');
    assert.equal(o.status, 'ready');
    assert.ok(o.ready_at, 'ready_at set');
    assert.deepEqual(await itemStatuses(t, APPROVED_A), ['ready']);

    await t.as(userId('a', 'waiter'));
    o = await advance(t, APPROVED_A, 'served');
    assert.equal(o.status, 'served');
    assert.ok(o.served_at, 'served_at set');
    assert.ok(o.approved_at && o.preparing_at && o.ready_at, 'earlier stage times kept');
    assert.deepEqual(await itemStatuses(t, APPROVED_A), ['served']);
  }));

  test('the board shows every stage time', () => tx(userId('a', 'chef'), async (t) => {
    await advance(t, APPROVED_A, 'preparing');
    const [{ b }] = await t.q(`select public.staff_board() b`);
    const order = b.flatMap((tb) => tb.orders).find((x) => x.id === APPROVED_A);
    for (const k of ['created_at', 'approved_at', 'preparing_at', 'ready_at', 'served_at']) assert.ok(k in order, k);
    assert.ok(order.preparing_at);
    assert.equal(order.ready_at, null);
  }));

  test('steps cannot be skipped or repeated', () => tx(userId('a', 'chef'), async (t) => {
    assert.match(String((await t.try(`select public.advance_order($1, 'ready')`, [APPROVED_A])).error?.message), /already moved on/);
    assert.match(String((await t.try(`select public.advance_order($1, 'preparing')`, [PENDING_A])).error?.message), /already moved on/);
    assert.match(String((await t.try(`select public.advance_order($1, 'approved')`, [PENDING_A])).error?.message), /cooking, ready or served/);
    await advance(t, APPROVED_A, 'preparing');
    assert.match(String((await t.try(`select public.advance_order($1, 'preparing')`, [APPROVED_A])).error?.message), /already moved on/);
  }));

  test('waiters cannot cook, chefs cannot serve, cashiers can do neither', () => tx(userId('a', 'waiter'), async (t) => {
    assert.ok((await t.try(`select public.advance_order($1, 'preparing')`, [APPROVED_A])).error, 'waiter started cooking');
    await t.as(userId('a', 'cashier'));
    assert.ok((await t.try(`select public.advance_order($1, 'preparing')`, [APPROVED_A])).error, 'cashier started cooking');
    assert.ok((await t.try(`select public.advance_order($1, 'served')`, [APPROVED_A])).error, 'cashier served');
    await t.as(userId('a', 'chef'));
    await advance(t, APPROVED_A, 'preparing');
    await advance(t, APPROVED_A, 'ready');
    assert.ok((await t.try(`select public.advance_order($1, 'served')`, [APPROVED_A])).error, 'chef served');
  }));

  test('managers can take any step', () => tx(userId('a', 'manager'), async (t) => {
    await advance(t, APPROVED_A, 'preparing');
    await advance(t, APPROVED_A, 'ready');
    const o = await advance(t, APPROVED_A, 'served');
    assert.equal(o.status, 'served');
  }));

  test('cancelled dishes stay cancelled when the order moves on', () => tx(userId('a', 'manager'), async (t) => {
    await t.q(`update public.order_items set status = 'cancelled' where id = $1`, [id('a', 'orderItem', 1)]);
    await advance(t, APPROVED_A, 'preparing');
    assert.deepEqual(await itemStatuses(t, APPROVED_A), ['cancelled']);
  }));
});

describe('stage times come from the database clock only', () => {
  test('nobody, not even the owner, can write stage times', () => tx(userId('a', 'owner'), async (t) => {
    const [before] = await t.q(`select approved_at from public.orders where id = $1`, [APPROVED_A]);
    await t.q(`update public.orders set approved_at = now() - interval '1 day', preparing_at = now() - interval '1 day',
                 ready_at = now(), served_at = now() where id = $1`, [APPROVED_A]);
    const [after] = await t.q(`select approved_at, preparing_at, ready_at, served_at from public.orders where id = $1`, [APPROVED_A]);
    assert.deepEqual(after, { approved_at: before.approved_at, preparing_at: null, ready_at: null, served_at: null });
  }));

  test('a chef cannot backdate a stage while moving it', () => tx(userId('a', 'chef'), async (t) => {
    await t.q(`update public.orders set status = 'preparing', preparing_at = now() - interval '1 hour' where id = $1`, [APPROVED_A]);
    const [o] = await t.q(`select preparing_at > now() - interval '1 minute' fresh from public.orders where id = $1`, [APPROVED_A]);
    assert.equal(o.fresh, true);
  }));
});

describe('cross-tenant', () => {
  test('Spice Route kitchen and waiters cannot move Bombay Bistro orders', () => tx(userId('a', 'chef'), async (t) => {
    assert.match(String((await t.try(`select public.advance_order($1, 'preparing')`, [APPROVED_B])).error?.message), /already moved on/);
    await t.as(userId('a', 'waiter'));
    assert.match(String((await t.try(`select public.advance_order($1, 'served')`, [APPROVED_B])).error?.message), /already moved on/);
    await t.as(userId('a', 'owner'));
    assert.match(String((await t.try(`select public.advance_order($1, 'served')`, [APPROVED_B])).error?.message), /already moved on/);
    await t.as('service');
    const [b] = await t.q(`select status, preparing_at, served_at from public.orders where id = $1`, [APPROVED_B]);
    assert.deepEqual(b, { status: 'approved', preparing_at: null, served_at: null });
  }));

  test('each kitchen board only lists its own restaurant', () => tx(userId('b', 'chef'), async (t) => {
    const [{ b }] = await t.q(`select public.staff_board() b`);
    const ids = b.flatMap((tb) => tb.orders.map((o) => o.id));
    assert.ok(ids.includes(APPROVED_B));
    assert.ok(!ids.includes(APPROVED_A));
    assert.ok(ids.every((x) => x.startsWith('0000000b')), 'only Bombay Bistro orders');
  }));

  test('guests (anon) cannot call advance_order', () => tx('anon', async (t) => {
    assert.ok((await t.try(`select public.advance_order($1, 'served')`, [APPROVED_A])).error);
  }));
});
