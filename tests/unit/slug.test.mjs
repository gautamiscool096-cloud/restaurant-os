import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { slugify, slugProblem, RESERVED_SLUGS } from '../../src/lib/slug.ts';

test('slugify makes readable web addresses', () => {
  assert.equal(slugify('Café Mumbai Bistro!'), 'cafe-mumbai-bistro');
  assert.equal(slugify('  Rock & Roll Diner  '), 'rock-and-roll-diner');
  assert.equal(slugify('A'.repeat(80)).length, 48);
  assert.equal(slugify('ढाबा'), '');
});

test('slugProblem mirrors the database rule', () => {
  assert.equal(slugProblem('spice-route'), null);
  assert.ok(slugProblem('ab'));
  assert.ok(slugProblem('-abc'));
  assert.ok(slugProblem('abc-'));
  assert.ok(slugProblem('Abc'));
  assert.ok(slugProblem('admin'));
});

test('reserved list is identical to the one in the migration', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261127000004_onboarding.sql', import.meta.url), 'utf8');
  const block = sql.match(/is_reserved_slug[\s\S]*?array\[([\s\S]*?)\]/)[1];
  const fromSql = [...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(fromSql, [...RESERVED_SLUGS].sort());
});
