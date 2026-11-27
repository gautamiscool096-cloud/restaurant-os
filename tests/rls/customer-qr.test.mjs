// Customer (anon) QR flow: every entry point is pinned to the tenant
// identified by the slug AND the table's QR token together.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, tx, id, userId, SLUG, qrToken, sessionToken } from '../support/db.mjs';

after(() => pool.end());

const rid = (tenant) => id(tenant, 'restaurant');
const place = (t, slug, token, items, sessionTok = null) => t.try(
  `select public.place_order($1, $2, $3::jsonb, $4, $5) as r`,
  [slug, token, JSON.stringify(items), null, sessionTok]);

test('menu for a slug contains only that restaurant\'s items and branding', () => tx('anon', async (t) => {
  for (const tenant of ['a', 'b', 'c']) {
    const [{ m }] = await t.q(`select public.get_public_menu($1) m`, [SLUG[tenant]]);
    assert.equal(m.restaurant.slug, SLUG[tenant]);
    const itemIds = m.categories.flatMap((c) => c.items.map((i) => i.id));
    assert.ok(itemIds.length > 0);
    for (const itemId of itemIds) assert.ok(itemId.startsWith(`0000000${tenant}-`), `foreign item ${itemId}`);
    assert.equal(JSON.stringify(m).includes('qr_token'), false, 'menu leaks QR tokens');
  }
}));

test('unknown slug returns no menu', () => tx('anon', async (t) => {
  const [{ m }] = await t.q(`select public.get_public_menu('does-not-exist') m`);
  assert.equal(m, null);
}));

test('table 5 at restaurant A never resolves to table 5 at B (and vice versa)', () => tx('anon', async (t) => {
  const [{ own }] = await t.q(`select public.resolve_table($1, $2) own`, [SLUG.a, qrToken('a', 5)]);
  assert.equal(own.table_number, 5);
  for (const [slug, token] of [
    [SLUG.a, qrToken('b', 5)], [SLUG.b, qrToken('a', 5)], [SLUG.c, qrToken('a', 5)], [SLUG.a, '5'],
  ]) {
    const [{ r }] = await t.q(`select public.resolve_table($1, $2) r`, [slug, token]);
    assert.equal(r, null, `${slug} + ${token} resolved to a table`);
  }
}));

test('ordering with A\'s slug and B\'s QR token is rejected', () => tx('anon', async (t) => {
  const { error } = await place(t, SLUG.a, qrToken('b', 2), [{ menu_item_id: id('a', 'item', 1), quantity: 1 }]);
  assert.match(String(error?.message), /unknown table/);
}));

test('ordering another restaurant\'s menu item is rejected and nothing is written', () => tx('anon', async (t) => {
  const { error } = await place(t, SLUG.a, qrToken('a', 2), [
    { menu_item_id: id('a', 'item', 1), quantity: 1 },
    { menu_item_id: id('b', 'item', 1), quantity: 1 },
  ]);
  assert.match(String(error?.message), /not available/);
  await t.as('service');
  const [{ n }] = await t.q(`select count(*)::int n from public.orders where table_id = $1`, [id('a', 'table', 2)]);
  assert.equal(n, 0);
}));

test('unavailable items cannot be ordered', () => tx('anon', async (t) => {
  const { error } = await place(t, SLUG.a, qrToken('a', 2), [{ menu_item_id: id('a', 'item', 5), quantity: 1 }]);
  assert.match(String(error?.message), /not available/);
}));

test('a valid order lands only in its own tenant, priced by the server', () => tx('anon', async (t) => {
  const { rows, error } = await place(t, SLUG.a, qrToken('a', 2), [
    { menu_item_id: id('a', 'item', 1), quantity: 2, special_instructions: 'no onion', price_minor: 1 },
    { menu_item_id: id('a', 'item', 6), quantity: 1 },
  ]);
  assert.equal(error, null);
  const r = rows[0].r;
  // A: tax 5%, service 10%. subtotal = 2*24000 + 9000 = 57000
  assert.equal(r.subtotal_minor, 57000);
  assert.equal(r.service_charge_minor, 5700);
  assert.equal(r.tax_minor, Math.round((57000 + 5700) * 0.05));
  assert.equal(r.total_minor, 57000 + 5700 + 3135);
  assert.equal(r.status, 'pending');
  assert.ok(r.session_token?.length >= 32);

  await t.as(userId('a', 'manager'));
  const mine = await t.q(`select restaurant_id from public.orders where id = $1`, [r.order_id]);
  assert.deepEqual(mine, [{ restaurant_id: rid('a') }]);
  const [line] = await t.q(`select special_instructions from public.order_items where order_id = $1 and quantity = 2`, [r.order_id]);
  assert.equal(line.special_instructions, 'no onion');

  for (const other of ['b', 'c']) {
    await t.as(userId(other, 'owner'));
    const theirs = await t.q(`select 1 from public.orders where id = $1`, [r.order_id]);
    assert.equal(theirs.length, 0, `owner@${other} can see A's new order`);
  }
}));

