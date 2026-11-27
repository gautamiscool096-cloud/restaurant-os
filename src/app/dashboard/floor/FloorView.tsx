'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/money';
import { STATUS_PILL, agoLabel, friendlyError, minutesSince, useBoard, type BoardTable } from '@/lib/board';
import type { OrderStatus } from '@/lib/menu-types';
import { LiveBadge } from '../LiveBadge';
import { SinceApproval, StageTimeline } from '../OrderTimer';
import { currentStage, sinceApproval } from '@/lib/timers';

// What a table is "doing", most urgent first.
const PRIORITY: OrderStatus[] = ['pending', 'ready', 'preparing', 'approved', 'served'];

function tableState(t: BoardTable) {
  if (!t.session) return { key: 'free' as const, label: 'Free' };
  const statuses = new Set(t.orders.map((o) => o.status));
  const top = PRIORITY.find((s) => statuses.has(s));
  if (!top) return { key: 'seated' as const, label: 'Seated' };
  const n = t.orders.filter((o) => o.status === top).length;
  return { key: top, label: top === 'pending' ? `${n} new order${n > 1 ? 's' : ''}` : STATUS_PILL[top].label };
}

const TILE: Record<string, string> = {
  free: 'bg-white ring-stone-200 text-stone-500',
  seated: 'bg-stone-100 ring-stone-300',
  pending: 'bg-amber-50 ring-amber-400',
  approved: 'bg-sky-50 ring-sky-300',
  preparing: 'bg-violet-50 ring-violet-300',
  ready: 'bg-teal-50 ring-teal-400',
  served: 'bg-emerald-50 ring-emerald-300',
};

