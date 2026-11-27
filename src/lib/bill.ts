export type BillPayment = {
  id: string;
  method: 'cash' | 'online';
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';
  amount_minor: number;
  gateway: string | null;
  created_at: string;
};

export type Bill = {
  session_id: string;
  status: 'open' | 'closed';
  opened_at: string;
  closed_at: string | null;
  table: { number: number; label: string | null };
  restaurant: { name: string; address: string | null; currency: string; logo_url: string | null; slug: string };
  settings?: {
    tax_percent: number;
    service_charge_percent: number;
    prices_include_tax: boolean;
    receipt_footer: string | null;
    accepts_cash: boolean;
    accepts_online: boolean;
  };
  lines?: { name: string; quantity: number; unit_price_minor: number; amount_minor: number }[];
  orders: { order_number: number; status: string; total_minor: number }[];
  subtotal_minor: number;
  service_charge_minor: number;
  tax_minor: number;
  total_minor: number;
  paid_minor: number;
  due_minor: number;
  payments: BillPayment[];
  test_mode: boolean;
  payout_ready?: boolean;
};

export const tableName = (b: Pick<Bill, 'table'>) => b.table.label ?? `Table ${b.table.number}`;

export function paymentLabel(p: BillPayment) {
  if (p.method === 'cash') return 'Paid at the table';
  if (p.gateway === 'test') return 'Paid online (test, no real money)';
  return 'Paid online';
}

/** Short receipt number from the session id, e.g. "R-3F9A21". */
export const receiptNumber = (b: Pick<Bill, 'session_id'>) => `R-${b.session_id.replace(/-/g, '').slice(-6).toUpperCase()}`;
