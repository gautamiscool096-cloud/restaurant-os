// Phase 6: bills, cash and online payments, webhook verification, test mode,
// and cross-tenant safety.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool, tx, id, userId, sessionToken } from '../support/db.mjs';

after(() => pool.end());

const SESSION_A = id('a', 'session', 5); // order 2 approved (34000), order 3 pending (9000)
const SESSION_B = id('b', 'session', 5);
const TOKEN_A = sessionToken('a', 5);
// order 2: 340.00 + 10% service + 5% tax on both = 392.70
const TOTAL = 39270;
const SECRET = 'whsec_test_123';
const sign = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('hex');
const bill = async (t, session = SESSION_A) => (await t.q(`select public.staff_session_bill($1) b`, [session]))[0].b;

describe('the bill', () => {
  test('only accepted orders are billed; pending ones are not', () => tx(userId('a', 'cashier'), async (t) => {
    const b = await bill(t);
    assert.equal(b.subtotal_minor, 34000);
    assert.equal(b.total_minor, TOTAL);
    assert.equal(b.due_minor, TOTAL);
    assert.deepEqual(b.orders.map((o) => o.order_number), [2]);
    assert.equal(b.lines[0].quantity, 1);
    assert.equal(b.restaurant.name, 'Spice Route');
  }));

  test('chefs cannot see bills', () => tx(userId('a', 'chef'), async (t) => {
    assert.match(String((await t.try(`select public.staff_session_bill($1)`, [SESSION_A])).error?.message), /cannot see bills/);
    assert.match(String((await t.try(`select public.open_bills()`)).error?.message), /cannot see bills/);
  }));

  test('open bills lists only this restaurant', () => tx(userId('a', 'waiter'), async (t) => {
    const [{ b }] = await t.q(`select public.open_bills() b`);
    assert.deepEqual(b.map((x) => x.session_id), [SESSION_A]);
  }));
});

describe('cash payments', () => {
  test('part payment, then the rest: orders become paid only when settled', () => tx(userId('a', 'waiter'), async (t) => {
    let [{ b }] = await t.q(`select public.record_cash_payment($1, 20000) b`, [SESSION_A]);
    assert.equal(b.paid_minor, 20000);
    assert.equal(b.due_minor, TOTAL - 20000);
    let [o] = await t.q(`select is_paid from public.orders where id = $1`, [id('a', 'order', 2)]);
    assert.equal(o.is_paid, false);
    [{ b }] = await t.q(`select public.record_cash_payment($1, $2) b`, [SESSION_A, TOTAL - 20000]);
    assert.equal(b.due_minor, 0);
    [o] = await t.q(`select is_paid from public.orders where id = $1`, [id('a', 'order', 2)]);
    assert.equal(o.is_paid, true);
    const [p] = await t.q(`select status, collected_by from public.payments where session_id = $1 order by created_at limit 1`, [SESSION_A]);
    assert.equal(p.status, 'captured');
    assert.ok(p.collected_by, 'records who took the cash');
  }));

  test('cannot take more than is due, or nothing', () => tx(userId('a', 'cashier'), async (t) => {
    assert.match(String((await t.try(`select public.record_cash_payment($1, $2)`, [SESSION_A, TOTAL + 1])).error?.message), /more than the amount due/);
    assert.match(String((await t.try(`select public.record_cash_payment($1, 0)`, [SESSION_A])).error?.message), /enter an amount/);
  }));

  test('chefs cannot take payments; nobody can record another restaurant\'s payment', () => tx(userId('a', 'chef'), async (t) => {
    assert.ok((await t.try(`select public.record_cash_payment($1, 100)`, [SESSION_A])).error);
    await t.as(userId('a', 'owner'));
    assert.match(String((await t.try(`select public.record_cash_payment($1, 100)`, [SESSION_B])).error?.message), /not found/);
    assert.match(String((await t.try(`select public.staff_session_bill($1)`, [SESSION_B])).error?.message), /not found/);
    assert.ok((await t.try(`insert into public.payments (restaurant_id, session_id, method, amount_minor) values ($1, $2, 'cash', 100)`,
      [id('b', 'restaurant'), SESSION_B])).error, 'direct insert into another restaurant');
  }));

  test('staff cannot fake an online payment', () => tx(userId('a', 'manager'), async (t) => {
    const r = await t.try(`insert into public.payments (restaurant_id, session_id, method, amount_minor) values ($1, $2, 'online', 100)`,
      [id('a', 'restaurant'), SESSION_A]);
    assert.match(String(r.error?.message), /gateway webhook/);
  }));
});

