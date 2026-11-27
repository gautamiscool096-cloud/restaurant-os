'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/money';
import { storageKeys, type OrderStatus, type PublicMenu, type SessionOrder } from '@/lib/menu-types';
import { BrandHeader } from '../BrandHeader';

const STEPS: { key: OrderStatus; label: string }[] = [
  { key: 'pending', label: 'Sent' },
  { key: 'approved', label: 'Confirmed' },
  { key: 'preparing', label: 'Cooking' },
  { key: 'served', label: 'Served' },
];
const STEP_INDEX: Record<OrderStatus, number> = {
  pending: 0, approved: 1, preparing: 2, ready: 2, served: 3, rejected: -1, cancelled: -1,
};
const STATUS_TEXT: Record<OrderStatus, string> = {
  pending: 'Waiting for the restaurant to confirm',
  approved: 'Confirmed, sent to the kitchen',
  preparing: 'The kitchen is preparing your food',
  ready: 'Ready, coming to your table',
  served: 'Served. Enjoy!',
  rejected: 'The restaurant could not accept this order. Please ask your waiter.',
  cancelled: 'This order was cancelled.',
};
const POLL_MS = 5000;

export function OrderStatusApp({
  restaurant: r, settings, table, tableToken,
}: {
  restaurant: PublicMenu['restaurant'];
  settings: PublicMenu['settings'];
  table: { table_number: number; label: string | null } | null;
  tableToken: string | null;
}) {
  const keys = storageKeys(r.slug, tableToken ?? 'none');
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [orders, setOrders] = useState<SessionOrder[] | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const money = (m: number) => formatMoney(m, r.currency);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- one-time hydration from localStorage */
    try {
      setToken(JSON.parse(localStorage.getItem(keys.session) ?? 'null'));
      setReviewed(localStorage.getItem(keys.reviewed) === '1');
    } catch {
      setToken(null);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [keys.session, keys.reviewed]);

  const load = useCallback(async () => {
    if (!token) return;
    const { data } = await createClient().rpc('get_session_orders', { p_session_token: token });
    if (Array.isArray(data)) setOrders(data as SessionOrder[]);
  }, [token]);

  // Poll while the page is visible. (Realtime for guests arrives with the
  // broadcast channel in the waiter/kitchen phase.)
  useEffect(() => {
    if (!token) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [token, load]);

  const menuHref = `/r/${r.slug}/menu${tableToken ? `?t=${encodeURIComponent(tableToken)}` : ''}`;
  const tableLabel = table ? (table.label ?? `Table ${table.table_number}`) : null;
  const live = (orders ?? []).filter((o) => o.status !== 'rejected' && o.status !== 'cancelled');
  const sessionTotal = live.reduce((n, o) => n + o.total_minor, 0);
  const anyServed = live.some((o) => o.status === 'served');

  return (
    <div className="pb-16">
      <BrandHeader restaurant={r} tableLabel={tableLabel} />
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-5">
        {token === null || (orders && orders.length === 0) ? (
          <div className="space-y-3 py-10 text-center">
            <p className="text-stone-600">No orders from this phone yet.</p>
            <Link href={menuHref} className="inline-block rounded-xl bg-[var(--brand)] px-5 py-3 font-semibold text-white">See the menu</Link>
          </div>
        ) : null}
        {token && orders === null ? <p className="py-10 text-center text-stone-500">Loading your order…</p> : null}

        {(orders ?? []).slice().reverse().map((o) => {
          const step = STEP_INDEX[o.status];
          return (
            <article key={o.order_id} className="rounded-2xl border border-stone-200 p-4">
              <div className="flex items-baseline justify-between">
                <h2 className="font-semibold">Order #{o.order_number}</h2>
                <span className="text-sm text-stone-500">
                  {new Date(o.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </span>
              </div>
              <p className={`mt-1 text-sm ${step < 0 ? 'text-red-700' : 'text-stone-700'}`} aria-live="polite">{STATUS_TEXT[o.status]}</p>
              {step >= 0 ? (
                <ol className="mt-3 grid grid-cols-4 gap-1" aria-label="Order progress">
                  {STEPS.map((s, i) => (
                    <li key={s.key} className="space-y-1">
                      <div className={`h-1.5 rounded-full ${i <= step ? 'bg-[var(--brand)]' : 'bg-stone-200'}`} />
                      <p className={`text-xs ${i <= step ? 'font-medium text-stone-900' : 'text-stone-400'}`}>{s.label}</p>
                    </li>
                  ))}
                </ol>
              ) : null}
              <ul className="mt-3 space-y-1 text-sm">
                {o.items.map((it, idx) => (
                  <li key={idx} className="flex justify-between gap-3">
                    <span>
                      {it.quantity} × {it.name}
                      {it.special_instructions ? <span className="block text-xs text-stone-500">“{it.special_instructions}”</span> : null}
                    </span>
                    <span className="shrink-0 text-stone-600">{money(it.quantity * it.unit_price_minor)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 border-t border-stone-100 pt-2 text-right text-sm font-medium">Total {money(o.total_minor)}</p>
            </article>
          );
        })}

        {live.length ? (
          <>
            <Link href={menuHref} className="block rounded-xl border-2 border-[var(--brand)] py-3 text-center font-semibold text-[var(--brand)]">
              + Add more items
            </Link>
            <section className="rounded-2xl bg-stone-50 p-4">
              <div className="flex justify-between font-semibold"><span>Bill so far</span><span>{money(sessionTotal)}</span></div>
              <p className="mt-2 text-sm text-stone-600">
                {settings.accepts_cash ? 'You can pay by cash or card at your table. Just ask your waiter. ' : ''}
                {settings.accepts_online ? 'Online payment is coming soon.' : ''}
              </p>
            </section>
          </>
        ) : null}

        {anyServed && token && !reviewed ? (
          <ReviewForm token={token} onDone={() => {
            setReviewed(true);
            try { localStorage.setItem(keys.reviewed, '1'); } catch { /* ignore */ }
          }} />
        ) : null}
        {reviewed ? <p className="text-center text-sm text-stone-500">Thanks for your feedback!</p> : null}
      </main>
    </div>
  );
}

function ReviewForm({ token, onDone }: { token: string; onDone: () => void }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    const { error: err } = await createClient().rpc('submit_review', {
      p_session_token: token, p_rating: rating, p_comment: comment || null,
    });
    setBusy(false);
    if (err && !/duplicate|unique/i.test(err.message)) return setError('Could not send your review. Please try again.');
    onDone();
  }

  return (
    <section className="rounded-2xl border border-stone-200 p-4">
      <h2 className="font-semibold">How was your meal?</h2>
      <div className="mt-2 flex gap-1" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`}
                  onClick={() => setRating(n)}
                  className={`text-3xl leading-none ${n <= rating ? 'text-amber-400' : 'text-stone-300'}`}>★</button>
        ))}
      </div>
      <textarea value={comment} onChange={(e) => setComment(e.target.value.slice(0, 2000))} rows={2}
                placeholder="Anything you'd like to tell the restaurant? (optional)"
                className="mt-3 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-[var(--brand)]" />
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <button type="button" disabled={!rating || busy} onClick={submit}
              className="mt-2 w-full rounded-xl bg-[var(--brand)] py-3 font-semibold text-white disabled:opacity-50">
        {busy ? 'Sending…' : 'Send review'}
      </button>
    </section>
  );
}
