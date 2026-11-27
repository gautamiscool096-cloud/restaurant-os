'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/money';
import type { Bill } from '@/lib/bill';

type Start =
  | { mode: 'razorpay'; key_id: string; order_id: string; amount: number; currency: string; name: string }
  | { mode: 'test'; payment_id: string; amount: number };

declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open: () => void; on: (e: string, cb: () => void) => void };
  }
}

function loadCheckout(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

/** The guest's bill with "Pay online" (Razorpay, or test mode) and a receipt link. */
export function GuestBill({
  token, receiptHref, razorpayReady, refreshKey,
}: { token: string; receiptHref: string; razorpayReady: boolean; refreshKey: number }) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ payment_id: string; amount: number } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    const { data } = await createClient().rpc('guest_bill', { p_session_token: token });
    if (data) setBill(data as Bill);
  }, [token]);

  // refreshKey changes whenever the order list is polled
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on poll
    void load();
  }, [load, refreshKey]);

  if (!bill) return null;
  const money = (m: number) => formatMoney(m, bill.restaurant.currency);
  const online = bill.settings?.accepts_online && (razorpayReady || bill.test_mode);
  const paid = bill.total_minor > 0 && bill.due_minor === 0;

  async function pay() {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/pay/start', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setBusy(false);
      setError(body.error ?? 'Could not start the payment.');
      return;
    }
    const start = body as Start;
    if (start.mode === 'test') {
      setBusy(false);
      setTest({ payment_id: start.payment_id, amount: start.amount });
      return;
    }
    if (!(await loadCheckout()) || !window.Razorpay) {
      setBusy(false);
      setError('Could not open the payment window. Check your connection and try again.');
      return;
    }
    const rzp = new window.Razorpay({
      key: start.key_id, order_id: start.order_id, amount: start.amount, currency: start.currency, name: start.name,
      description: 'Restaurant bill',
      handler: () => { setConfirming(true); void load(); },
      modal: { ondismiss: () => setBusy(false) },
    });
    rzp.on('payment.failed', () => { setBusy(false); setError('The payment did not go through. You have not been charged.'); });
    rzp.open();
  }

  async function completeTest() {
    if (!test) return;
    setBusy(true);
    const { data, error: err } = await createClient().rpc('guest_complete_test_payment', {
      p_session_token: token, p_payment_id: test.payment_id,
    });
    setBusy(false);
    if (err) return setError('The test payment did not go through.');
    setTest(null);
    setBill(data as Bill);
  }

  return (
    <section aria-label="Your bill" className="space-y-3 rounded-2xl bg-stone-50 p-4">
      <dl className="space-y-1 text-sm">
        <Row label="Food" value={money(bill.subtotal_minor)} />
        {bill.service_charge_minor ? <Row label="Service charge" value={money(bill.service_charge_minor)} /> : null}
        {bill.tax_minor ? <Row label="Tax" value={money(bill.tax_minor)} /> : null}
        <Row label="Total" value={money(bill.total_minor)} strong />
        {bill.paid_minor ? <Row label="Paid" value={`− ${money(bill.paid_minor)}`} /> : null}
      </dl>

      {paid ? (
        <div className="space-y-2">
          <p className="rounded-xl bg-emerald-100 px-3 py-2 text-center font-semibold text-emerald-900">Paid. Thank you!</p>
          <Link href={receiptHref} className="block text-center text-sm font-medium text-[var(--brand)] underline">View receipt</Link>
        </div>
      ) : bill.due_minor > 0 ? (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between font-semibold">
            <span>To pay</span><span className="text-xl" data-testid="guest-due">{money(bill.due_minor)}</span>
          </div>
          {confirming ? <p role="status" className="text-sm text-stone-700">Payment received. Confirming with the restaurant…</p> : null}
          {test ? (
            <div className="space-y-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
              <p><span className="font-semibold">Test mode.</span> No real money will be taken. This is how online payment will work once the restaurant connects Razorpay.</p>
              <button type="button" disabled={busy} onClick={completeTest}
                      className="w-full rounded-xl bg-[var(--brand)] py-3 font-semibold text-white disabled:opacity-50">
                Complete test payment of {money(test.amount)}
              </button>
            </div>
          ) : online && !confirming ? (
            <button type="button" disabled={busy} onClick={pay}
                    className="w-full rounded-xl bg-[var(--brand)] py-3 font-semibold text-white disabled:opacity-50">
              {busy ? 'Opening payment…' : `Pay ${money(bill.due_minor)} online`}
            </button>
          ) : null}
          {bill.settings?.accepts_cash ? (
            <p className="text-sm text-stone-600">{online ? 'Or pay' : 'Pay'} by cash, card or UPI at your table. Just ask your waiter.</p>
          ) : null}
          {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
        </div>
      ) : (
        <p className="text-sm text-stone-600">Your bill appears here once the restaurant confirms your order.</p>
      )}
    </section>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'font-semibold' : 'text-stone-600'}`}>
      <dt>{label}</dt><dd className="tabular-nums">{value}</dd>
    </div>
  );
}
