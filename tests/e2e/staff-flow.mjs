// End-to-end: owner signup + onboarding, manager approval flow, floor view,
// and cross-tenant isolation in the staff UI. Runs against mock-supabase.mjs
// (real Postgres, real RLS). See tests/e2e/README.md.
import { createRequire } from 'node:module';
import os from 'node:os';
import pg from 'pg';

// Playwright is not a project dependency; use the copy installed on the machine.
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const BASE = process.env.APP_URL ?? 'http://localhost:3102';
const API = process.env.MOCK_URL ?? 'http://localhost:54321';
const OUT = process.env.SCREENSHOT_DIR ?? os.tmpdir();
const PASSWORD = 'demo-password-123';
const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
const ok = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('ok -', m); };

async function login(browser, email, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { throw e; });
  await p.goto(`${BASE}/login`);
  await p.fill('#email', email);
  await p.fill('#password', PASSWORD);
  await p.click('button[type=submit]');
  await p.waitForURL(/\/dashboard/);
  return p;
}

const guestOrder = (table, itemId) => fetch(`${API}/rest/v1/rpc/place_order`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ p_slug: 'spice-route', p_qr_token: `spice-route-table-${table}-qr`, p_items: [{ menu_item_id: itemId, quantity: 2 }] }),
}).then((r) => r.json());

