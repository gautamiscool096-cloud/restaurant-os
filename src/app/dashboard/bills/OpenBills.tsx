'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/money';
import { tableName, type Bill } from '@/lib/bill';

export function OpenBills({ currency }: { currency: string }) {
  const [bills, setBills] = useState<Bill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const money = (m: number) => formatMoney(m, currency);

  const load = useCallback(async () => {
    const { data, error: err } = await createClient().rpc('open_bills');
    if (err) return setError('Could not load bills. Retrying…');
    setError(null);
    setBills(data as Bill[]);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load
    void load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 10_000);
    return () => clearInterval(id);
  }, [load]);

  const owing = (bills ?? []).filter((b) => b.due_minor > 0);
  const settled = (bills ?? []).filter((b) => b.due_minor === 0);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Bills</h1>
      {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {bills === null ? <p className="py-10 text-center text-stone-500">Loading bills…</p> : null}
      {bills && bills.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-stone-300 py-16 text-center text-stone-500">No tables are seated right now.</p>
      ) : null}
      {owing.length ? <BillList title="To collect" bills={owing} money={money} /> : null}
      {settled.length ? <BillList title="Paid or nothing ordered yet" bills={settled} money={money} /> : null}
    </div>
  );
}

function BillList({ title, bills, money }: { title: string; bills: Bill[]; money: (m: number) => string }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="font-semibold text-stone-700">{title}</h2>
      <ul className="divide-y divide-stone-100 rounded-2xl bg-white ring-1 ring-stone-200">
        {bills.map((b) => (
          <li key={b.session_id}>
            <Link href={`/dashboard/bills/${b.session_id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-stone-50">
              <span className="font-semibold">{tableName(b)}</span>
              <span className="text-sm text-stone-500">{b.orders.length} order{b.orders.length === 1 ? '' : 's'}</span>
              <span className="ml-auto text-right">
                <span className="block font-semibold tabular-nums">{b.due_minor ? `${money(b.due_minor)} due` : money(b.total_minor)}</span>
                {b.paid_minor ? <span className="block text-xs text-emerald-700">{money(b.paid_minor)} paid</span> : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
