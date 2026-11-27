'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/money';
import { friendlyError } from '@/lib/rpc-error';
import { inputClass } from '@/components/ui';
import { STATUS_LABEL, shortDate, type AdminRestaurant } from '../../types';

type Plan = { code: string; name: string };

export function ManageRestaurant({ id }: { id: string }) {
  const [r, setR] = useState<AdminRestaurant | null | undefined>(undefined);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('14');
  const [payout, setPayout] = useState({ id: '', status: 'not_connected' });

  useEffect(() => {
    const sb = createClient();
    void sb.rpc('platform_restaurants').then(({ data }) => {
      const found = (data as AdminRestaurant[] | null)?.find((x) => x.id === id) ?? null;
      setR(found);
      if (found) setPayout({ id: found.payout_account_id ?? '', status: found.payout_account_status });
    });
    void sb.rpc('platform_plans').then(({ data }) => setPlans((data as { plans: Plan[] } | null)?.plans ?? []));
  }, [id]);

  if (r === undefined) return <p className="py-10 text-center text-stone-500">Loading…</p>;
  if (r === null) return <p className="py-10 text-center text-stone-500">Restaurant not found. <Link href="/admin" className="underline">Back</Link></p>;

  async function update(change: Record<string, unknown>, ok: string) {
    setBusy(true); setError(null); setNotice(null);
    const { data, error: e } = await createClient().rpc('platform_update_restaurant', { p_id: id, p: change });
    setBusy(false);
    if (e) { setError(friendlyError(e)); return; }
    setR(data as AdminRestaurant);
    setNotice(ok);
  }

  const card = 'space-y-3 rounded-2xl border border-stone-200 bg-white p-5';
  const btn = 'rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50';

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin" className="text-sm text-stone-500 hover:underline">← All restaurants</Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{r.name}</h1>
        <p className="text-stone-600">/r/{r.slug} · owner {r.owner ?? '—'} · {r.staff} staff · joined {shortDate(r.created_at)}</p>
      </div>
      {error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {notice ? <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}

      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ['Status', r.suspended ? 'Paused' : STATUS_LABEL[r.status]],
          ['Can take orders', r.operational ? 'Yes' : 'No'],
          [r.status === 'trialing' ? 'Trial ends' : 'Paid until', r.status === 'trialing' ? shortDate(r.trial_ends_at) : shortDate(r.current_period_end)],
          ['Payments, 30 days', formatMoney(r.gmv_30d_minor)],
        ].map(([k, v]) => (
          <div key={k} className="rounded-2xl border border-stone-200 bg-white p-4" data-testid={`stat-${k}`}>
            <p className="text-xs text-stone-500">{k}</p><p className="mt-1 font-semibold">{v}</p>
          </div>
        ))}
      </div>

      <section className={card} aria-label="Subscription">
        <h2 className="font-semibold">Subscription</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div><label htmlFor="a-plan" className="block text-sm font-medium">Plan</label>
            <select id="a-plan" className={inputClass} value={r.plan} disabled={busy}
                    onChange={(e) => update({ plan: e.target.value }, `Plan changed to ${e.target.value}.`)}>
              {plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
            </select></div>
          <div><label htmlFor="a-status" className="block text-sm font-medium">Status</label>
            <select id="a-status" className={inputClass} value={r.status} disabled={busy}
                    onChange={(e) => update(e.target.value === 'active'
                      ? { status: 'active', current_period_end: new Date(Date.now() + 30 * 86400e3).toISOString() }
                      : { status: e.target.value }, `Status changed to ${STATUS_LABEL[e.target.value as AdminRestaurant['status']]}.`)}>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></div>
          <div className="w-28"><label htmlFor="a-days" className="block text-sm font-medium">Extra trial days</label>
            <input id="a-days" type="number" min="1" max="365" className={inputClass} value={days} onChange={(e) => setDays(e.target.value)} /></div>
          <button type="button" className={btn} disabled={busy} onClick={() => update({ extend_trial_days: Number(days) }, `Trial extended by ${days} days.`)}>Extend trial</button>
        </div>
        <p className="text-sm text-stone-500">Setting “Paying” marks the restaurant paid for the next 30 days.</p>
      </section>

      <section className={card} aria-label="Pause">
        <h2 className="font-semibold">{r.suspended ? 'Paused' : 'Pause this restaurant'}</h2>
        {r.suspended ? (
          <>
            <p className="text-stone-600">Reason: {r.suspended_reason}</p>
            <button type="button" className={btn} disabled={busy} onClick={() => update({ suspend: false }, 'Restaurant restored.')}>Restore access</button>
          </>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-64 flex-1"><label htmlFor="a-reason" className="block text-sm font-medium">Reason (the owner sees this is paused)</label>
              <input id="a-reason" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            <button type="button" disabled={busy} onClick={() => update({ suspend: true, suspended_reason: reason }, 'Restaurant paused.')}
                    className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Pause</button>
          </div>
        )}
        <p className="text-sm text-stone-500">While paused, staff screens and the QR menu stop working. Nothing is deleted.</p>
      </section>

      <section className={card} aria-label="Payouts">
        <h2 className="font-semibold">Guest payment payouts (Razorpay Route)</h2>
        <p className="text-sm text-stone-500">Paste the restaurant’s linked account id from Razorpay (starts with acc_). Set it to Active once Razorpay approves it, and online payments will settle to this restaurant.</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56"><label htmlFor="a-acc" className="block text-sm font-medium">Linked account id</label>
            <input id="a-acc" className={`${inputClass} font-mono`} placeholder="acc_XXXXXXXX" value={payout.id} onChange={(e) => setPayout({ ...payout, id: e.target.value })} /></div>
          <div><label htmlFor="a-acc-status" className="block text-sm font-medium">Status</label>
            <select id="a-acc-status" className={inputClass} value={payout.status} onChange={(e) => setPayout({ ...payout, status: e.target.value })}>
              {['not_connected', 'pending', 'active', 'rejected'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select></div>
          <button type="button" className={btn} disabled={busy}
                  onClick={() => update({ payout_account_id: payout.id, payout_account_status: payout.status }, 'Payout account saved.')}>Save payouts</button>
        </div>
      </section>
    </div>
  );
}
