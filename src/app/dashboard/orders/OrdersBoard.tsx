'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/money';
import {
  STATUS_PILL, agoLabel, friendlyError, minutesSince, useBoard, type BoardOrder, type BoardTable,
} from '@/lib/board';
import { LiveBadge } from '../LiveBadge';
import { NextStepButton } from '../NextStepButton';
import { SinceApproval, StageClock, StageTimeline } from '../OrderTimer';

type Tab = 'new' | 'active' | 'all';
type MenuOption = { id: string; name: string; price_minor: number; is_available: boolean; category: string };

const ACTIVE: BoardOrder['status'][] = ['approved', 'preparing', 'ready'];

export function OrdersBoard({ currency }: { currency: string }) {
  const { tables, error, live, now, refresh } = useBoard();
  const [tab, setTab] = useState<Tab>('new');
  const money = (m: number) => formatMoney(m, currency);

  const counts = useMemo(() => {
    const all = (tables ?? []).flatMap((t) => t.orders);
    return {
      new: all.filter((o) => o.status === 'pending').length,
      active: all.filter((o) => ACTIVE.includes(o.status)).length,
      all: (tables ?? []).filter((t) => t.orders.length).length,
    };
  }, [tables]);

  // Show the number of new orders in the browser tab, so it is visible
  // even when the manager is on another tab.
  useEffect(() => {
    document.title = counts.new ? `(${counts.new}) New orders · Restaurant OS` : 'Orders · Restaurant OS';
  }, [counts.new]);

  const groups = (tables ?? [])
    .map((t) => ({
      table: t,
      orders: t.orders.filter((o) =>
        tab === 'new' ? o.status === 'pending' : tab === 'active' ? ACTIVE.includes(o.status) : true),
    }))
    .filter((g) => g.orders.length > 0)
    // tables with the oldest waiting order first
    .sort((a, b) => a.orders[0].created_at.localeCompare(b.orders[0].created_at));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
        <LiveBadge live={live} />
      </div>

      <div role="tablist" className="flex gap-2 overflow-x-auto">
        {([['new', 'New', counts.new], ['active', 'In progress', counts.active], ['all', 'All open tables', counts.all]] as const).map(([k, label, n]) => (
          <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k)}
                  className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium ${tab === k ? 'bg-stone-900 text-white' : 'bg-white text-stone-700 ring-1 ring-stone-200'}`}>
            {label}
            {n ? <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${tab === k ? 'bg-white/20' : k === 'new' ? 'bg-amber-500 text-white' : 'bg-stone-100'}`}>{n}</span> : null}
          </button>
        ))}
      </div>

      {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {tables === null ? <p className="py-10 text-center text-stone-500">Loading orders…</p> : null}
      {tables && groups.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 py-16 text-center text-stone-500">
          {tab === 'new' ? 'No new orders right now. New ones appear here automatically.' : 'Nothing here right now.'}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map(({ table, orders }) => (
          <section key={table.table_id} className="rounded-2xl border border-stone-200 bg-white" aria-label={tableName(table)}>
            <header className="flex items-center justify-between border-b border-stone-100 px-4 py-3">
              <h2 className="font-semibold">{tableName(table)}</h2>
              {table.session ? (
                <span className="text-sm text-stone-500">
                  Bill {money(table.orders.filter((o) => o.status !== 'rejected' && o.status !== 'cancelled').reduce((n, o) => n + o.total_minor, 0))}
                </span>
              ) : null}
            </header>
            <div className="divide-y divide-stone-100">
              {orders.map((o) => <OrderCard key={o.id} order={o} now={now} money={money} onChanged={refresh} />)}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function tableName(t: BoardTable) {
  return t.label ?? `Table ${t.number}`;
}

function OrderCard({
  order: o, now, money, onChanged,
}: { order: BoardOrder; now: number; money: (m: number) => string; onChanged: () => Promise<void> }) {
  const [mode, setMode] = useState<'view' | 'reject' | 'edit'>('view');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const waited = minutesSince(o.created_at, now);
  const pill = STATUS_PILL[o.status];

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setErr(null);
    const { error } = await fn();
    setBusy(false);
    if (error) return setErr(friendlyError(error.message));
    setMode('view');
    await onChanged();
  }
  const supabase = createClient();

  return (
    <article className={`space-y-3 px-4 py-4 ${o.status === 'pending' && waited >= 5 ? 'bg-amber-50/60' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">#{o.order_number}</span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${pill.className}`}>{pill.label}</span>
        {o.is_paid ? <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-700 ring-1 ring-stone-300">Paid</span> : null}
        {o.status === 'pending' ? (
          <span className={`ml-auto text-sm ${waited >= 5 ? 'font-medium text-amber-800' : 'text-stone-500'}`}>
            {agoLabel(o.created_at, now)}
          </span>
        ) : (
          <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            <StageClock order={o} now={now} />
            <SinceApproval order={o} now={now} />
          </span>
        )}
      </div>
      <StageTimeline order={o} />

      {mode === 'edit' ? (
        <EditOrder order={o} money={money} busy={busy}
                   onCancel={() => { setMode('view'); setErr(null); }}
                   onSave={(lines, add) => run(() => supabase.rpc('edit_order', { p_order_id: o.id, p_lines: lines, p_add: add }))} />
      ) : (
        <ul className="space-y-1.5">
          {o.items.map((i) => (
            <li key={i.id} className={`flex justify-between gap-3 text-sm ${i.status === 'cancelled' ? 'text-stone-400 line-through' : ''}`}>
              <span>
                <span className="font-medium">{i.quantity} ×</span> {i.name}
                {i.special_instructions ? (
                  <span className="mt-0.5 block rounded bg-yellow-50 px-1.5 py-0.5 text-xs font-medium text-yellow-900">
                    Note: {i.special_instructions}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-stone-600">{money(i.quantity * i.unit_price_minor)}</span>
            </li>
          ))}
        </ul>
      )}

      {o.customer_note && mode !== 'edit' ? (
        <p className="rounded-lg bg-yellow-50 px-3 py-2 text-sm text-yellow-900"><span className="font-medium">Guest note:</span> {o.customer_note}</p>
      ) : null}
      {o.rejected_reason ? <p className="text-sm text-red-700">Reason: {o.rejected_reason}</p> : null}
      {mode !== 'edit' ? <p className="text-right text-sm font-semibold">Total {money(o.total_minor)}</p> : null}
      {err ? <p role="alert" className="text-sm text-red-700">{err}</p> : null}

      {o.status === 'pending' && mode === 'view' ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => run(() => supabase.rpc('approve_order', { p_order_id: o.id }))}
                  className="flex-1 rounded-lg bg-emerald-600 px-4 py-2.5 font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
            Approve
          </button>
          <button type="button" disabled={busy} onClick={() => setMode('edit')}
                  className="rounded-lg px-4 py-2.5 font-medium text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50">Edit</button>
          <button type="button" disabled={busy} onClick={() => setMode('reject')}
                  className="rounded-lg px-4 py-2.5 font-medium text-red-700 ring-1 ring-red-200 hover:bg-red-50">Reject</button>
        </div>
      ) : null}

      {ACTIVE.includes(o.status) ? <NextStepButton order={o} onDone={onChanged} /> : null}

      {mode === 'reject' ? (
        <div className="space-y-2 rounded-lg bg-red-50 p-3">
          <label htmlFor={`reason-${o.id}`} className="block text-sm font-medium text-red-900">Reason (the guest will see that the order was not accepted)</label>
          <input id={`reason-${o.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200}
                 placeholder="e.g. Kitchen is closed" className="w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => run(() => supabase.rpc('reject_order', { p_order_id: o.id, p_reason: reason || null }))}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Reject order</button>
            <button type="button" onClick={() => setMode('view')} className="rounded-lg px-4 py-2 text-sm text-stone-700">Keep it</button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function EditOrder({
  order, money, busy, onCancel, onSave,
}: {
  order: BoardOrder;
  money: (m: number) => string;
  busy: boolean;
  onCancel: () => void;
  onSave: (lines: { order_item_id: string; quantity: number }[], add: { menu_item_id: string; quantity: number }[]) => void;
}) {
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(order.items.map((i) => [i.id, i.quantity])));
  const [adds, setAdds] = useState<{ menu_item_id: string; quantity: number }[]>([]);
  const [menu, setMenu] = useState<MenuOption[]>([]);
  const [pick, setPick] = useState('');

  useEffect(() => {
    void createClient().rpc('staff_menu').then(({ data }) => setMenu((data as MenuOption[]) ?? []));
  }, []);

  const byId = new Map(menu.map((m) => [m.id, m]));
  const subtotal = order.items.reduce((n, i) => n + (qty[i.id] ?? 0) * i.unit_price_minor, 0)
    + adds.reduce((n, a) => n + a.quantity * (byId.get(a.menu_item_id)?.price_minor ?? 0), 0);

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {order.items.map((i) => (
          <li key={i.id} className="flex items-center gap-3 text-sm">
            <span className={`flex-1 ${qty[i.id] === 0 ? 'text-stone-400 line-through' : ''}`}>{i.name}</span>
            <QtyInput value={qty[i.id] ?? 0} onChange={(n) => setQty((q) => ({ ...q, [i.id]: n }))} label={i.name} />
          </li>
        ))}
        {adds.map((a, idx) => (
          <li key={`add-${idx}`} className="flex items-center gap-3 text-sm">
            <span className="flex-1">{byId.get(a.menu_item_id)?.name} <span className="text-xs text-emerald-700">(added)</span></span>
            <QtyInput value={a.quantity} label={byId.get(a.menu_item_id)?.name ?? 'item'}
                      onChange={(n) => setAdds((xs) => n === 0 ? xs.filter((_, j) => j !== idx) : xs.map((x, j) => (j === idx ? { ...x, quantity: n } : x)))} />
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Add a dish"
                className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-2 py-2 text-sm">
          <option value="">Add a dish…</option>
          {menu.filter((m) => m.is_available).map((m) => <option key={m.id} value={m.id}>{m.name} · {money(m.price_minor)}</option>)}
        </select>
        <button type="button" disabled={!pick} onClick={() => { setAdds((xs) => [...xs, { menu_item_id: pick, quantity: 1 }]); setPick(''); }}
                className="rounded-lg px-3 py-2 text-sm font-medium ring-1 ring-stone-300 disabled:opacity-40">Add</button>
      </div>
      <p className="text-right text-sm text-stone-600">New items total {money(subtotal)} <span className="text-xs">(before tax and service)</span></p>
      <div className="flex gap-2">
        <button type="button" disabled={busy}
                onClick={() => onSave(
                  order.items.filter((i) => qty[i.id] !== i.quantity).map((i) => ({ order_item_id: i.id, quantity: qty[i.id] ?? 0 })),
                  adds)}
                className="flex-1 rounded-lg bg-stone-900 px-4 py-2.5 font-semibold text-white disabled:opacity-50">Save changes</button>
        <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2.5 text-stone-700 ring-1 ring-stone-300">Cancel</button>
      </div>
    </div>
  );
}

function QtyInput({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <span className="inline-flex items-center rounded-lg ring-1 ring-stone-300">
      <button type="button" aria-label={`One less ${label}`} onClick={() => onChange(Math.max(0, value - 1))} className="px-2.5 py-1">−</button>
      <span className="w-6 text-center font-medium">{value}</span>
      <button type="button" aria-label={`One more ${label}`} onClick={() => onChange(Math.min(99, value + 1))} className="px-2.5 py-1">+</button>
    </span>
  );
}
