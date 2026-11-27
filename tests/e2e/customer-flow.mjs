// End-to-end customer flow against the local stand-in: scan table 2 at
// Spice Route -> filter -> add -> notes -> place order -> status -> add more.
import { createRequire } from 'node:module';
// Playwright is not a project dependency; use the copy installed on the machine.
const { chromium, devices } = createRequire(import.meta.url)('playwright');
import os from 'node:os';
import pg from 'pg';
const BASE = process.env.APP_URL ?? 'http://localhost:3102';
const OUT = process.env.SCREENSHOT_DIR ?? os.tmpdir();
const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('ok -', m); };

(async () => {
  await db.connect();
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  await p.goto(`${BASE}/r/spice-route/menu?t=spice-route-table-2-qr`);
  await p.waitForSelector('text=Paneer Tikka');
  assert(await p.locator('header >> text=Table 2').count() === 1, 'header shows Table 2');
  assert(await p.locator('text=Bombay Bistro').count() === 0, 'no other restaurant content');
  await p.screenshot({ path: `${OUT}/01-menu.png`, fullPage: true });

  // filters
  await p.click('button:has-text("Veg")');
  assert(await p.locator('text=Chicken 65').count() === 0, 'veg filter hides chicken');
  await p.click('button:has-text("All")');
  await p.fill('input[type=search]', 'dal');
  assert(await p.locator('h3').count() === 1, 'search narrows to one dish');
  await p.fill('input[type=search]', '');
  assert(await p.locator('text=Sold out').count() === 1, 'unavailable thali shows sold out');

  // add items
  await p.click('button[aria-label="Add Spice Route Paneer Tikka"]');
  await p.click('button[aria-label="Add one Spice Route Paneer Tikka"]');
  await p.click('button[aria-label="Add Spice Route Masala Chaas"]');
  await p.waitForSelector('text=3 items');
  await p.click('text=View cart');
  await p.fill('input[aria-label="Instructions for Spice Route Paneer Tikka"]', 'No onion please');
  await p.fill('textarea[aria-label="Order note"]', 'Birthday, bring candles');
  const totalText = await p.locator('button:has-text("Place order")').innerText();
  assert(totalText.includes('658.35'), `cart shows server-matching total (${totalText})`);
  await p.screenshot({ path: `${OUT}/02-cart.png` });

  await p.click('button:has-text("Place order")');
  await p.waitForURL(/\/order\?t=/);
  await p.waitForSelector('text=Order #4');
  assert(await p.locator('text=Waiting for the restaurant to confirm').count() === 1, 'status pending');
  await p.screenshot({ path: `${OUT}/03-status-pending.png`, fullPage: true });

  const { rows: [o] } = await db.query(
    `select o.id, o.total_minor, o.customer_note, o.status, r.slug from public.orders o join public.restaurants r on r.id = o.restaurant_id
      where o.order_number = 4 and r.slug = 'spice-route'`);
  assert(o && o.total_minor === 65835 && o.customer_note.startsWith('Birthday'), 'order stored in Spice Route with server total');
  const { rows: [note] } = await db.query(`select special_instructions from public.order_items where order_id = $1 and quantity = 2`, [o.id]);
  assert(note.special_instructions === 'No onion please', 'item instructions stored');

  // kitchen progress shows up via polling
  await db.query(`update public.orders set status = 'served' where id = $1`, [o.id]);
  await p.waitForSelector('text=Served. Enjoy!', { timeout: 12000 });
  assert(true, 'status page picks up served via polling');
  await p.screenshot({ path: `${OUT}/04-status-served.png`, fullPage: true });

  // add more items -> same session
  await p.click('text=+ Add more items');
  await p.waitForSelector('text=Dal Makhani');
  await p.click('button[aria-label="Add Spice Route Dal Makhani"]');
  await p.click('text=View cart');
  await p.click('button:has-text("Place order")');
  await p.waitForSelector('text=Order #5');
  const { rows: s } = await db.query(
    `select count(distinct session_id)::int n from public.orders o join public.restaurants r on r.id = o.restaurant_id
      where r.slug = 'spice-route' and o.order_number in (4, 5)`);
  assert(s[0].n === 1, 'add-on order joined the same table session');

  // review
  await p.click('button[aria-label="5 stars"]');
  await p.fill('textarea', 'Lovely');
  await p.click('text=Send review');
  await p.waitForSelector('text=Thanks for your feedback');
  assert(true, 'review submitted');

  // a second phone at the same table cannot hijack the session
  const p2 = await (await b.newContext({ ...devices['iPhone 13'] })).newPage();
  await p2.goto(`${BASE}/r/spice-route/menu?t=spice-route-table-2-qr`);
  await p2.click('button[aria-label="Add Spice Route Paneer Tikka"]');
  await p2.click('text=View cart');
  await p2.click('button:has-text("Place order")');
  await p2.waitForSelector('text=already has an open order');
  assert(true, 'second phone gets friendly open-order message');

  // wrong-restaurant token
  await p2.goto(`${BASE}/r/spice-route/menu?t=bombay-bistro-table-5-qr`);
  await p2.waitForSelector('text=scan the QR code on your table');
  assert(await p2.locator('header >> text=Table').count() === 0, 'B\'s QR token under A\'s slug is not a table');

  await p2.goto(`${BASE}/r/no-such-place/menu`);
  await p2.waitForSelector('text=Menu not found');
  assert(true, 'unknown slug shows not found');

  // desktop width check
  const d = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await d.goto(`${BASE}/r/bombay-bistro/menu?t=bombay-bistro-table-1-qr`);
  await d.waitForSelector('text=Butter Chicken');
  await d.screenshot({ path: `${OUT}/05-desktop-bombay.png` });
  for (const pg2 of [p, d]) {
    assert(!(await pg2.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'no horizontal scroll');
  }
  assert(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await b.close();
  await db.end();
})().catch(async (e) => { console.error(e); process.exit(1); });
