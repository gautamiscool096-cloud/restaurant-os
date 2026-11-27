// Phase 2: onboarding helpers and the logo/photo storage bucket.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, tx, id, userId, NO_TENANT_USER } from '../support/db.mjs';

after(() => pool.end());

const rid = (tenant) => id(tenant, 'restaurant');

describe('slug rules', () => {
  test('availability: taken, reserved and malformed slugs are refused', () => tx(NO_TENANT_USER, async (t) => {
    const check = async (slug) => (await t.q(`select public.is_slug_available($1) ok`, [slug]))[0].ok;
    assert.equal(await check('dosa-den'), true);
    assert.equal(await check('spice-route'), false, 'taken');
    assert.equal(await check('Spice-Route'), false, 'taken, case-insensitive');
    assert.equal(await check('admin'), false, 'reserved');
    assert.equal(await check('dashboard'), false, 'reserved');
    assert.equal(await check('-bad'), false);
    assert.equal(await check('a'), false, 'too short');
    assert.equal(await check('has space'), false);
  }));

  test('create_restaurant refuses reserved slugs and applies brand colours', () => tx(NO_TENANT_USER, async (t) => {
    const bad = await t.try(`select public.create_restaurant('X', 'admin', 'x')`);
    assert.match(String(bad.error?.message), /not allowed/);
    const [r] = await t.q(`
      select (x).brand_primary_color c1, (x).brand_accent_color c2, (x).slug
        from (select public.create_restaurant('Dosa Den', ' Dosa-Den ', 'Asha', null, null, null, 4, '#123456', '#abcdef') x) s`);
    assert.deepEqual(r, { c1: '#123456', c2: '#abcdef', slug: 'dosa-den' });
  }));

  test('anon cannot probe slugs or call my_context', () => tx('anon', async (t) => {
    for (const sql of [`select public.is_slug_available('x-y')`, `select public.my_context()`]) {
      assert.match(String((await t.try(sql)).error?.message), /permission denied/, sql);
    }
  }));
});

describe('my_context', () => {
  test('returns the caller\'s own restaurant and role only', () => tx(userId('b', 'chef'), async (t) => {
    const [{ c }] = await t.q(`select public.my_context() c`);
    assert.equal(c.role, 'chef');
    assert.equal(c.restaurant.id, rid('b'));
    assert.equal(c.operational, true);
  }));

  test('is null for a signed-in user with no restaurant (-> onboarding)', () => tx(NO_TENANT_USER, async (t) => {
    const [{ c }] = await t.q(`select public.my_context() c`);
    assert.equal(c, null);
  }));

  test('reports non-operational tenants so the app can show the billing screen', () => tx('service', async (t) => {
    await t.q(`update public.restaurants set suspended_at = now() where id = $1`, [rid('a')]);
    await t.as(userId('a', 'owner'));
    const [{ c }] = await t.q(`select public.my_context() c`);
    assert.equal(c.operational, false);
    assert.equal(c.restaurant.suspended, true);
  }));
});

describe('restaurant-assets storage bucket', () => {
  const put = (t, path) => t.try(
    `insert into storage.objects (bucket_id, name) values ('restaurant-assets', $1)`, [path]);

  test('owners and managers upload only into their own restaurant folder', () => tx(userId('a', 'owner'), async (t) => {
    assert.equal((await put(t, `${rid('a')}/logo.png`)).error, null);
    for (const path of [`${rid('b')}/logo.png`, `logo.png`, `${rid('b')}/x/${rid('a')}/logo.png`]) {
      assert.ok((await put(t, path)).error, `owner@a wrote ${path}`);
    }
    await t.as(userId('b', 'manager'));
    assert.equal((await put(t, `${rid('b')}/menu/1.jpg`)).error, null);
    assert.ok((await put(t, `${rid('a')}/menu/1.jpg`)).error);
  }));

  test('waiters, chefs and anon cannot upload', () => tx(userId('a', 'waiter'), async (t) => {
    assert.ok((await put(t, `${rid('a')}/logo.png`)).error);
    await t.as(userId('a', 'chef'));
    assert.ok((await put(t, `${rid('a')}/logo.png`)).error);
    await t.as('anon');
    assert.ok((await put(t, `${rid('a')}/logo.png`)).error);
  }));

  test('cannot overwrite or delete another restaurant\'s files', () => tx('service', async (t) => {
    await t.q(`insert into storage.objects (bucket_id, name) values ('restaurant-assets', $1)`, [`${rid('b')}/logo.png`]);
    await t.as(userId('a', 'owner'));
    const upd = await t.try(`update storage.objects set name = $1 where name = $2`,
      [`${rid('a')}/stolen.png`, `${rid('b')}/logo.png`]);
    assert.equal(upd.rowCount, 0);
    const del = await t.try(`delete from storage.objects where name = $1`, [`${rid('b')}/logo.png`]);
    assert.equal(del.rowCount, 0);
    const [{ n }] = await t.q(`select count(*)::int n from storage.objects where name like $1`, [`${rid('b')}/%`]);
    assert.equal(n, 0, 'owner@a can list B\'s files');
  }));
});