test('order numbers are sequential per restaurant', () => tx('anon', async (t) => {
  const a1 = (await place(t, SLUG.a, qrToken('a', 3), [{ menu_item_id: id('a', 'item', 1), quantity: 1 }])).rows[0].r;
  const b1 = (await place(t, SLUG.b, qrToken('b', 3), [{ menu_item_id: id('b', 'item', 1), quantity: 1 }])).rows[0].r;
  assert.equal(a1.order_number, 4); // 3 seeded per tenant
  assert.equal(b1.order_number, 4);
}));

test('add-on orders need this table\'s session token; another table\'s or tenant\'s token is refused', () => tx('anon', async (t) => {
  const item = [{ menu_item_id: id('a', 'item', 3), quantity: 1 }];
  // table 5 at A has an open seeded session
  assert.match(String((await place(t, SLUG.a, qrToken('a', 5), item)).error?.message), /open order/);
  assert.match(String((await place(t, SLUG.a, qrToken('a', 5), item, sessionToken('b', 5))).error?.message), /open order/);
  assert.match(String((await place(t, SLUG.a, qrToken('a', 5), item, sessionToken('a', 1))).error?.message), /open order/);

  const ok = await place(t, SLUG.a, qrToken('a', 5), item, sessionToken('a', 5));
  assert.equal(ok.error, null);
  await t.as('service');
  const [o] = await t.q(`select session_id from public.orders where id = $1`, [ok.rows[0].r.order_id]);
  assert.equal(o.session_id, id('a', 'session', 5));
}));

test('session status lookup returns only that session\'s orders', () => tx('anon', async (t) => {
  const [{ a }] = await t.q(`select public.get_session_orders($1) a`, [sessionToken('a', 5)]);
  assert.deepEqual(a.map((o) => o.order_id).sort(), [id('a', 'order', 2), id('a', 'order', 3)]);
  const [{ b }] = await t.q(`select public.get_session_orders($1) b`, [sessionToken('b', 5)]);
  assert.deepEqual(b.map((o) => o.order_id).sort(), [id('b', 'order', 2), id('b', 'order', 3)]);
  const [{ none }] = await t.q(`select public.get_session_orders('guess') none`);
  assert.deepEqual(none, []);
}));

test('reviews only after food is served, and only for the token\'s own session', () => tx('anon', async (t) => {
  const early = await t.try(`select public.submit_review($1, 5, 'great')`, [sessionToken('a', 5)]);
  assert.match(String(early.error?.message), /after your food is served/);
  const bogus = await t.try(`select public.submit_review('nope', 5, 'x')`);
  assert.match(String(bogus.error?.message), /unknown session/);

  await t.as('service');
  await t.q(`update public.orders set status = 'served' where id = $1`, [id('b', 'order', 2)]);
  await t.as('anon');
  const ok = await t.try(`select public.submit_review($1, 4, 'nice') id`, [sessionToken('b', 5)]);
  assert.equal(ok.error, null);
  await t.as(userId('a', 'owner'));
  const leak = await t.q(`select 1 from public.reviews where id = $1`, [ok.rows[0].id]);
  assert.equal(leak.length, 0);
}));

test('a suspended restaurant\'s QR menu and ordering go dark; others keep working', () => tx('service', async (t) => {
  await t.q(`update public.restaurants set suspended_at = now() where id = $1`, [rid('a')]);
  await t.as('anon');
  assert.equal((await t.q(`select public.get_public_menu($1) m`, [SLUG.a]))[0].m, null);
  assert.equal((await t.q(`select public.resolve_table($1, $2) r`, [SLUG.a, qrToken('a', 2)]))[0].r, null);
  const blocked = await place(t, SLUG.a, qrToken('a', 2), [{ menu_item_id: id('a', 'item', 1), quantity: 1 }]);
  assert.match(String(blocked.error?.message), /unknown table/);
  assert.notEqual((await t.q(`select public.get_public_menu($1) m`, [SLUG.b]))[0].m, null);
}));
