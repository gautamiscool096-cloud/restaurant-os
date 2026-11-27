// Phase 4: approval, rejection, editing, totals and table sessions.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, tx, id, userId, staffId } from '../support/db.mjs';

after(() => pool.end());

const PENDING_A = id('a', 'order', 3);
const APPROVED_A = id('a', 'order', 2);
const PENDING_B = id('b', 'order', 3);
const totals = async (t, orderId) =>
  (await t.q(`select subtotal_minor s, service_charge_minor c, tax_minor x, total_minor tot from public.orders where id = $1`, [orderId]))[0];

describe('approve / reject', () => {
  test('manager approves a pending order; it records who and when', () => tx(userId('a', 'manager'), async (t) => {
    const [o] = await t.q(`select * from public.approve_order($1)`, [PENDING_A]);
    assert.equal(o.status, 'approved');
    assert.equal(o.approved_by, staffId('a', 'manager'));
    const again = await t.try(`select public.approve_order($1)`, [PENDING_A]);
    assert.match(String(again.error?.message), /no longer waiting/);
  }));

  test('reject stores the reason', () => tx(userId('a', 'owner'), async (t) => {
    const [o] = await t.q(`select * from public.reject_order($1, '  Kitchen closing  ')`, [PENDING_A]);
    assert.equal(o.status, 'rejected');
    assert.equal(o.rejected_reason, 'Kitchen closing');
  }));

  test('waiters, chefs and cashiers cannot approve or reject', () => tx(userId('a', 'waiter'), async (t) => {
    for (const role of ['waiter', 'chef', 'cashier']) {
      await t.as(userId('a', role));
      assert.ok((await t.try(`select public.approve_order($1)`, [PENDING_A])).error, `${role} approved`);
      assert.ok((await t.try(`select public.reject_order($1)`, [PENDING_A])).error, `${role} rejected`);
    }
  }));

  test('a manager cannot approve, reject, edit or close another restaurant\'s orders/tables', () => tx(userId('a', 'manager'), async (t) => {
    assert.match(String((await t.try(`select public.approve_order($1)`, [PENDING_B])).error?.message), /no longer waiting/);
    assert.match(String((await t.try(`select public.reject_order($1)`, [PENDING_B])).error?.message), /no longer waiting/);
    assert.match(String((await t.try(`select public.edit_order($1, '[]', '[]')`, [PENDING_B])).error?.message), /not found/);
    assert.match(String((await t.try(`select public.close_table_session($1)`, [id('b', 'session', 5)])).error?.message), /already free/);
    await t.as('service');
    const [b] = await t.q(`select status from public.orders where id = $1`, [PENDING_B]);
    assert.equal(b.status, 'pending');
    const [s] = await t.q(`select status from public.table_sessions where id = $1`, [id('b', 'session', 5)]);
    assert.equal(s.status, 'open');
  }));
});

