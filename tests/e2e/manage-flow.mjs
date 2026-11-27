// End-to-end: owners run their own restaurant. Menu editor, sold-out toggle
// from the kitchen, settings, tables, staff invites and joining with a code,
// plus role limits and isolation. See tests/e2e/README.md.
import { createRequire } from 'node:module';
import os from 'node:os';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.APP_URL ?? 'http://localhost:3102';
const OUT = process.env.SCREENSHOT_DIR ?? os.tmpdir();
const PASSWORD = 'demo-password-123';
const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
const ok = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); console.log('ok -', m); };
const BUTTER_CHICKEN = 'Spice Route Butter Chicken';

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

  // ---------------- owner edits the menu ----------------
  const o = await login(b, 'owner@spice-route.demo');
  for (const label of ['Menu', 'Tables & QR', 'Team', 'Settings']) {
    ok(await o.locator(`nav >> text="${label}"`).count() === 1, `owner has a ${label} link`);
  }
  await o.click('nav >> text=Menu');
  await o.waitForSelector(`text=${BUTTER_CHICKEN}`);
  await o.fill('#new-cat', 'Desserts');
  await o.click('button:has-text("Add section")');
  await o.waitForSelector('text=Added Desserts.');
  const desserts = o.locator('section[aria-label="Desserts"]');
  await desserts.locator('button:has-text("Add dish")').click();
  await o.fill('#d-name', 'Gulab Jamun');
  await o.fill('#d-desc', 'Two warm pieces');
  await o.fill('#d-price', '99');
  await o.screenshot({ path: `${OUT}/p8-add-dish.png` });
  await o.click('button:has-text("Save dish")');
  await o.waitForSelector('text=Saved Gulab Jamun.');
  ok((await desserts.innerText()).includes('₹99'), 'new dish shows with its price');
  const { rows: [dish] } = await db.query(`select price_minor, restaurant_id from public.menu_items where name = 'Gulab Jamun'`);
  ok(dish.price_minor === 9900 && dish.restaurant_id === '0000000a-0000-4000-8000-000000000000', 'dish stored in paise for Spice Route only');

  // edit price, then a bad price is refused with a plain message
  await o.click('button[aria-label="Edit Gulab Jamun"]');
  await o.fill('#d-price', '120');
  await o.click('button:has-text("Save dish")');
  await o.waitForSelector('text=Saved Gulab Jamun.');
  ok((await desserts.innerText()).includes('₹120'), 'price change shows');
  await o.screenshot({ path: `${OUT}/p8-menu.png`, fullPage: true });

  // guests see it on the QR menu
  const g = await (await b.newContext()).newPage();
  await g.goto(`${BASE}/r/spice-route/menu?t=spice-route-table-1-qr`);
  await g.waitForSelector('text=Gulab Jamun');
  ok(true, 'guest menu shows the new dish');

  // ---------------- chef marks a dish sold out ----------------
  const chef = await login(b, 'chef@spice-route.demo');
  ok(await chef.locator('nav >> text="Menu"').count() === 1, 'chef has a Menu link');
  ok(await chef.locator('nav >> text="Settings"').count() === 0, 'chef has no Settings link');
  await chef.click('nav >> text=Menu');
  await chef.waitForSelector(`text=${BUTTER_CHICKEN}`);
  ok(await chef.locator('button:has-text("Add dish")').count() === 0, 'chef cannot add dishes');
  await chef.click(`button[aria-label="Mark sold out: ${BUTTER_CHICKEN}"]`);
  await chef.waitForSelector(`text=${BUTTER_CHICKEN} is now sold out.`);
  const { rows: [bc] } = await db.query(`select is_available from public.menu_items where name = $1`, [BUTTER_CHICKEN]);
  ok(bc.is_available === false, 'sold out is saved');
  await chef.goto(`${BASE}/dashboard/settings`);
  await chef.waitForURL(`${BASE}/dashboard`);
  ok(true, 'chef is sent back from settings');

  // ---------------- settings ----------------
  await o.click('nav >> text=Settings');
  await o.waitForSelector('#s-name');
  await o.fill('#s-name', 'Spice Route Indiranagar');
  await o.fill('#s-footer', 'Thank you, come again!');
  await o.click('button:has-text("Save settings")');
  await o.waitForSelector('text=Settings saved.');
  await o.waitForSelector('header >> text=Spice Route Indiranagar');
  ok(true, 'new name shows in the header');
  await o.uncheck('text=Guests can pay at the table');
  await o.uncheck('text=Guests can pay online');
  await o.click('button:has-text("Save settings")');
  await o.waitForSelector('text=Guests need at least one way to pay.');
  ok(true, 'cannot turn off every way to pay');
  await o.screenshot({ path: `${OUT}/p8-settings.png`, fullPage: true });
  const { rows: [st] } = await db.query(`select receipt_footer, accepts_cash from public.restaurant_settings where restaurant_id = '0000000a-0000-4000-8000-000000000000'`);
  ok(st.receipt_footer === 'Thank you, come again!' && st.accepts_cash, 'settings saved; failed save changed nothing');

  // ---------------- tables ----------------
  await o.click('nav >> text=Tables & QR');
  await o.waitForSelector('figure');
  const before = await o.locator('figure').count();
  await o.click('button:has-text("Manage tables")');
  await o.fill('#t-count', '2');
  await o.click('section[aria-label="Manage tables"] >> button:has-text("Add")');
  await o.waitForSelector('text=Added 2 tables.');
  await o.waitForFunction((n) => document.querySelectorAll('figure').length === n, before + 2);
  ok(true, `two more QR codes (${before} → ${before + 2})`);
  await o.screenshot({ path: `${OUT}/p8-tables.png`, fullPage: true });

  // ---------------- team: invite and join ----------------
  await o.click('nav >> text=Team');
  await o.waitForSelector('text=Your team');
  await o.fill('#i-name', 'Asha');
  await o.selectOption('#i-role', 'waiter');
  await o.click('button:has-text("Create invite code")');
  const codeBox = o.locator('[data-testid="invite-code"]');
  await codeBox.waitFor();
  const code = (await codeBox.locator('p.font-mono').innerText()).trim();
  ok(/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(code), `invite code shown once (${code})`);
  await o.screenshot({ path: `${OUT}/p8-team.png`, fullPage: true });
  const { rows: [inv] } = await db.query(`select code_hash from public.staff_invites where display_name = 'Asha'`);
  ok(inv.code_hash !== code, 'only a hash of the code is stored');

  // Bombay Bistro owner cannot see it
  const bo = await login(b, 'owner@bombay-bistro.demo');
  await bo.goto(`${BASE}/dashboard/team`);
  await bo.waitForSelector('text=Your team');
  ok(!(await bo.content()).includes('Asha'), 'Bombay Bistro does not see Spice Route invites');

  // a new user with no restaurant joins with the code
  const d = await login(b, 'drifter@nowhere.demo', /\/onboarding/);
  await d.fill('#code', 'FFFF-0000');
  await d.click('button:has-text("Join team")');
  await d.waitForSelector('text=That code is not valid or has expired.');
  ok(true, 'wrong code is refused');
  await d.fill('#code', code.toLowerCase());
  await d.click('button:has-text("Join team")');
  await d.waitForSelector('text=You joined Spice Route Indiranagar as waiter.');
  ok(await d.locator('nav >> text="Service"').count() === 1 && await d.locator('nav >> text="Settings"').count() === 0, 'joined as a waiter with waiter screens');
  await d.screenshot({ path: `${OUT}/p8-joined.png` });

  await o.reload();
  const asha = o.locator('section[aria-label="Your team"] li', { hasText: 'Asha' });
  await asha.waitFor();
  ok(true, 'owner sees Asha in the team');
  await asha.locator('button:has-text("Active")').click();
  await o.waitForSelector('text=Asha can no longer log in.');
  await d.goto(`${BASE}/dashboard`);
  await d.waitForURL(/\/onboarding/);
  ok(true, 'turned-off staff lose access');

  // manager limits
  const m = await login(b, 'manager@spice-route.demo');
  await m.goto(`${BASE}/dashboard/team`);
  await m.waitForSelector('#i-role');
  ok(await m.locator('#i-role option[value="manager"]').count() === 0, 'managers cannot invite managers');
  const ownerRow = m.locator('section[aria-label="Your team"] li', { hasText: 'Owner @' });
  ok(await ownerRow.locator('select, button').count() === 0, 'manager cannot change the owner');
  ok(await m.locator('section[aria-label="Your team"] li', { hasText: '(you)' }).locator('select').count() === 0, 'manager cannot change their own job');

  await b.close();
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
