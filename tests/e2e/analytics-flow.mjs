// End-to-end: analytics screen over 30 days of demo history (supabase/demo-history.sql
// must be loaded after the seed), roles and isolation. See tests/e2e/README.md.
import { createRequire } from 'node:module';
import os from 'node:os';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.APP_URL ?? 'http://localhost:3102';
const OUT = process.env.SCREENSHOT_DIR ?? os.tmpdir();
const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
const ok = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('ok -', m); };

async function login(browser, email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { throw e; });
  await p.goto(`${BASE}/login`);
  await p.fill('#email', email);
  await p.fill('#password', 'demo-password-123');
  await p.click('button[type=submit]');
  await p.waitForURL(/\/dashboard/);
  return p;
}

(async () => {
  await db.connect();
  const { rows: [{ n }] } = await db.query(`select count(*)::int n from public.orders where restaurant_id = '0000000a-0000-4000-8000-000000000000'`);
  ok(n > 50, `demo history loaded (${n} Spice Route orders)`);
  const b = await chromium.launch();

  const o = await login(b, 'owner@spice-route.demo');
  await o.click('nav >> text=Analytics');
  await o.waitForSelector('section[aria-label="Summary"]');
  await o.click('role=tab[name="Last 30 days"]');
  await o.waitForSelector('figure[aria-label="Sales by day"]');
  await o.waitForFunction(() => document.querySelectorAll('figure[aria-label="Sales by day"] [title]').length === 30);
  ok(true, '30 days of sales bars');
  const { rows: [exp] } = await db.query(`
    select count(*)::int orders from public.orders
     where restaurant_id = '0000000a-0000-4000-8000-000000000000' and status in ('approved','preparing','ready','served')
       and created_at >= ((now() at time zone 'Asia/Kolkata')::date - 29)::timestamp at time zone 'Asia/Kolkata'`);
  const summary = await o.locator('section[aria-label="Summary"]').innerText();
  ok(summary.includes(`${exp.orders} orders`), `order count matches the database (${exp.orders})`);
  ok(await o.locator('section[aria-label="Speed of service"] [data-level]').count() === 5, 'speed of service shows all five steps with a colour');
  ok(await o.locator('section[aria-label="Best sellers"] tbody tr').count() >= 5, 'best sellers listed');
  ok(!(await o.content()).includes('Bombay Bistro'), 'no other restaurant appears');
  ok(await o.locator('section[aria-label="What guests said"] >> text=★').count() > 0, 'reviews summarised');
  await o.screenshot({ path: `${OUT}/p7-analytics.png`, fullPage: true });

  const bo = await login(b, 'owner@bombay-bistro.demo');
  await bo.goto(`${BASE}/dashboard/analytics`);
  await bo.waitForSelector('section[aria-label="Best sellers"] tbody tr');
  const best = await bo.locator('section[aria-label="Best sellers"] tbody').innerText();
  ok(best.includes('Bombay Bistro') && !best.includes('Spice Route'), 'Bombay Bistro owner sees only Bombay Bistro dishes');

  for (const role of ['waiter', 'chef', 'cashier']) {
    const p = await login(b, `${role}@spice-route.demo`);
    ok(await p.locator('nav >> text=Analytics').count() === 0, `${role} has no Analytics link`);
    await p.goto(`${BASE}/dashboard/analytics`);
    await p.waitForURL(`${BASE}/dashboard`);
    ok(true, `${role} is sent back from analytics`);
  }

  await b.close();
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
