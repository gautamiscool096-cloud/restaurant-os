// Test harness: every test runs inside one transaction that is rolled back,
// so tests can mutate freely and never affect each other.
//
// Inside a transaction you can switch identity as often as you like:
//   tx.as('service')            -> database owner (bypasses RLS, like service_role/migrations)
//   tx.as('anon')               -> unauthenticated Supabase client
//   tx.as(userId)               -> authenticated Supabase client with that JWT `sub`
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set (see README: Running the tests)');

export const pool = new pg.Pool({ connectionString: url, max: 4 });

export const TENANTS = ['a', 'b', 'c'];
export const SLUG = { a: 'spice-route', b: 'bombay-bistro', c: 'green-leaf' };
export const ROLES = ['owner', 'manager', 'waiter', 'chef', 'cashier'];

const KIND = {
  restaurant: '8000', user: '8000', staff: '8001', table: '8002', category: '8003',
  item: '8004', session: '8005', order: '8006', payment: '8007', review: '8008', orderItem: '8009',
};

/** Deterministic seed id, e.g. id('a', 'order', 2) */
export function id(tenant, kind, n = 0) {
  return `0000000${tenant}-0000-4000-${KIND[kind]}-${String(n).padStart(12, '0')}`;
}
export const userId = (tenant, role) => id(tenant, 'user', ROLES.indexOf(role) + 1);
export const staffId = (tenant, role) => id(tenant, 'staff', ROLES.indexOf(role) + 1);
export const PLATFORM_ADMIN = '0000000f-0000-4000-8000-000000000001';
export const NO_TENANT_USER = '0000000e-0000-4000-8000-000000000001';
export const qrToken = (tenant, n) => `${SLUG[tenant]}-table-${n}-qr`;
export const sessionToken = (tenant, n) => `demo-session-${SLUG[tenant]}-${n}`;

class Tx {
  constructor(client) {
    this.client = client;
    this.sp = 0;
  }

  async as(who) {
    await this.client.query('reset role');
    if (who === 'service') {
      await this.client.query(`select set_config('request.jwt.claims', '', true)`);
      return this;
    }
    const claims = who === 'anon'
      ? { role: 'anon' }
      : { sub: who, role: 'authenticated', aud: 'authenticated' };
    await this.client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await this.client.query(`set local role ${who === 'anon' ? 'anon' : 'authenticated'}`);
    return this;
  }

  /** Run a query; throws on error (aborting the transaction). */
  async q(sql, params = []) {
    return (await this.client.query(sql, params)).rows;
  }

  /** Run a query inside a savepoint; returns { rows, rowCount, error } and never aborts the tx. */
  async try(sql, params = []) {
    const name = `sp_${++this.sp}`;
    await this.client.query(`savepoint ${name}`);
    try {
      const res = await this.client.query(sql, params);
      await this.client.query(`release savepoint ${name}`);
      return { rows: res.rows, rowCount: res.rowCount, error: null };
    } catch (error) {
      await this.client.query(`rollback to savepoint ${name}`);
      return { rows: [], rowCount: 0, error };
    }
  }
}

/** Open a rolled-back transaction, optionally already acting as `who`. */
export async function tx(who, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const t = new Tx(client);
    if (who) await t.as(who);
    return await fn(t);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}
