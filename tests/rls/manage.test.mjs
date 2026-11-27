// Phase 8: owners and managers run their own restaurant (menu, settings,
// tables, team and invites) and nobody can touch another restaurant's.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, tx, id, userId, NO_TENANT_USER } from '../support/db.mjs';

after(() => pool.end());

const err = (r) => String(r.error?.message ?? '');

test('manager adds a category and a dish; guests see it on the menu', () => tx(userId('a', 'manager'), async (t) => {
  const [cat] = await t.q(`select * from public.save_menu_category(null, 'Desserts')`);
  assert.equal(cat.restaurant_id, id('a', 'restaurant'));
  const [dish] = await t.q(`select * from public.save_menu_item($1)`, [{
    category_id: cat.id, name: 'Gulab Jamun', description: 'Two pieces', price_minor: 9900, is_veg: true, spice_level: 0,
  }]);
  assert.equal(dish.price_minor, 9900);
  const [{ m }] = await t.q(`select public.staff_menu_editor() m`);
  assert.ok(m.some((c) => c.name === 'Desserts' && c.items.some((i) => i.name === 'Gulab Jamun')));
  await t.as('anon');
  const [{ menu }] = await t.q(`select public.get_public_menu('spice-route') menu`);
  assert.ok(JSON.stringify(menu).includes('Gulab Jamun'));
  await t.as(userId('b', 'owner'));
  const [{ m: other }] = await t.q(`select public.staff_menu_editor() m`);
  assert.ok(!JSON.stringify(other).includes('Gulab Jamun'), 'Bombay Bistro does not see it');
}));

test('dish validation gives plain messages', () => tx(userId('a', 'owner'), async (t) => {
  const cat = id('a', 'category', 1);
  assert.match(err(await t.try(`select public.save_menu_item($1)`, [{ category_id: cat, name: ' ', price_minor: 100 }])), /give the dish a name/);
  assert.match(err(await t.try(`select public.save_menu_item($1)`, [{ category_id: cat, name: 'X' }])), /enter a price/);
  assert.match(err(await t.try(`select public.save_menu_item($1)`, [{ category_id: cat, name: 'X', price_minor: 1, photo_url: 'http://x' }])), /https/);
  assert.match(err(await t.try(`select public.save_menu_item($1)`, [{ category_id: id('b', 'category', 1), name: 'X', price_minor: 1 }])), /pick one of your categories/);
  assert.match(err(await t.try(`select public.save_menu_category(null, 'Mains')`)), /already a category/);
}));

test('a restaurant cannot edit another restaurant\'s menu', () => tx(userId('b', 'owner'), async (t) => {
  const r = await t.try(`select public.save_menu_item($1)`, [{ id: id('a', 'item', 1), name: 'Hacked', price_minor: 1 }]);
  assert.match(err(r), /dish not found/);
  assert.match(err(await t.try(`select public.set_menu_item_available($1, false)`, [id('a', 'item', 1)])), /dish not found/);
  assert.match(err(await t.try(`select public.delete_menu_item($1)`, [id('a', 'item', 1)])), /dish not found/);
  await t.as('service');
  const [row] = await t.q(`select name, is_available from public.menu_items where id = $1`, [id('a', 'item', 1)]);
  assert.notEqual(row.name, 'Hacked');
  assert.equal(row.is_available, true);
}));

test('the kitchen can mark a dish sold out; waiters cannot edit the menu', () => tx(userId('a', 'chef'), async (t) => {
  await t.q(`select public.set_menu_item_available($1, false)`, [id('a', 'item', 1)]);
  assert.match(err(await t.try(`select public.save_menu_category(null, 'Chef special')`)), /only owners and managers/);
  await t.as(userId('a', 'waiter'));
  assert.match(err(await t.try(`select public.set_menu_item_available($1, true)`, [id('a', 'item', 1)])), /cannot change the menu/);
  assert.match(err(await t.try(`select public.save_menu_item($1)`, [{ category_id: id('a', 'category', 1), name: 'X', price_minor: 1 }])), /only owners and managers/);
  await t.as('service');
  const [row] = await t.q(`select is_available from public.menu_items where id = $1`, [id('a', 'item', 1)]);
  assert.equal(row.is_available, false);
}));

test('dishes on past bills cannot be deleted, unused ones can', () => tx(userId('a', 'owner'), async (t) => {
  const [{ menu_item_id: used }] = await t.q(`select menu_item_id from public.order_items limit 1`);
  assert.match(err(await t.try(`select public.delete_menu_item($1)`, [used])), /mark it sold out/i);
  const [dish] = await t.q(`select * from public.save_menu_item($1)`, [{ category_id: id('a', 'category', 1), name: 'Temp', price_minor: 100 }]);
  await t.q(`select public.delete_menu_item($1)`, [dish.id]);
}));

