// Phase 9: platform super-admin console and restaurant subscriptions.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool, tx, id, userId, PLATFORM_ADMIN, NO_TENANT_USER } from '../support/db.mjs';

after(() => pool.end());

const err = (r) => String(r.error?.message ?? '');
const A = id('a', 'restaurant');

test('only platform admins can use the console', () => tx(userId('a', 'owner'), async (t) => {
  for (const who of [userId('a', 'owner'), userId('b', 'manager'), NO_TENANT_USER]) {
    await t.as(who);
    for (const sql of [
      `select public.platform_restaurants()`, `select public.platform_update_restaurant('${A}', '{"status":"active"}')`,
      `select public.platform_plans()`, `select public.platform_save_plan('x', 'X', 1, null, true)`,
      `select public.platform_audit_recent()`,
    ]) assert.match(err(await t.try(sql)), /platform admins only/, `${who}: ${sql}`);
    const [{ a }] = await t.q(`select public.am_platform_admin() a`);
    assert.equal(a, false);
  }
  await t.as('anon');
  assert.ok((await t.try(`select public.platform_restaurants()`)).error);
}));

test('admin lists every restaurant and searches', () => tx(PLATFORM_ADMIN, async (t) => {
  const [{ a }] = await t.q(`select public.am_platform_admin() a`);
  assert.equal(a, true);
  const [{ list }] = await t.q(`select public.platform_restaurants() list`);
  assert.ok(list.length >= 3);
  assert.ok(list.every((r) => 'gmv_30d_minor' in r && 'payout_account_status' in r));
  const [{ found }] = await t.q(`select public.platform_restaurants('bombay') found`);
  assert.deepEqual(found.map((r) => r.slug), ['bombay-bistro']);
}));

test('suspend and restore a restaurant; staff are blocked meanwhile', () => tx(PLATFORM_ADMIN, async (t) => {
  assert.match(err(await t.try(`select public.platform_update_restaurant($1, '{"suspend":true}')`, [A])), /say why/);
  const [{ r }] = await t.q(`select public.platform_update_restaurant($1, '{"suspend":true,"suspended_reason":"Unpaid"}') r`, [A]);
  assert.equal(r.suspended, true);
  assert.equal(r.operational, false);
  await t.as(userId('a', 'manager'));
  const [{ n }] = await t.q(`select count(*)::int n from public.orders`);
  assert.equal(n, 0, 'suspended restaurant sees no orders');
  await t.as(userId('b', 'manager'));
  const [{ n: nb }] = await t.q(`select count(*)::int n from public.orders`);
  assert.ok(nb > 0, 'other restaurants unaffected');
  await t.as(PLATFORM_ADMIN);
  const [{ r: back }] = await t.q(`select public.platform_update_restaurant($1, '{"suspend":false}') r`, [A]);
  assert.equal(back.suspended, false);
  const [{ log }] = await t.q(`select public.platform_audit_recent(5) log`);
  assert.equal(log[0].action, 'restaurant_update');
  assert.equal(log[0].actor_user_id, PLATFORM_ADMIN);
}));

test('trial, plan and payout account changes are validated', () => tx(PLATFORM_ADMIN, async (t) => {
  assert.match(err(await t.try(`select public.platform_update_restaurant($1, '{"plan":"gold"}')`, [A])), /unknown plan/);
  assert.match(err(await t.try(`select public.platform_update_restaurant($1, '{"status":"weird"}')`, [A])), /check the values/);
  assert.match(err(await t.try(`select public.platform_update_restaurant($1, '{"payout_account_status":"active"}')`, [A])), /acc_/);
  const [{ r }] = await t.q(`select public.platform_update_restaurant($1, $2) r`,
    [A, { plan: 'pro', extend_trial_days: 10, payout_account_id: 'acc_TEST123', payout_account_status: 'active' }]);
  assert.equal(r.plan, 'pro');
  assert.equal(r.payout_account_status, 'active');
  assert.ok(new Date(r.trial_ends_at) > new Date(Date.now() + 9 * 86400e3));
  assert.match(err(await t.try(`select public.platform_update_restaurant($1, '{}')`, ['00000000-0000-4000-8000-000000000000'])), /not found/);
}));

