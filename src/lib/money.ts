// Money is integer minor units (paise). The server (place_order) is the
// authority on totals; this mirrors its formula so the cart can show a
// live estimate.

export type ChargeSettings = {
  tax_percent: number;
  service_charge_percent: number;
  prices_include_tax: boolean;
};

export function formatMoney(minor: number, currency = 'INR') {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency, minimumFractionDigits: minor % 100 === 0 ? 0 : 2, maximumFractionDigits: 2,
  }).format(minor / 100);
}

export function computeTotals(subtotal: number, s: ChargeSettings) {
  const service = Math.round((subtotal * Number(s.service_charge_percent)) / 100);
  const tax = s.prices_include_tax ? 0 : Math.round(((subtotal + service) * Number(s.tax_percent)) / 100);
  return { subtotal, service, tax, total: subtotal + service + tax };
}
