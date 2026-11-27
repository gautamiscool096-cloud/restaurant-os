'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/money';
import { tableName, type Bill } from '@/lib/bill';
import { Receipt } from '@/components/Receipt';
import { PrintButton } from '@/components/PrintButton';

export function BillDesk({ sessionId, canFreeTable }: { sessionId: string; canFreeTable: boolean }) {
  const router = useRouter();
  const [bill, setBill] = useState<Bill | null | undefined>(undefined);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await createClient().rpc('staff_session_bill', { p_session_id: sessionId });
    setBill(error ? null : (data as Bill));
  }, [sessionId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load
    void load();
    // online payments arrive from the guest's phone, so keep the bill fresh
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 5_000);
    return () => clearInterval(id);
  }, [load]);

  if (bill === undefined) return <p className="py-10 text-center text-stone-500">Loading bill…</p>;
  if (bill === null) return <p className="py-10 text-center text-stone-500">This bill could not be found.</p>;
  const money = (m: number) => formatMoney(m, bill.restaurant.currency);

  async function takeCash(value: number) {
    setBusy(true);
    setMsg(null);
    const { data, error } = await createClient().rpc('record_cash_payment', { p_session_id: sessionId, p_amount_minor: value });
    setBusy(false);
    if (error) {
      setMsg({ kind: 'err', text: /more than/.test(error.message) ? 'That is more than the amount due.' : 'Could not record the payment. Please try again.' });
      return;
    }
    setBill(data as Bill);
    setAmount('');
    setMsg({ kind: 'ok', text: `Recorded ${money(value)}.` });
  }

  async function freeTable() {
    setBusy(true);
    const { error } = await createClient().rpc('close_table_session', { p_session_id: sessionId });
    setBusy(false);
    if (error) return setMsg({ kind: 'err', text: 'Could not free the table.' });
    router.push('/dashboard/bills');
  }

  const typed = Math.round(Number(amount) * 100);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
          <div>
            <Link href="/dashboard/bills" className="text-sm text-stone-500 hover:underline">← All bills</Link>
            <h1 className="text-2xl font-semibold tracking-tight">{tableName(bill)} bill</h1>
          </div>
          <PrintButton />
        </div>
        <Receipt bill={bill} />
      </div>

      <aside className="space-y-4 print:hidden">
        <section className="space-y-3 rounded-2xl bg-white p-4 ring-1 ring-stone-200">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">Amount due</h2>
            <span className="text-2xl font-semibold tabular-nums" data-testid="due">{money(bill.due_minor)}</span>
          </div>
          {bill.due_minor > 0 ? (
            <>
              <button type="button" disabled={busy} onClick={() => takeCash(bill.due_minor)}
                      className="w-full rounded-lg bg-emerald-600 px-4 py-3 font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                Paid in full at the table ({money(bill.due_minor)})
              </button>
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (typed > 0) void takeCash(typed); }}>
                <label htmlFor="part" className="sr-only">Part payment amount</label>
                <input id="part" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                       placeholder="Part payment, e.g. 500" className="min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-2" />
                <button disabled={busy || !(typed > 0)} className="rounded-lg px-4 py-2 font-medium ring-1 ring-stone-300 disabled:opacity-40">Record</button>
              </form>
              <p className="text-xs text-stone-500">Use this for cash, card machine or UPI paid at the table. Guests can also pay online from their phone; that shows up here on its own.</p>
            </>
          ) : bill.total_minor > 0 ? (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 font-medium text-emerald-800">Fully paid.</p>
          ) : (
            <p className="text-sm text-stone-500">Nothing to pay yet: no order has been approved.</p>
          )}
          {msg ? <p role={msg.kind === 'err' ? 'alert' : 'status'} className={`text-sm ${msg.kind === 'err' ? 'text-red-700' : 'text-emerald-700'}`}>{msg.text}</p> : null}
        </section>
        {canFreeTable && bill.status === 'open' && bill.due_minor === 0 && bill.total_minor > 0 ? (
          <button type="button" disabled={busy} onClick={freeTable}
                  className="w-full rounded-lg px-4 py-2.5 font-medium ring-1 ring-stone-300 hover:bg-stone-50">
            Guests left: free this table
          </button>
        ) : null}
      </aside>
    </div>
  );
}