describe('editing a pending order', () => {
  test('change quantity, add an item, remove a line: totals follow automatically', () => tx(userId('a', 'manager'), async (t) => {
    // pending A order 3 = 1 x Masala Chaas (9000). A: 10% service, 5% tax.
    const line = id('a', 'orderItem', 2);
    await t.q(`select public.edit_order($1, $2::jsonb, $3::jsonb)`, [PENDING_A,
      JSON.stringify([{ order_item_id: line, quantity: 3 }]),
      JSON.stringify([{ menu_item_id: id('a', 'item', 1), quantity: 1, special_instructions: 'extra mint' }])]);
    let x = await totals(t, PENDING_A);
    const sub = 3 * 9000 + 24000;
    assert.deepEqual(x, { s: sub, c: Math.round(sub * 0.1), x: Math.round((sub + Math.round(sub * 0.1)) * 0.05), tot: sub + 5100 + 2805 });

    await t.q(`select public.edit_order($1, $2::jsonb)`, [PENDING_A, JSON.stringify([{ order_item_id: line, quantity: 0 }])]);
    x = await totals(t, PENDING_A);
    assert.equal(x.s, 24000);
    const lines = await t.q(`select name_snapshot, unit_price_minor, special_instructions from public.order_items where order_id = $1`, [PENDING_A]);
    assert.deepEqual(lines, [{ name_snapshot: 'Spice Route Paneer Tikka', unit_price_minor: 24000, special_instructions: 'extra mint' }]);
  }));

  test('cannot remove the last line (reject instead)', () => tx(userId('a', 'manager'), async (t) => {
    const res = await t.try(`select public.edit_order($1, $2::jsonb)`, [PENDING_A,
      JSON.stringify([{ order_item_id: id('a', 'orderItem', 2), quantity: 0 }])]);
    assert.match(String(res.error?.message), /at least one item/);
  }));

  test('cannot add another restaurant\'s dish to an order', () => tx(userId('a', 'manager'), async (t) => {
    const res = await t.try(`select public.edit_order($1, '[]', $2::jsonb)`, [PENDING_A,
      JSON.stringify([{ menu_item_id: id('b', 'item', 1), quantity: 1 }])]);
    assert.ok(res.error);
  }));

  test('once approved, quantities are locked; a manager can still cancel one line', () => tx(userId('a', 'manager'), async (t) => {
    const line = id('a', 'orderItem', 1);
    assert.match(String((await t.try(`select public.edit_order($1, $2::jsonb)`, [APPROVED_A,
      JSON.stringify([{ order_item_id: line, quantity: 2 }])])).error?.message), /waiting for approval/);
    assert.match(String((await t.try(`select public.edit_order($1, '[]', $2::jsonb)`, [APPROVED_A,
      JSON.stringify([{ menu_item_id: id('a', 'item', 1), quantity: 1 }])])).error?.message), /waiting for approval/);
    await t.q(`update public.order_items set status = 'cancelled' where id = $1`, [line]);
    assert.equal((await totals(t, APPROVED_A)).tot, 0);
  }));

  test('nobody can set totals or prices by hand', () => tx(userId('a', 'owner'), async (t) => {
    assert.match(String((await t.try(`update public.orders set total_minor = 1 where id = $1`, [PENDING_A])).error?.message), /calculated by the system/);
    assert.match(String((await t.try(`update public.order_items set unit_price_minor = 1 where id = $1`, [id('a', 'orderItem', 2)])).error?.message), /only the quantity/);
  }));

  test('chefs cannot cancel lines', () => tx(userId('a', 'chef'), async (t) => {
    assert.ok((await t.try(`update public.order_items set status = 'cancelled' where id = $1`, [id('a', 'orderItem', 1)])).error);
  }));
});

describe('table sessions and the board', () => {
  test('staff can close a table; it cannot be reopened through the API', () => tx(userId('a', 'waiter'), async (t) => {
    await t.q(`select public.close_table_session($1)`, [id('a', 'session', 5)]);
    await t.as(userId('a', 'owner'));
    const [s] = await t.q(`select status, closed_at from public.table_sessions where id = $1`, [id('a', 'session', 5)]);
    assert.equal(s.status, 'closed');
    assert.ok(s.closed_at);
    const re = await t.try(`update public.table_sessions set status = 'open' where id = $1`, [id('a', 'session', 5)]);
    assert.match(String(re.error?.message), /only be closed/);
  }));

  test('after closing, the next guests at that table can start a fresh order', () => tx(userId('a', 'manager'), async (t) => {
    await t.q(`select public.close_table_session($1)`, [id('a', 'session', 5)]);
    await t.as('anon');
    const { error } = await t.try(`select public.place_order('spice-route', 'spice-route-table-5-qr', $1::jsonb)`,
      [JSON.stringify([{ menu_item_id: id('a', 'item', 1), quantity: 1 }])]);
    assert.equal(error, null);
  }));

  test('staff_board shows only this restaurant: every table, open sessions and their orders', () => tx(userId('b', 'chef'), async (t) => {
    const [{ board }] = await t.q(`select public.staff_board() board`);
    assert.equal(board.length, 8);
    for (const tbl of board) assert.ok(tbl.table_id.startsWith('0000000b-'));
    const t5 = board.find((x) => x.number === 5);
    assert.equal(t5.session.id, id('b', 'session', 5));
    assert.deepEqual(t5.orders.map((o) => o.id).sort(), [id('b', 'order', 2), id('b', 'order', 3)]);
    const t1 = board.find((x) => x.number === 1);
    assert.equal(t1.session, null, 'closed seating is not shown as occupied');
  }));

  test('staff_board and staff_menu are empty for users with no restaurant and refused for anon', () => tx('0000000e-0000-4000-8000-000000000001', async (t) => {
    const [{ b }] = await t.q(`select public.staff_board() b`);
    assert.deepEqual(b, []);
    const [{ m }] = await t.q(`select public.staff_menu() m`);
    assert.deepEqual(m, []);
    await t.as('anon');
    assert.match(String((await t.try(`select public.staff_board()`)).error?.message), /permission denied/);
  }));
});
