// End-to-end: approval -> kitchen display -> waiter service, with timers,
// role limits, offline banner and cross-tenant isolation. Runs against
// mock-supabase.mjs on a freshly seeded database. See tests/e2e/README.md.
import { createRequire } from 'node:module';
import os from 'node:os';
import pg from 'pg';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const BASE = process.env.APP_URL ?? 'http://localhost:3102';
const OUT = process.env.SCREENSHOT_DIR ?? os.tmpdir();
const PASSWORD = 'demo-password-123';
const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
const ok = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('ok -', m); };
const ORDER2 = '0000000a-0000-4000-8006-000000000002'; // approved 6 min ago (seed)
const ORDER3 = '0000000a-0000-4000-8006-000000000003'; // pending

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
const stage = async (id) => (await db.query(
  `select status, approved_at, preparing_at, ready_at, served_at from public.orders where id = $1`, [id])).rows[0];

(async () => {
  await db.connect();
  const b = await chromium.launch();

  // ---------------- manager approves, timer starts ----------------
  const m = await login(b, 'manager@spice-route.demo');
  await m.click('nav >> text=Orders');
  await m.locator('article', { hasText: '#3' }).locator('button:has-text("Approve")').click();
  await m.click('role=tab[name=/In progress/]');
  const card3 = m.locator('article', { hasText: '#3' });
  await card3.locator('[data-timer="since-approval"]').waitFor();
  ok(true, 'approved order shows a running timer since approval');
  const t1 = await card3.locator('[data-timer="since-approval"]').innerText();
  await m.waitForTimeout(2100);
  const t2 = await card3.locator('[data-timer="since-approval"]').innerText();
  ok(t1 !== t2, `timer ticks (${t1.trim()} -> ${t2.trim()})`);
  ok(await card3.locator('ol[aria-label="Order timeline"]').count() === 1, 'order shows its stage timeline');
  const card2 = m.locator('article', { hasText: '#2' });
  ok(await card2.locator('[data-timer="stage"][data-level="warn"]').count() === 1,
    'order waiting 6 min for the kitchen is flagged amber');

  // ---------------- chef works the tickets ----------------
  const chef = await login(b, 'chef@spice-route.demo');
  ok(await chef.locator('nav >> text=Kitchen').count() === 1, 'chef has a Kitchen link');
  ok(await chef.locator('nav >> text=Orders').count() === 0, 'chef still has no Orders link');
  await chef.click('nav >> text=Kitchen');
  const toCook = chef.locator('section[aria-label="To cook"]');
  await toCook.locator('article', { hasText: '#3' }).waitFor();
  ok(await toCook.locator('article').count() === 2, 'both approved orders are on the kitchen display');
  ok((await chef.title()).startsWith('(2)'), 'browser tab counts tickets to cook');
  ok(await toCook.locator('article', { hasText: '#2' }).locator('text=Less spicy please').count() === 1, 'dish notes are shown to the chef');
  await chef.screenshot({ path: `${OUT}/p5-kitchen-desktop.png`, fullPage: true });

  await toCook.locator('button[aria-label="Start cooking: order #2"]').click();
  await chef.locator('section[aria-label="Cooking"] >> article:has-text("#2")').waitFor();
  let s2 = await stage(ORDER2);
  ok(s2.status === 'preparing' && s2.preparing_at, 'start cooking is stored with its time');
  const { rows: items } = await db.query(`select status from public.order_items where order_id = $1`, [ORDER2]);
  ok(items.every((i) => i.status === 'preparing'), 'dishes follow the order into cooking');

  await chef.locator('button[aria-label="Mark ready: order #2"]').click();
  const readyCol = chef.locator('section[aria-label="Ready for pickup"]');
  await readyCol.locator('article', { hasText: '#2' }).waitFor();
  ok(await readyCol.locator('text=Waiting for a waiter to pick up').count() === 1, 'chef cannot mark served, waits for a waiter');
  s2 = await stage(ORDER2);
  ok(s2.status === 'ready' && s2.ready_at >= s2.preparing_at, 'ready is stored after cooking started');

  await chef.goto(`${BASE}/dashboard/service`);
  await chef.waitForURL(`${BASE}/dashboard`);
  ok(true, 'chef is sent back from the waiter screen');

  // ---------------- waiter serves on a phone ----------------
  const w = await login(b, 'waiter@spice-route.demo', devices['iPhone 13'].viewport);
  ok(await w.locator('nav >> text=Kitchen').count() === 0, 'waiter has no Kitchen link');
  await w.goto(`${BASE}/dashboard/service`);
  const readySec = w.locator('section[aria-label="Ready to serve"]');
  await readySec.locator('article', { hasText: '#2' }).waitFor();
  ok((await w.title()).startsWith('(1)'), 'browser tab counts orders ready to serve');
  ok(await w.locator('section[aria-label="In the kitchen"] >> text=#3').count() === 1, 'waiter sees what is still in the kitchen');
  ok(!(await w.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'service view fits a phone');
  await w.screenshot({ path: `${OUT}/p5-service-phone.png`, fullPage: true });
  await w.locator('button[aria-label="Mark served: order #2"]').click();
  await w.waitForSelector('text=Nothing to pick up right now.');
  s2 = await stage(ORDER2);
  ok(s2.status === 'served' && s2.served_at >= s2.ready_at, 'served is stored with its time');
  ok(s2.approved_at < s2.preparing_at, 'all four stage times are recorded in order');

  await w.goto(`${BASE}/dashboard/kitchen`);
  await w.waitForURL(`${BASE}/dashboard`);
  ok(true, 'waiter is sent back from the kitchen display');

  // ---------------- manager sees the finished timeline ----------------
  await m.click('role=tab[name=/Occupied tables/]');
  const done2 = m.locator('article', { hasText: '#2' });
  await done2.locator('[data-timer="since-approval"] >> text=Done in').waitFor({ timeout: 15000 }); // next refresh
  const frozen1 = await done2.locator('[data-timer="since-approval"]').innerText();
  await m.waitForTimeout(1500);
  ok(frozen1 === await done2.locator('[data-timer="since-approval"]').innerText(), 'timer stops once the order is served');
  const lastStep = await done2.locator('ol[aria-label="Order timeline"] > li').last().innerText();
  ok(/\d+ (s|min)\s*→\s*Served/.test(lastStep), `timeline shows how long serving took (${lastStep.replace(/\s+/g, " ")})`);
  await m.screenshot({ path: `${OUT}/p5-orders-timers.png`, fullPage: true });

  await m.click('nav >> text=Floor');
  await m.locator('button[aria-label^="Table 5:"] [data-timer="since-approval"]').waitFor();
  ok(true, 'floor tile shows the running timer');
  await m.screenshot({ path: `${OUT}/p5-floor-timers.png`, fullPage: true });

  // late order turns red on the kitchen display (backdate in the DB as the owner of the database)
  await db.query(`update public.orders set approved_at = now() - interval '40 minutes' where id = $1`, [ORDER3]);
  await chef.goto(`${BASE}/dashboard/kitchen`);
  await chef.locator('article:has-text("#3") [data-timer="since-approval"][data-level="late"]').waitFor();
  ok(true, 'an order running 40 minutes is shown red');

  // ---------------- offline kitchen ----------------
  await chef.context().setOffline(true);
  await chef.waitForSelector('text=No internet. Showing the last orders we had.');
  ok(await chef.locator('section[aria-label="To cook"] >> article:has-text("#3")').count() === 1, 'offline kitchen keeps showing its tickets');
  await chef.context().setOffline(false);
  await chef.waitForSelector('text=No internet', { state: 'detached' });
  ok(true, 'banner clears when the connection is back');

  // ---------------- isolation ----------------
  const bChef = await login(b, 'chef@bombay-bistro.demo');
  await bChef.goto(`${BASE}/dashboard/kitchen`);
  await bChef.locator('section[aria-label="To cook"] >> article').first().waitFor();
  const html = await bChef.content();
  ok(!html.includes('Spice Route') && html.includes('Bombay Bistro'), 'Bombay Bistro kitchen shows only Bombay Bistro');
  ok(await bChef.locator('section[aria-label="To cook"] >> article').count() === 1, 'Bombay kitchen has only its own ticket');

  await b.close();
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
