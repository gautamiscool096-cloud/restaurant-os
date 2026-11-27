// End-to-end: platform super-admin console (restaurants, pause/restore,
// trial, plans, payment settings, activity) and an owner choosing a plan
// after the trial ends. See tests/e2e/README.md.
import { createRequire } from 'node:module';
import os from 'node:os';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.APP_URL ?? 'http://localhost:3102';
const OUT = process.env.SCREENSHOT_DIR ?? os.tmpdir();
const PASSWORD = 'demo-password-123';
const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
const ok = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('ok -', m); };
const SPICE = '0000000a-0000-4000-8000-000000000000';
const GREEN = '0000000c-0000-4000-8000-000000000000';

async function login(browser, email, landing = /\/dashboard/) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { throw e; });
  await p.goto(`${BASE}/login`);
  await p.fill('#email', email);
  await p.fill('#password', PASSWORD);
  await p.click('button[type=submit]');
  await p.waitForURL(landing);
  return p;
}

(async () => {
  await db.connect();
  const b = await chromium.launch();

  // ---------------- non-admins are kept out ----------------
  const owner = await login(b, 'owner@spice-route.demo');
  await owner.goto(`${BASE}/admin`);
  await owner.waitForURL(`${BASE}/dashboard`);
  ok(true, 'restaurant owner is sent away from /admin');

  // ---------------- admin console ----------------
  const a = await login(b, 'admin@platform.demo', /\/admin$/);
  ok(true, 'platform admin lands on the admin console');
  await a.waitForSelector('text=Spice Route');
  const rows = a.locator('tbody tr');
  ok(await rows.count() >= 3, 'all restaurants listed');
  await a.screenshot({ path: `${OUT}/p9-admin-restaurants.png`, fullPage: true });
  await a.fill('#q', 'bombay');
  await a.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
  ok((await rows.first().innerText()).includes('Bombay Bistro'), 'search finds one restaurant');
  await a.fill('#q', '');
  await a.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 3);

  // pause Spice Route
  await a.locator('tbody tr', { hasText: 'Spice Route' }).locator('text=Manage').click();
  await a.waitForSelector('h1:has-text("Spice Route")');
  await a.click('button:has-text("Pause")');
  await a.waitForSelector('text=Say why the restaurant is being paused.');
  ok(true, 'pausing needs a reason');
  await a.fill('#a-reason', 'Unpaid invoice');
  await a.click('button:has-text("Pause")');
  await a.waitForSelector('text=Restaurant paused.');
  const waiter = await login(b, 'waiter@spice-route.demo');
  await waiter.waitForSelector('text=Your dashboard is paused');
  ok(await waiter.locator('nav >> text=Bills').count() === 0, 'paused restaurant staff see the paused screen');
  const g = await (await b.newContext()).newPage();
  await g.goto(`${BASE}/r/spice-route/menu?t=spice-route-table-1-qr`);
  ok(!(await g.content()).includes('Spice Route Butter Chicken'), 'paused restaurant menu shows no dishes');
  const bo = await login(b, 'owner@bombay-bistro.demo');
  ok(await bo.locator('nav >> text=Orders').count() === 1, 'other restaurants keep working');
  await a.click('button:has-text("Restore access")');
  await a.waitForSelector('text=Restaurant restored.');
  await waiter.reload();
  await waiter.waitForSelector('nav >> text=Bills');
  ok(true, 'restoring brings the staff screens back');

  // payouts need a real-looking account id
  await a.selectOption('#a-acc-status', 'active');
  await a.click('button:has-text("Save payouts")');
  await a.waitForSelector('text=An active payout account needs a Razorpay account id like acc_XXXX.');
  await a.fill('#a-acc', 'acc_DemoSpice01');
  await a.click('button:has-text("Save payouts")');
  await a.waitForSelector('text=Payout account saved.');
  const { rows: [sp] } = await db.query(`select payout_account_id, payout_account_status from public.restaurants where id = $1`, [SPICE]);
  ok(sp.payout_account_id === 'acc_DemoSpice01' && sp.payout_account_status === 'active', 'payout account saved');
  await a.screenshot({ path: `${OUT}/p9-admin-manage.png`, fullPage: true });

  // ---------------- plans ----------------
  await a.click('nav >> text=Plans');
  await a.click('button[aria-label="Edit Standard"]');
  await a.fill('#p-price', '999');
  await a.click('button:has-text("Save plan")');
  await a.waitForSelector('text=Saved Standard.');
  ok((await a.content()).includes('₹999'), 'plan price changed');
  await a.screenshot({ path: `${OUT}/p9-admin-plans.png`, fullPage: true });

  // ---------------- payment settings ----------------
  await a.click('nav >> text=Payments');
  await a.waitForSelector('text=Test mode is ON');
  await a.fill('#secret', 'whsec_from_razorpay');
  await a.click('button:has-text("Save secret")');
  await a.waitForSelector('text=A secret is saved.');
  ok(!(await a.content()).includes('whsec_from_razorpay'), 'webhook secret is never shown back');
  await a.screenshot({ path: `${OUT}/p9-admin-payments.png`, fullPage: true });

  await a.click('nav >> text=Activity');
  await a.waitForSelector('text=Restaurant changed');
  ok(await a.locator('text=Payment settings changed').count() >= 1, 'activity log lists console changes');

  // ---------------- owner picks a plan after the trial ends ----------------
  await db.query(`update public.restaurants set trial_ends_at = now() - interval '1 day' where id = $1`, [GREEN]);
  const go = await login(b, 'owner@green-leaf.demo');
  await go.waitForSelector('text=Your dashboard is paused');
  await go.waitForSelector('text=₹999');
  await go.screenshot({ path: `${OUT}/p9-owner-trial-ended.png`, fullPage: true });
  await go.click('button:has-text("Choose Standard")');
  await go.waitForSelector('nav >> text=Orders');
  ok(true, 'choosing a plan (test mode) reopens the dashboard');
  const { rows: [gl] } = await db.query(`select plan, subscription_status::text s from public.restaurants where id = $1`, [GREEN]);
  ok(gl.plan === 'standard' && gl.s === 'active', 'restaurant is now on Standard, paying');
  await go.click('nav >> text=Plan');
  await go.waitForSelector('[data-testid="plan-summary"]');
  ok((await go.locator('[data-testid="plan-summary"]').innerText()).startsWith('You’re on standard, paid until'), 'plan page shows the paid-until date');
  const gm = await login(b, 'manager@green-leaf.demo');
  ok(await gm.locator('nav >> text="Plan"').count() === 0, 'only the owner sees the Plan page');

  await b.close();
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
