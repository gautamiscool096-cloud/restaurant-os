// Local stand-in for the parts of Supabase the web app uses, for end-to-end
// tests only. Every data request runs against real Postgres as the real
// `anon` / `authenticated` role with the JWT claims set, so RLS, grants,
// definer functions and guard triggers are exercised exactly as in production.
//
//   POST /auth/v1/signup                          create user (auto-confirmed)
//   POST /auth/v1/token?grant_type=password       email + password login
//   POST /auth/v1/token?grant_type=refresh_token
//   GET  /auth/v1/user                            who is this token
//   POST /auth/v1/logout
//   POST /rest/v1/rpc/<fn>                        call a function (named args)
//   GET|HEAD /rest/v1/<table>?select=&col=eq.x&order=col.asc   (subset)
//   PATCH /rest/v1/<table>?col=eq.x               (subset)
//
// Tokens are unsigned (alg HS256 so supabase-js asks /auth/v1/user to
// validate them). Never expose this server beyond localhost.
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
// Idle connections are dropped when the test database is reset; just reconnect.
pool.on('error', (e) => console.warn('pool:', e.message));
const PORT = Number(process.env.MOCK_PORT ?? 54321);
const IDENT = /^[a-z_][a-z0-9_]*$/;

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const makeJwt = (user) => {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
    sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600,
    session_id: crypto.randomUUID(),
  })}.mock`;
};
const decodeJwt = (token) => {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return p.sub && p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
};
const userJson = (u) => ({
  id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: new Date().toISOString(),
  app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [],
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
});
const session = (u) => ({
  access_token: makeJwt(u), token_type: 'bearer', expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: `refresh.${u.id}`, user: userJson(u),
});

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, HEAD, POST, PATCH, OPTIONS',
  'access-control-expose-headers': 'content-range',
};
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...cors, 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

/** Run SQL as the caller identified by the Authorization header (or anon). */
async function asCaller(req, fn) {
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /i, '');
  const claims = decodeJwt(bearer);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify(claims ? { sub: claims.sub, role: 'authenticated', aud: 'authenticated' } : { role: 'anon' })]);
    await client.query(`set local role ${claims ? 'authenticated' : 'anon'}`);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

function filters(params, startAt = 1) {
  const where = [];
  const vals = [];
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'columns'].includes(k)) continue;
    if (!IDENT.test(k) || !v.startsWith('eq.')) throw Object.assign(new Error(`unsupported filter ${k}=${v}`), { code: 'PGRST' });
    vals.push(v.slice(3));
    where.push(`${k} = $${startAt + vals.length - 1}`);
  }
  return { where: where.length ? `where ${where.join(' and ')}` : '', vals };
}

async function readBody(req) {
  let b = '';
  for await (const c of req) b += c;
  return b ? JSON.parse(b) : {};
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204);
  const url = new URL(req.url, 'http://x');
  try {
    // ---- auth ----
    if (url.pathname === '/auth/v1/signup' && req.method === 'POST') {
      const { email, password } = await readBody(req);
      const { rows: [u] } = await pool.query(
        `insert into auth.users (email, encrypted_password, aud, role, email_confirmed_at)
         values (lower($1), extensions.crypt($2, extensions.gen_salt('bf')), 'authenticated', 'authenticated', now())
         returning id, email`, [email, password]);
      return send(res, 200, session(u));
    }
    if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
      const body = await readBody(req);
      const grant = url.searchParams.get('grant_type');
      let rows;
      if (grant === 'password') {
        ({ rows } = await pool.query(
          `select id, email from auth.users where email = lower($1) and encrypted_password = extensions.crypt($2, encrypted_password)`,
          [body.email, body.password]));
      } else if (grant === 'refresh_token' && String(body.refresh_token).startsWith('refresh.')) {
        ({ rows } = await pool.query(`select id, email from auth.users where id = $1`, [body.refresh_token.slice(8)]));
      }
      if (!rows?.length) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', code: 'invalid_credentials' });
      return send(res, 200, session(rows[0]));
    }
    if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
      const claims = decodeJwt((req.headers.authorization ?? '').replace(/^Bearer /i, ''));
      if (!claims) return send(res, 401, { code: 401, msg: 'invalid JWT', error_code: 'bad_jwt' });
      const { rows: [u] } = await pool.query(`select id, email from auth.users where id = $1`, [claims.sub]);
      return u ? send(res, 200, userJson(u)) : send(res, 404, { msg: 'User not found', error_code: 'user_not_found' });
    }
    if (url.pathname === '/auth/v1/logout') return send(res, 204);

    // ---- rest ----
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (rpc && req.method === 'POST') {
      const args = await readBody(req);
      const names = Object.keys(args).filter((n) => IDENT.test(n));
      const { rows: [fn] } = await pool.query(
        `select prorettype::regtype::text t from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace limit 1`, [rpc[1]]);
      const call = `public.${rpc[1]}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})`;
      const sql = fn?.t === 'void' ? `select ${call}, null::jsonb as r` : `select to_jsonb(${call}) as r`;
      const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n]));
      const r = await asCaller(req, (c) => c.query(sql, vals));
      return send(res, 200, r.rows[0].r);
    }
    const tbl = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (tbl && IDENT.test(tbl[1])) {
      const table = `public.${tbl[1]}`;
      if (req.method === 'GET' || req.method === 'HEAD') {
        const cols = (url.searchParams.get('select') ?? '*').split(',').map((c) => c.trim());
        if (!cols.every((c) => c === '*' || IDENT.test(c))) throw new Error('unsupported select');
        const { where, vals } = filters(url.searchParams);
        let order = '';
        const o = url.searchParams.get('order');
        if (o) {
          const [col, dir] = o.split('.');
          if (!IDENT.test(col)) throw new Error('bad order');
          order = `order by ${col} ${dir === 'desc' ? 'desc' : 'asc'}`;
        }
        const r = await asCaller(req, (c) => c.query(`select ${cols.join(', ')} from ${table} ${where} ${order}`, vals));
        const range = r.rows.length ? `0-${r.rows.length - 1}/${r.rows.length}` : `*/0`;
        if (req.method === 'HEAD') { res.writeHead(200, { ...cors, 'content-range': range }); return res.end(); }
        return send(res, 200, r.rows, { 'content-range': range });
      }
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const keys = Object.keys(body).filter((k) => IDENT.test(k));
        const { where, vals } = filters(url.searchParams, keys.length + 1);
        await asCaller(req, (c) => c.query(
          `update ${table} set ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} ${where}`,
          [...keys.map((k) => body[k]), ...vals]));
        return send(res, 204);
      }
    }
    return send(res, 404, { message: `not mocked: ${req.method} ${url.pathname}` });
  } catch (e) {
    return send(res, 400, { message: e.message, code: e.code ?? 'P0001', details: null, hint: null });
  }
}).listen(PORT, () => console.log(`mock supabase on ${PORT}`));
