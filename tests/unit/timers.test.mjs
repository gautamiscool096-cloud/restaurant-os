import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, currentStage, duration, levelFor, sinceApproval, steps } from '../../src/lib/timers.ts';

const T0 = Date.parse('2026-11-27T12:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const order = (over) => ({
  status: 'pending', created_at: at(0), approved_at: null, preparing_at: null, ready_at: null, served_at: null, ...over,
});

test('clock and duration formats', () => {
  assert.equal(clock(T0, T0 + 65_000), '1:05');
  assert.equal(clock(T0, T0 + 3_725_000), '1:02:05');
  assert.equal(clock(T0, T0 - 5_000), '0:00');
  assert.equal(duration(T0, T0 + 40_000), '40 s');
  assert.equal(duration(T0, T0 + 12 * 60_000), '12 min');
  assert.equal(duration(T0, T0 + 65 * 60_000), '1 h 5 min');
});

test('colour levels', () => {
  const lim = { warn: 15, late: 25 };
  assert.equal(levelFor(14.9, lim), 'ok');
  assert.equal(levelFor(15, lim), 'warn');
  assert.equal(levelFor(25, lim), 'late');
});

test('current stage times from the start of that stage', () => {
  const o = order({ status: 'preparing', approved_at: at(2), preparing_at: at(4) });
  const s = currentStage(o, T0 + 20 * 60_000);
  assert.equal(s.key, 'preparing');
  assert.equal(Math.round(s.minutes), 16);
  assert.equal(s.level, 'warn');
  assert.equal(currentStage(order({ status: 'served', served_at: at(3) }), T0), null);
});

test('time since approval runs until served, then stops', () => {
  const running = sinceApproval(order({ status: 'ready', approved_at: at(1) }), T0 + 31 * 60_000);
  assert.equal(running.running, true);
  assert.equal(running.level, 'late');
  const done = sinceApproval(order({ status: 'served', approved_at: at(1), served_at: at(19) }), T0 + 999 * 60_000);
  assert.equal(done.running, false);
  assert.equal(Math.round(done.minutes), 18);
  assert.equal(done.level, 'ok');
  assert.equal(sinceApproval(order({}), T0), null);
});

test('steps show how long each step took, skipping missing ones', () => {
  const s = steps(order({ status: 'served', approved_at: at(2), preparing_at: at(3), served_at: at(20) }));
  assert.deepEqual(s.map((x) => [x.key, x.took]), [['approved', '2 min'], ['preparing', '1 min'], ['ready', null], ['served', '17 min']]);
});