export function FloorView({ currency }: { currency: string }) {
  const { tables, error, live, now, refresh } = useBoard();
  const [openId, setOpenId] = useState<string | null>(null);
  const money = (m: number) => formatMoney(m, currency);
  const selected = tables?.find((t) => t.table_id === openId) ?? null;
  const occupied = (tables ?? []).filter((t) => t.session).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Floor</h1>
          {tables ? <p className="text-sm text-stone-500">{occupied} of {tables.length} tables occupied</p> : null}
        </div>
        <LiveBadge live={live} />
      </div>
      {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {tables === null ? <p className="py-10 text-center text-stone-500">Loading tables…</p> : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {(tables ?? []).map((t) => {
          const st = tableState(t);
          const bill = t.orders.filter((o) => o.status !== 'rejected' && o.status !== 'cancelled').reduce((n, o) => n + o.total_minor, 0);
          const oldestPending = t.orders.find((o) => o.status === 'pending');
          // the order that has been running longest since approval
          const running = t.orders
            .filter((o) => o.status === 'approved' || o.status === 'preparing' || o.status === 'ready')
            .sort((a, b) => (a.approved_at ?? '').localeCompare(b.approved_at ?? ''))[0];
          const stuck = t.orders.some((o) => o.status !== 'served' && currentStage(o, now)?.level === 'late')
            || (running && sinceApproval(running, now)?.level === 'late');
          const late = (oldestPending && minutesSince(oldestPending.created_at, now) >= 5) || stuck;
          return (
            <button key={t.table_id} type="button" onClick={() => setOpenId(t.table_id)}
                    aria-label={`${t.label ?? `Table ${t.number}`}: ${st.label}`}
                    className={`flex min-h-28 flex-col rounded-2xl p-3 text-left ring-2 transition hover:shadow-md ${stuck ? 'bg-red-50 ring-red-400' : TILE[st.key]} ${late ? 'animate-pulse' : ''}`}>
              <span className="text-lg font-semibold text-stone-900">{t.label ?? `Table ${t.number}`}</span>
              <span className="text-sm font-medium">{st.label}</span>
              {running ? <span className="mt-1"><SinceApproval order={running} now={now} /></span> : null}
              {t.session ? (
                <span className="mt-auto pt-2 text-xs text-stone-600">
                  {money(bill)} · {agoLabel(t.session.last_activity_at, now)}
                </span>
              ) : <span className="mt-auto pt-2 text-xs">{t.seats} seats</span>}
            </button>
          );
        })}
      </div>

      {selected ? <TablePanel table={selected} money={money} now={now} onClose={() => setOpenId(null)} onChanged={refresh} /> : null}
    </div>
  );
}

function TablePanel({
  table: t, money, now, onClose, onChanged,
}: { table: BoardTable; money: (m: number) => string; now: number; onClose: () => void; onChanged: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const live = t.orders.filter((o) => o.status !== 'rejected' && o.status !== 'cancelled');
  const bill = live.reduce((n, o) => n + o.total_minor, 0);
  const unfinished = live.some((o) => o.status !== 'served');

  async function closeTable() {
    if (!t.session) return;
    setBusy(true);
    const { error } = await createClient().rpc('close_table_session', { p_session_id: t.session.id });
    setBusy(false);
    if (error) return setErr(friendlyError(error.message));
    setConfirming(false);
    await onChanged();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/30" role="dialog" aria-modal="true" aria-label={`${t.label ?? `Table ${t.number}`} details`}>
      <button type="button" aria-label="Close panel" className="flex-1" onClick={onClose} />
      <aside className="flex w-full max-w-md flex-col bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-stone-100 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold">{t.label ?? `Table ${t.number}`}</h2>
            <p className="text-sm text-stone-500">
              {t.session ? `Seated ${agoLabel(t.session.opened_at, now)} · last activity ${agoLabel(t.session.last_activity_at, now)}` : 'Free'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-stone-500 hover:bg-stone-100">Close</button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {!t.session ? <p className="text-stone-500">No guests at this table right now.</p> : null}
          {t.orders.map((o) => (
            <div key={o.id} className="rounded-xl border border-stone-200 p-3">
              <div className="flex items-center gap-2">
                <span className="font-semibold">#{o.order_number}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${STATUS_PILL[o.status].className}`}>{STATUS_PILL[o.status].label}</span>
                <span className="ml-auto flex items-center gap-2 text-sm text-stone-500">
                  <SinceApproval order={o} now={now} />
                  {money(o.total_minor)}
                </span>
              </div>
              <div className="mt-1.5"><StageTimeline order={o} /></div>
              <ul className="mt-2 space-y-0.5 text-sm text-stone-700">
                {o.items.map((i) => <li key={i.id} className={i.status === 'cancelled' ? 'line-through opacity-50' : ''}>{i.quantity} × {i.name}</li>)}
              </ul>
            </div>
          ))}
          {t.orders.some((o) => o.status === 'pending') ? (
            <Link href="/dashboard/orders" className="block text-sm font-medium text-amber-700 underline">Approve new orders →</Link>
          ) : null}
        </div>
        {t.session ? (
          <footer className="space-y-2 border-t border-stone-100 px-5 py-4">
            <div className="flex justify-between font-semibold"><span>Bill</span><span>{money(bill)}</span></div>
            <Link href={`/dashboard/bills/${t.session.id}`} className="block text-sm font-medium text-stone-700 underline">Open bill and take payment →</Link>
            {err ? <p role="alert" className="text-sm text-red-700">{err}</p> : null}
            {confirming ? (
              <div className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                <p>{unfinished ? 'Some food has not been served yet. ' : ''}Make sure the bill is settled. Closing frees the table for the next guests, and their phones can no longer add to this order.</p>
                <div className="flex gap-2">
                  <button type="button" disabled={busy} onClick={closeTable}
                          className="rounded-lg bg-stone-900 px-4 py-2 font-semibold text-white disabled:opacity-50">Yes, free the table</button>
                  <button type="button" onClick={() => setConfirming(false)} className="rounded-lg px-4 py-2">Cancel</button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirming(true)}
                      className="w-full rounded-lg px-4 py-2.5 font-medium ring-1 ring-stone-300 hover:bg-stone-50">Guests left: free this table</button>
            )}
          </footer>
        ) : null}
      </aside>
    </div>
  );
}
