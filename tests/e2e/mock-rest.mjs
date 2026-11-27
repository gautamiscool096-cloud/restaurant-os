// Minimal stand-in for Supabase's REST RPC endpoint, for local e2e only:
// POST /rest/v1/rpc/<fn> {named args} -> select public.<fn>(name => value, ...) as anon.
import http from 'node:http';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const ALLOWED = new Set(['get_public_menu', 'resolve_table', 'place_order', 'get_session_orders', 'submit_review']);
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
};
http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const m = req.url.match(/^\/rest\/v1\/rpc\/([a-z_]+)/);
  if (!m || !ALLOWED.has(m[1])) { res.writeHead(404, cors); res.end('{}'); return; }
  let body = '';
  for await (const c of req) body += c;
  const args = body ? JSON.parse(body) : {};
  const names = Object.keys(args);
  const sql = `select public.${m[1]}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
  const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n]));
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
    await client.query('set local role anon');
    const { rows } = await client.query(sql, vals);
    await client.query('commit');
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify(rows[0].r));
  } catch (e) {
    await client.query('rollback');
    res.writeHead(400, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: e.message, code: e.code }));
  } finally {
    client.release();
  }
}).listen(54321, () => console.log('mock rest on 54321'));