(async () => {
  await db.connect();
  const b = await chromium.launch();
  const A_ITEM = (n) => `0000000a-0000-4000-8004-00000000000${n}`;

  // ---------------- manager approval flow ----------------
  const m = await login(b, 'manager@spice-route.demo');
  ok(await m.locator('header >> text=Spice Route').count() > 0, 'manager lands on Spice Route dashboard');
  await m.click('nav >> text=Orders');
  await m.waitForSelector('text=#3');
  ok((await m.title()).startsWith('(1)'), 'browser tab shows 1 new order');
  ok(await m.locator('section[aria-label="Table 5"]').count() === 1, 'pending order grouped under Table 5');

  // a guest orders while the manager watches
  const placed = await guestOrder(3, A_ITEM(3));
  ok(placed.order_number === 4, 'guest placed order #4 at table 3');
  await m.waitForSelector('section[aria-label="Table 3"]', { timeout: 15000 });
  ok(true, 'new order appears on the board without reloading');
  await m.screenshot({ path: `${OUT}/p4-orders-desktop.png`, fullPage: true });

  // edit #3: one more chaas + add paneer tikka
  const card3 = m.locator('article', { hasText: '#3' });
  await card3.locator('button:has-text("Edit")').click();
  await card3.locator('button[aria-label^="One more"]').first().click();
  await card3.locator('select[aria-label="Add a dish"]').selectOption(A_ITEM(1));
  await card3.locator('button:has-text("Add")').click();
  await card3.locator('button:has-text("Save changes")').click();
  await m.waitForSelector('article:has-text("#3") >> text=2 ×');
  const { rows: [o3] } = await db.query(`select subtotal_minor, total_minor from public.orders where id = '0000000a-0000-4000-8006-000000000003'`);
  ok(o3.subtotal_minor === 2 * 9000 + 24000, `edited order subtotal recalculated (${o3.subtotal_minor})`);

  // approve #3
  await m.locator('article', { hasText: '#3' }).locator('button:has-text("Approve")').click();
  await m.waitForFunction(() => !document.querySelector('section[aria-label="Table 5"]'));
  const { rows: [a3] } = await db.query(`select status, approved_by from public.orders where id = '0000000a-0000-4000-8006-000000000003'`);
  ok(a3.status === 'approved' && a3.approved_by === '0000000a-0000-4000-8001-000000000002', 'approved and recorded by the manager');

  // reject #4 with a reason
  const card4 = m.locator('article', { hasText: '#4' });
  await card4.locator('button:has-text("Reject")').click();
  await card4.locator('input').fill('Dal is finished for today');
  await card4.locator('button:has-text("Reject order")').click();
  await m.waitForSelector('text=No new orders right now');
  const { rows: [r4] } = await db.query(`select status, rejected_reason from public.orders where id = $1`, [placed.order_id]);
  ok(r4.status === 'rejected' && r4.rejected_reason === 'Dal is finished for today', 'rejected with reason');

  await m.click('role=tab[name=/In progress/]');
  await m.waitForSelector('text=#3');
  ok(true, 'approved order shows under In progress');

  await m.click('role=tab[name=/Free tables/]');
  await m.waitForSelector('section[aria-label="Free tables"]');
  ok(await m.locator('section[aria-label="Free tables"] li').count() === 6, 'Free tables lists the 6 tables without guests');
  ok(await m.locator('section[aria-label="Free tables"] >> text=Table 3').count() === 0, 'a table with guests is not listed as free');
  await m.screenshot({ path: `${OUT}/p5b-free-tables.png`, fullPage: true });

  // ---------------- floor ----------------
  await m.click('nav >> text=Floor');
  await m.waitForSelector('text=tables occupied');
  ok(await m.locator('text=2 of 8 tables occupied').count() === 1, 'floor counts occupied tables');
  await m.screenshot({ path: `${OUT}/p4-floor-desktop.png`, fullPage: true });
  await m.click('button[aria-label^="Table 3:"]');
  await m.click('text=Guests left: free this table');
  await m.click('text=Yes, free the table');
  await m.waitForSelector('button[aria-label="Table 3: Free"]');
  const { rows: [s3] } = await db.query(`select count(*)::int n from public.table_sessions where table_id = '0000000a-0000-4000-8002-000000000003' and status = 'open'`);
  ok(s3.n === 0, 'table 3 session closed in the database');
  const again = await guestOrder(3, A_ITEM(1));
  ok(again.order_number === 5, 'next guests at table 3 can order again');

  // ---------------- isolation in the UI ----------------
  const bOwner = await login(b, 'owner@bombay-bistro.demo');
  await bOwner.goto(`${BASE}/dashboard/orders`);
  await bOwner.waitForSelector('text=#3');
  const html = await bOwner.content();
  ok(!html.includes('Spice Route') && html.includes('Bombay Bistro'), 'Bombay Bistro owner sees only Bombay Bistro');
  await bOwner.click('nav >> text=Floor');
  await bOwner.waitForSelector('text=tables occupied');
  ok(await bOwner.locator('text=1 of 8 tables occupied').count() === 1, 'Bombay floor unaffected by Spice Route activity');

  const chef = await login(b, 'chef@spice-route.demo');
  ok(await chef.locator('nav >> text=Orders').count() === 0, 'chef has no Orders link');
  await chef.goto(`${BASE}/dashboard/orders`);
  await chef.waitForURL(`${BASE}/dashboard`);
  ok(true, 'chef is sent back from the manager screen');

  // phone-sized manager view
  const phone = await login(b, 'manager@spice-route.demo', devices['iPhone 13'].viewport);
  await phone.goto(`${BASE}/dashboard/floor`);
  await phone.waitForSelector('text=tables occupied');
  ok(!(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'floor view fits a phone');
  await phone.screenshot({ path: `${OUT}/p4-floor-phone.png`, fullPage: true });

  // ---------------- signup + onboarding ----------------
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const n = await ctx.newPage();
  await n.goto(`${BASE}/signup`);
  await n.fill('#email', 'asha@dosaden.test');
  await n.fill('#password', 'a-strong-password');
  await n.click('button[type=submit]');
  await n.waitForURL(/\/onboarding/);
  await n.fill('#name', 'Dosa Den');
  await n.waitForSelector('text=✓ Available');
  await n.fill('#owner_name', 'Asha');
  await n.fill('#tables', '6');
  await n.locator('button:has-text("Create my restaurant")').first().click();
  await n.waitForURL(/\/dashboard\?welcome=1/);
  ok(await n.locator('text=Dosa Den is set up').count() === 1, 'new owner onboarded and welcomed');
  await n.goto(`${BASE}/dashboard/tables`);
  ok(await n.locator('figure').count() === 6, 'six QR codes generated');
  const link = await n.locator('figure a').first().getAttribute('href');
  ok(link.includes('/r/dosa-den/menu?t='), 'QR link carries slug and table token');
  await n.goto(link);
  await n.waitForSelector('text=Table 1');
  ok(await n.locator('text=The menu is being prepared').count() === 1, 'new restaurant menu opens (empty)');
  await n.goto(`${BASE}/dashboard/orders`);
  await n.waitForSelector('text=No new orders right now');
  ok(!(await n.content()).includes('Spice Route'), 'new owner sees none of the demo restaurants');

  await b.close();
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