describe('guests paying online', () => {
  test('guest sees their bill; a wrong token sees nothing', () => tx('anon', async (t) => {
    const [{ b }] = await t.q(`select public.guest_bill($1) b`, [TOKEN_A]);
    assert.equal(b.due_minor, TOTAL);
    assert.equal('payout_ready' in b, false);
    assert.match(String((await t.try(`select public.guest_bill('nope')`)).error?.message), /not found/);
  }));

  test('start payment is idempotent and charges the platform fee', () => tx('service', async (t) => {
    await t.q(`update app.platform_config set platform_fee_bps = 200`);
    await t.as('anon');
    const [{ p: p1 }] = await t.q(`select public.guest_start_online_payment($1) p`, [TOKEN_A]);
    const [{ p: p2 }] = await t.q(`select public.guest_start_online_payment($1) p`, [TOKEN_A]);
    assert.equal(p1.payment_id, p2.payment_id);
    assert.equal(p1.amount_minor, TOTAL);
    assert.equal(p1.platform_fee_minor, Math.floor(TOTAL * 0.02));
  }));

  test('test mode off (the default): guests cannot fake a payment', () => tx('service', async (t) => {
    await t.q(`update app.platform_config set payments_test_mode = false`);
    await t.as('anon');
    const [{ p }] = await t.q(`select public.guest_start_online_payment($1) p`, [TOKEN_A]);
    assert.match(String((await t.try(`select public.guest_complete_test_payment($1, $2)`, [TOKEN_A, p.payment_id])).error?.message), /switched off/);
  }));

  test('test mode on: the test payment settles the bill', () => tx('service', async (t) => {
    await t.q(`update app.platform_config set payments_test_mode = true`);
    await t.as('anon');
    const [{ p }] = await t.q(`select public.guest_start_online_payment($1) p`, [TOKEN_A]);
    const [{ b }] = await t.q(`select public.guest_complete_test_payment($1, $2) b`, [TOKEN_A, p.payment_id]);
    assert.equal(b.due_minor, 0);
    assert.equal(b.payments[0].gateway, 'test');
    assert.match(String((await t.try(`select public.guest_start_online_payment($1)`, [TOKEN_A])).error?.message), /nothing to pay/);
  }));

  test('a guest cannot touch another table\'s payment', () => tx('service', async (t) => {
    await t.q(`update app.platform_config set payments_test_mode = true`);
    await t.as('anon');
    const [{ p }] = await t.q(`select public.guest_start_online_payment($1) p`, [TOKEN_A]);
    const tokenB = sessionToken('b', 5);
    assert.match(String((await t.try(`select public.guest_complete_test_payment($1, $2)`, [tokenB, p.payment_id])).error?.message), /not found/);
    assert.match(String((await t.try(`select public.guest_attach_gateway_order($1, $2, 'order_ABCDEF123')`, [tokenB, p.payment_id])).error?.message), /not found/);
  }));

  test('guests cannot read the payments table directly', () => tx('anon', async (t) => {
    assert.ok((await t.try(`select * from public.payments`)).error);
  }));
});

describe('Razorpay webhook', () => {
  const setup = async (t) => {
    await t.q(`update app.platform_config set razorpay_webhook_secret = $1`, [SECRET]);
    await t.q(`update public.restaurants set payout_account_id = 'acc_TEST123', payout_account_status = 'active' where id = $1`, [id('a', 'restaurant')]);
    await t.as('anon');
    const [{ p }] = await t.q(`select public.guest_start_online_payment($1) p`, [TOKEN_A]);
    await t.q(`select public.guest_attach_gateway_order($1, $2, 'order_RZP000111')`, [TOKEN_A, p.payment_id]);
    return p;
  };
  const captured = (amount = TOTAL) => JSON.stringify({ event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_RZP999', order_id: 'order_RZP000111', amount } } } });

  test('a correctly signed capture marks the bill paid', () => tx('service', async (t) => {
    await setup(t);
    const body = captured();
    const [{ r }] = await t.q(`select public.razorpay_webhook($1, $2) r`, [body, sign(body)]);
    assert.equal(r, 'captured');
    await t.as('service');
    const [p] = await t.q(`select status, gateway_payment_id, settlement_status from public.payments where gateway_order_id = 'order_RZP000111'`);
    assert.deepEqual(p, { status: 'captured', gateway_payment_id: 'pay_RZP999', settlement_status: 'pending' });
    const [o] = await t.q(`select is_paid from public.orders where id = $1`, [id('a', 'order', 2)]);
    assert.equal(o.is_paid, true);

    const settled = JSON.stringify({ event: 'transfer.processed', payload: { transfer: { entity: { source: 'pay_RZP999' } } } });
    await t.as('anon');
    await t.q(`select public.razorpay_webhook($1, $2)`, [settled, sign(settled)]);
    await t.as('service');
    const [p2] = await t.q(`select settlement_status from public.payments where gateway_payment_id = 'pay_RZP999'`);
    assert.equal(p2.settlement_status, 'settled');
  }));

  test('a forged or unsigned webhook is refused', () => tx('service', async (t) => {
    await setup(t);
    const body = captured();
    assert.match(String((await t.try(`select public.razorpay_webhook($1, $2)`, [body, 'deadbeef'])).error?.message), /bad signature/);
    assert.match(String((await t.try(`select public.razorpay_webhook($1, null)`, [body])).error?.message), /bad signature/);
    const forged = captured().replace(String(TOTAL), '1');
    assert.match(String((await t.try(`select public.razorpay_webhook($1, $2)`, [forged, sign(body)])).error?.message), /bad signature/);
  }));

  test('a capture for the wrong amount is ignored', () => tx('service', async (t) => {
    await setup(t);
    const body = captured(100);
    const [{ r }] = await t.q(`select public.razorpay_webhook($1, $2) r`, [body, sign(body)]);
    assert.equal(r, 'ignored');
  }));

  test('without a configured secret every webhook is refused', () => tx('anon', async (t) => {
    const body = captured();
    assert.match(String((await t.try(`select public.razorpay_webhook($1, $2)`, [body, sign(body)])).error?.message), /not configured/);
  }));
});

describe('platform payment settings', () => {
  test('only platform admins can read or change them; secret never comes back', () => tx(userId('a', 'owner'), async (t) => {
    assert.ok((await t.try(`select public.platform_payment_settings()`)).error);
    assert.ok((await t.try(`select public.platform_set_payment_settings(true, 0, 'x')`)).error);
    await t.as('0000000f-0000-4000-8000-000000000001');
    const [{ s }] = await t.q(`select public.platform_set_payment_settings(false, 150, 'whsec_abc') s`);
    assert.deepEqual({ ...s, updated_at: undefined }, { payments_test_mode: false, platform_fee_bps: 150, webhook_secret_set: true, updated_at: undefined });
    assert.ok(!JSON.stringify(s).includes('whsec_abc'));
  }));
});