test('owner updates profile and bill settings; staff and other tenants cannot', () => tx(userId('a', 'owner'), async (t) => {
  const [{ p }] = await t.q(`select public.update_restaurant_profile($1) p`, [{
    name: 'Spice Route Indiranagar', brand_primary_color: '#123456', tax_percent: 12, receipt_footer: 'See you soon',
  }]);
  assert.equal(p.name, 'Spice Route Indiranagar');
  assert.equal(Number(p.tax_percent), 12);
  assert.equal(p.slug, 'spice-route');
  assert.match(err(await t.try(`select public.update_restaurant_profile($1)`, [{ brand_primary_color: 'red' }])), /colours/);
  assert.match(err(await t.try(`select public.update_restaurant_profile($1)`, [{ accepts_cash: false, accepts_online: false }])), /one way to pay/);
  assert.match(err(await t.try(`select public.update_restaurant_profile($1)`, [{ slug: 'stolen' }])), /^$/, 'unknown keys are ignored');
  await t.as(userId('a', 'cashier'));
  assert.match(err(await t.try(`select public.update_restaurant_profile($1)`, [{ name: 'x' }])), /only owners and managers/);
  await t.as(userId('b', 'owner'));
  const [{ p: b }] = await t.q(`select public.restaurant_profile() p`);
  assert.equal(b.slug, 'bombay-bistro');
}));

test('tables: add more, rename, retire; never another restaurant\'s', () => tx(userId('a', 'manager'), async (t) => {
  const [{ n: before }] = await t.q(`select count(*)::int n from public.dining_tables`);
  const [{ last }] = await t.q(`select public.add_dining_tables(3) last`);
  const [{ n: after }] = await t.q(`select count(*)::int n from public.dining_tables`);
  assert.equal(after, before + 3);
  assert.equal(last, before + 3);
  const tid = id('a', 'table', 1);
  await t.q(`select public.update_dining_table($1, 'Window', 2, true)`, [tid]);
  const [tb] = await t.q(`select label, seats from public.dining_tables where id = $1`, [tid]);
  assert.deepEqual(tb, { label: 'Window', seats: 2 });
  assert.match(err(await t.try(`select public.update_dining_table($1, 'x', 2, false)`, [id('b', 'table', 1)])), /table not found/);
  await t.as(userId('a', 'waiter'));
  assert.match(err(await t.try(`select public.add_dining_tables(1)`)), /only owners and managers/);
}));

test('invite code: new user joins the right restaurant with the right role, once', () => tx(userId('a', 'manager'), async (t) => {
  assert.match(err(await t.try(`select public.create_staff_invite('manager', 'Raj')`)), /managers can only invite/);
  const [{ inv }] = await t.q(`select public.create_staff_invite('waiter', 'Asha') inv`);
  assert.match(inv.code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  await t.as('service');
  const [stored] = await t.q(`select code_hash from public.staff_invites where id = $1`, [inv.id]);
  assert.notEqual(stored.code_hash, inv.code, 'only the hash is stored');
  await t.as(userId('b', 'owner'));
  const [{ team: bTeam }] = await t.q(`select public.staff_team() team`);
  assert.ok(!bTeam.invites.some((i) => i.id === inv.id), 'other restaurant cannot see the invite');
  assert.match(err(await t.try(`select public.revoke_staff_invite($1)`, [inv.id])), /invite not found/);
  assert.match(err(await t.try(`select public.accept_staff_invite($1)`, [inv.code])), /already belongs/);

  await t.as(NO_TENANT_USER);
  assert.match(err(await t.try(`select public.accept_staff_invite('ZZZZ-ZZZZ')`)), /not valid/);
  const [{ j }] = await t.q(`select public.accept_staff_invite($1) j`, [inv.code.toLowerCase()]);
  assert.equal(j.restaurant_id, id('a', 'restaurant'));
  assert.equal(j.role, 'waiter');
  const [{ rid, role }] = await t.q(`select app.current_restaurant_id() rid, app.current_role()::text role`);
  assert.equal(rid, id('a', 'restaurant'));
  assert.equal(role, 'waiter');
  await t.as('anon');
  assert.ok((await t.try(`select public.accept_staff_invite($1)`, [inv.code])).error);
  await t.as(userId('c', 'owner'));
  assert.ok((await t.try(`select public.accept_staff_invite($1)`, [inv.code])).error, 'code cannot be reused');
}));

test('team: owner changes roles and deactivates; limits hold', () => tx(userId('a', 'owner'), async (t) => {
  const [{ team }] = await t.q(`select public.staff_team() team`);
  assert.equal(team.staff.length, 5);
  assert.ok(team.staff.every((s) => !('email' in s)));
  const waiter = team.staff.find((s) => s.role === 'waiter');
  await t.q(`select public.update_staff_member($1, 'cashier', false)`, [waiter.id]);
  const me = team.staff.find((s) => s.is_me);
  assert.ok((await t.try(`select public.update_staff_member($1, null, false)`, [me.id])).error, 'owner cannot be deactivated');
  await t.as(userId('a', 'manager'));
  const mgrOwner = team.staff.find((s) => s.role === 'owner');
  assert.ok((await t.try(`select public.update_staff_member($1, null, false)`, [mgrOwner.id])).error, 'manager cannot touch the owner');
  await t.as(userId('b', 'owner'));
  assert.match(err(await t.try(`select public.update_staff_member($1, 'chef', true)`, [waiter.id])), /not found/);
  await t.as(userId('a', 'chef'));
  assert.match(err(await t.try(`select public.staff_team()`)), /only owners and managers/);
}));

test('a guest cannot call any management function', () => tx('anon', async (t) => {
  for (const sql of [
    `select public.staff_menu_editor()`, `select public.restaurant_profile()`, `select public.add_dining_tables(1)`,
    `select public.create_staff_invite('waiter', 'x')`, `select public.staff_team()`,
  ]) {
    assert.ok((await t.try(sql)).error, sql);
  }
}));
