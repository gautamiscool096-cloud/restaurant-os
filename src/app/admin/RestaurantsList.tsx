'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/money';
import { inputClass } from '@/components/ui';
import { STATUS_LABEL, shortDate, type AdminRestaurant } from './types';

type Metrics = {
  restaurants_total: number; restaurants_by_status: Record<string, number> | null; restaurants_suspended: number;
  gmv_minor_all_time: number; gmv_minor_30d: number; cancelled_30d: number;
};

export function RestaurantsList() {
  const [list, setList] = useState<AdminRestaurant[] | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void createClient().rpc('platform_metrics').then(({ data }) => setMetrics(data as Metrics));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      void createClient().rpc('platform_restaurants', { p_search: q || null }).then(({ data, error: e }) => {
        setError(e ? 'Could not load restaurants.' : null);
        if (data) setList(data as AdminRestaurant[]);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const by = metrics?.restaurants_by_status ?? {};
  const tiles = metrics ? [
    { label: 'Restaurants', value: String(metrics.restaurants_total) },
    { label: 'Paying', value: String(by.active ?? 0) },
    { label: 'On free trial', value: String(by.trialing ?? 0) },
    { label: 'Payment failed', value: String(by.past_due ?? 0) },
    { label: 'Paused', value: String(metrics.restaurants_suspended) },
    { label: 'Guest payments, 30 days', value: formatMoney(metrics.gmv_minor_30d) },
  ] : [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Restaurants</h1>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-2xl border border-stone-200 bg-white p-4">
            <p className="text-xs text-stone-500">{t.label}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{t.value}</p>
          </div>
        ))}
      </div>
      <div className="max-w-sm">
        <label htmlFor="q" className="sr-only">Search restaurants</label>
        <input id="q" className={inputClass} placeholder="Search by name or link" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-white">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-stone-100 text-xs text-stone-500">
            <tr><th className="px-4 py-3 font-medium">Restaurant</th><th className="px-4 py-3 font-medium">Plan</th>
              <th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium">Trial / paid until</th>
              <th className="px-4 py-3 text-right font-medium">Orders 30d</th><th className="px-4 py-3 text-right font-medium">Payments 30d</th>
              <th className="px-4 py-3 font-medium">Payouts</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {!list ? <tr><td colSpan={8} className="px-4 py-8 text-center text-stone-500">Loading…</td></tr> : null}
            {list?.length === 0 ? <tr><td colSpan={8} className="px-4 py-8 text-center text-stone-500">No restaurants match.</td></tr> : null}
            {list?.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-3"><p className="font-medium">{r.name}</p><p className="text-xs text-stone-500">/r/{r.slug} · {r.owner ?? 'no owner'}</p></td>
                <td className="px-4 py-3 capitalize">{r.plan}</td>
                <td className="px-4 py-3">
                  {r.suspended ? <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800 ring-1 ring-red-200">Paused</span>
                    : <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${r.operational ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-amber-50 text-amber-900 ring-amber-200'}`}>
                        {STATUS_LABEL[r.status]}{r.operational ? '' : ' · blocked'}</span>}
                </td>
                <td className="px-4 py-3 text-stone-600">{r.status === 'trialing' ? shortDate(r.trial_ends_at) : shortDate(r.current_period_end)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.orders_30d}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatMoney(r.gmv_30d_minor)}</td>
                <td className="px-4 py-3 text-xs capitalize text-stone-600">{r.payout_account_status.replace('_', ' ')}</td>
                <td className="px-4 py-3 text-right"><Link href={`/admin/restaurants/${r.id}`} className="rounded-lg px-3 py-1.5 font-medium text-amber-700 hover:bg-amber-50">Manage</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
