import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTotals, formatMoney } from '../../src/lib/money.ts';

test('cart estimate matches the place_order formula (see customer-qr DB test)', () => {
  // Spice Route: 5% tax, 10% service; 2 x 240 + 90
  assert.deepEqual(
    computeTotals(57000, { tax_percent: 5, service_charge_percent: 10, prices_include_tax: false }),
    { subtotal: 57000, service: 5700, tax: 3135, total: 65835 });
  assert.equal(computeTotals(10000, { tax_percent: 18, service_charge_percent: 0, prices_include_tax: true }).total, 10000);
});

test('formats rupees', () => {
  assert.equal(formatMoney(24000), '₹240');
  assert.equal(formatMoney(24050), '₹240.50');
});