test('restaurant staff still cannot change billing fields themselves', () => tx(userId('c', 'owner'), async (t) => {
  const r = await t.try(`update public.restaurants set subscription_status = 'active' where id = $1`, [id('c', 'restaurant')]);
  assert.match(err(r), /only the platform/);
}));

test('admin edits plans; owners see public plans only', () => tx(PLATFORM_ADMIN, async (t) => {
  await t.q(`select public.platform_save_plan('standard', 'Standard', 99900, 'Cheaper', true)`);
  await t.q(`select public.platform_save_plan('secret', 'Secret', 1, null, false)`);
  assert.match(err(await t.try(`select public.platform_save_plan('Bad Code!', 'X', 1, null, true)`)), /lowercase/);
  await t.as(userId('a', 'owner'));
  const [{ o }] = await t.q(`select public.subscription_overview() o`);
  assert.equal(o.plans.find((p) => p.code === 'standard').price_minor, 99900);
  assert.ok(!o.plans.some((p) => p.code === 'secret'));
  assert.match(err(await t.try(`select public.start_subscription('secret')`)), /pick one of the plans/);
}));

test('owner subscribes in test mode, even after the trial ran out', () => tx(PLATFORM_ADMIN, async (t) => {
  await t.as('service');
  await t.q(`update public.restaurants set trial_ends_at = now() - interval '1 day' where id = $1`, [id('c', 'restaurant')]);
  await t.as(userId('c', 'owner'));
  const [{ o }] = await t.q(`select public.subscription_overview() o`);
  assert.equal(o.operational, false);
  const [{ s }] = await t.q(`select public.start_subscription('pro') s`);
  assert.equal(s.status, 'active');
  assert.equal(s.plan, 'pro');
  assert.equal(s.operational, true);
  await t.as(userId('c', 'manager'));
  assert.match(err(await t.try(`select public.start_subscription('pro')`)), /only the owner/);
  assert.match(err(await t.try(`select public.subscription_overview()`)), /only the owner/);
}));

test('live mode refuses instant activation with a plain message', () => tx('service', async (t) => {
  await t.q(`update app.platform_config set payments_test_mode = false`);
  await t.as(userId('b', 'owner'));
  assert.match(err(await t.try(`select public.start_subscription('standard')`)), /not switched on yet/);
}));

test('signed Razorpay subscription webhooks update only the matching restaurant', () => tx('service', async (t) => {
  await t.q(`update app.platform_config set razorpay_webhook_secret = 'whsec_t'`);
  await t.q(`update public.restaurants set billing_subscription_id = 'sub_A1', subscription_status = 'trialing' where id = $1`, [A]);
  const send = async (event, extra = {}) => {
    const body = JSON.stringify({ event, payload: { subscription: { entity: { id: 'sub_A1', ...extra } } } });
    const sig = crypto.createHmac('sha256', 'whsec_t').update(body).digest('hex');
    await t.as('anon');
    const [{ r }] = await t.q(`select public.razorpay_webhook($1, $2) r`, [body, sig]);
    await t.as('service');
    return r;
  };
  const end = Math.floor(Date.now() / 1000) + 30 * 86400;
  assert.equal(await send('subscription.charged', { current_end: end }), 'subscription');
  let [row] = await t.q(`select subscription_status::text s, extract(epoch from current_period_end)::bigint e from public.restaurants where id = $1`, [A]);
  assert.deepEqual(row, { s: 'active', e: String(end) });
  assert.equal(await send('subscription.halted'), 'subscription');
  [row] = await t.q(`select subscription_status::text s from public.restaurants where id = $1`, [A]);
  assert.equal(row.s, 'past_due');
  const [{ n }] = await t.q(`select count(*)::int n from public.restaurants where subscription_status = 'past_due'`);
  assert.equal(n, 1);
  await t.as('anon');
  const body = JSON.stringify({ event: 'subscription.cancelled', payload: { subscription: { entity: { id: 'sub_A1' } } } });
  assert.match(err(await t.try(`select public.razorpay_webhook($1, 'bad')`, [body])), /bad signature/);
}));
