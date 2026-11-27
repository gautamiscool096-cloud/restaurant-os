// End-to-end: bills, part cash payment, guest online payment (test mode),
// receipts, webhook signature check, role limits and isolation. Runs against
// mock-supabase.mjs on a freshly seeded database. See tests/e2e/README.md.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import os from 'node:os';
import pg from 'pg';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const BASE = process.env.APP_URL ?? 'http://localhost:3102';
const OUT = process.env.SCREENSHOT_DIR ?? os.tmpdir();
const PASSWORD = 'demo-password-123';
const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
const ok = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('ok -', m); };
const SESSION5 = '0000000a-0000-4000-8005-000000000005';
const QR5 = 'spice-route-table-5-qr';

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
(async () => {
  await db.connect();
  const b = await chromium.launch();

  // ---------------- waiter takes a part payment ----------------
  const w = await login(b, 'waiter@spice-route.demo');
  ok(await w.locator('nav >> text=Bills').count() === 1, 'waiter has a Bills link');
  await w.click('nav >> text=Bills');
  const row = w.locator('section[aria-label="To collect"] >> a', { hasText: 'Table 5' });
  await row.waitFor();
  ok((await row.innerText()).includes('₹392.70 due'), 'Table 5 owes ₹392.70 (approved order only, with service and tax)');
  await row.click();
  await w.waitForSelector('article[aria-label="Receipt"]');
  ok(await w.locator('article[aria-label="Receipt"] >> text=Spice Route Butter Chicken').count() === 1, 'bill lists the approved dish');
  ok(await w.locator('article[aria-label="Receipt"] >> text=Masala Chaas').count() === 0, 'unapproved order is not billed');
  await w.fill('#part', '100');
  await w.click('button:has-text("Record")');
  await w.waitForSelector('text=Recorded ₹100.');
  ok((await w.locator('[data-testid="due"]').innerText()) === '₹292.70', 'part payment leaves ₹292.70 due');
  const { rows: [cash] } = await db.query(`select method, status, collected_by from public.payments where session_id = $1`, [SESSION5]);
  ok(cash.method === 'cash' && cash.status === 'captured' && cash.collected_by === '0000000a-0000-4000-8001-000000000003', 'cash payment stored with the waiter who took it');

  // manager approves the chaas so it joins the bill
  const m = await login(b, 'manager@spice-route.demo');
  await m.click('nav >> text=Orders');
  await m.locator('article', { hasText: '#3' }).locator('button:has-text("Approve")').click();
  await m.waitForSelector('text=No new orders right now');

  // ---------------- guest pays the rest online (test mode) ----------------
  const gctx = await b.newContext({ ...devices['iPhone 13'] });
  await gctx.addInitScript(([key, token]) => localStorage.setItem(key, JSON.stringify(token)),
    [`ros:session:spice-route:${QR5}`, 'demo-session-spice-route-5']);
  const g = await gctx.newPage();
  g.on('pageerror', (e) => { throw e; });
  await g.goto(`${BASE}/r/spice-route/order?t=${QR5}`);
  const guestDue = g.locator('[data-testid="guest-due"]');
  await guestDue.waitFor();
  const due = await guestDue.innerText();
  ok(due === '₹396.65', `guest sees what is left after the cash part payment (${due})`);
  await g.click('button:has-text("online")');
  await g.waitForSelector('text=No real money will be taken');
  ok(true, 'test mode is clearly labelled');
  await g.screenshot({ path: `${OUT}/p6-guest-pay.png`, fullPage: true });
  await g.click('button:has-text("Complete test payment")');
  await g.waitForSelector('text=Paid. Thank you!');
  ok(true, 'guest sees the bill as paid');
  const { rows: [{ n_online }] } = await db.query(
    `select count(*)::int n_online from public.payments where session_id = $1 and method = 'online' and status = 'captured' and gateway = 'test'`, [SESSION5]);
  ok(n_online === 1, 'online test payment recorded');
  const { rows: orders } = await db.query(`select is_paid from public.orders where session_id = $1 and status = 'approved'`, [SESSION5]);
  ok(orders.length === 2 && orders.every((o) => o.is_paid), 'both approved orders are marked paid');

  await g.click('text=View receipt');
  await g.waitForSelector('article[aria-label="Receipt"]');
  ok(await g.locator('text=Paid online (test, no real money)').count() === 1, 'receipt shows the online test payment');
  ok(await g.locator('text=Paid at the table').count() === 1, 'receipt shows the cash part payment');
  ok(await g.locator('text=PAID — thank you!').count() === 1, 'receipt is marked paid');
  ok(!(await g.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'receipt fits a phone');
  await g.screenshot({ path: `${OUT}/p6-guest-receipt.png`, fullPage: true });

  // staff screen catches up on its own
  await w.waitForSelector('text=Fully paid.', { timeout: 15000 });
  ok(true, 'waiter bill screen shows fully paid without reloading');
  ok(await w.locator('text=Guests left: free this table').count() === 0, 'waiters cannot free the table');
  await w.screenshot({ path: `${OUT}/p6-bill-desk.png`, fullPage: true });
  await m.goto(`${BASE}/dashboard/bills/${SESSION5}`);
  await m.click('text=Guests left: free this table');
  await m.waitForURL(`${BASE}/dashboard/bills`);
  const { rows: [s] } = await db.query(`select status from public.table_sessions where id = $1`, [SESSION5]);
  ok(s.status === 'closed', 'manager frees the paid table from the bill screen');

  // ---------------- webhook endpoint ----------------
  const body = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { order_id: 'order_NOPE000', id: 'pay_x', amount: 1 } } } });
  let res = await fetch(`${BASE}/api/razorpay/webhook`, { method: 'POST', body, headers: { 'x-razorpay-signature': 'bad' } });
  ok(res.status === 401, 'webhook refused while no secret is configured');
  await db.query(`update app.platform_config set razorpay_webhook_secret = 'whsec_e2e'`);
  res = await fetch(`${BASE}/api/razorpay/webhook`, { method: 'POST', body, headers: { 'x-razorpay-signature': 'bad' } });
  ok(res.status === 401, 'webhook with a wrong signature is refused');
  const sig = crypto.createHmac('sha256', 'whsec_e2e').update(body).digest('hex');
  res = await fetch(`${BASE}/api/razorpay/webhook`, { method: 'POST', body, headers: { 'x-razorpay-signature': sig } });
  ok(res.status === 200, 'correctly signed webhook is accepted');

  // ---------------- roles and isolation ----------------
  const chef = await login(b, 'chef@spice-route.demo');
  ok(await chef.locator('nav >> text=Bills').count() === 0, 'chef has no Bills link');
  await chef.goto(`${BASE}/dashboard/bills`);
  await chef.waitForURL(`${BASE}/dashboard`);
  ok(true, 'chef is sent back from bills');

  const bc = await login(b, 'cashier@bombay-bistro.demo');
  await bc.goto(`${BASE}/dashboard/bills/${SESSION5}`);
  await bc.waitForSelector('text=This bill could not be found.');
  ok(true, 'Bombay Bistro cashier cannot open a Spice Route bill');
  await bc.goto(`${BASE}/dashboard/bills`);
  await bc.locator('section[aria-label="To collect"] >> a').first().waitFor();
  ok(!(await bc.content()).includes('Spice Route'), 'Bombay Bistro bills list shows only Bombay Bistro');

  await b.close();
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
