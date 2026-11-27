'use client';

import { useEffect, useRef } from 'react';
import { agoLabel, useBoard, type BoardOrder } from '@/lib/board';
import { LiveBadge } from '../LiveBadge';
import { NextStepButton } from '../NextStepButton';
import { SinceApproval, StageClock } from '../OrderTimer';

type Row = BoardOrder & { table: string };

export function ServiceView() {
  const { tables, error, live, now, refresh, offline } = useBoard();
  const rows: Row[] = (tables ?? []).flatMap((t) => t.orders.map((o) => ({ ...o, table: t.label ?? `Table ${t.number}` })));
  const byOldest = (a: Row, b: Row) => (a.approved_at ?? a.created_at).localeCompare(b.approved_at ?? b.created_at);
  const ready = rows.filter((o) => o.status === 'ready').sort((a, b) => (a.ready_at ?? '').localeCompare(b.ready_at ?? ''));
  const cooking = rows.filter((o) => o.status === 'approved' || o.status === 'preparing').sort(byOldest);
  const pending = rows.filter((o) => o.status === 'pending').sort(byOldest);

  const readyCount = ready.length;
  useEffect(() => {
    document.title = readyCount ? `(${readyCount}) Ready to serve · Restaurant OS` : 'Service · Restaurant OS';
  }, [readyCount]);

  // buzz the phone when a new order becomes ready
  const readyIds = tables ? ready.map((o) => o.id).join(',') : null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (readyIds === null) return;
    const before = seen.current;
    seen.current = readyIds;
    if (before !== null && readyIds.split(',').some((x) => x && !before.split(',').includes(x)) && 'vibrate' in navigator) {
      navigator.vibrate(200);
    }
  }, [readyIds]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Service</h1>
        <LiveBadge live={live} />
      </div>
      {offline ? (
        <p role="status" className="rounded-lg bg-red-600 px-4 py-3 font-medium text-white">
          No internet. Showing the last orders we had.
        </p>
      ) : error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {tables === null ? <p className="py-10 text-center text-stone-500">Loading…</p> : null}

      <section aria-label="Ready to serve" className="space-y-3">
        <h2 className="text-lg font-semibold">Ready to serve <span className="text-stone-400">({ready.length})</span></h2>
        {tables && ready.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-stone-300 py-8 text-center text-stone-500">Nothing to pick up right now.</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ready.map((o) => (
            <article key={o.id} aria-label={`Order #${o.order_number}, ${o.table}`}
                     className="space-y-3 rounded-2xl bg-teal-50 p-4 ring-2 ring-teal-400">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xl font-bold">{o.table}</span>
                <span className="text-stone-500">#{o.order_number}</span>
                <span className="ml-auto"><SinceApproval order={o} now={now} /></span>
              </div>
              <StageClock order={o} now={now} />
              <Items order={o} />
              <NextStepButton order={o} onDone={refresh} big />
            </article>
          ))}
        </div>
      </section>

      <section aria-label="In the kitchen" className="space-y-3">
        <h2 className="text-lg font-semibold">In the kitchen <span className="text-stone-400">({cooking.length})</span></h2>
        <ul className="divide-y divide-stone-100 rounded-2xl bg-white ring-1 ring-stone-200">
          {cooking.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
              <span className="font-semibold">{o.table}</span>
              <span className="text-sm text-stone-500">#{o.order_number}</span>
              <span className="ml-auto flex flex-wrap items-center gap-1.5">
                <StageClock order={o} now={now} />
                <SinceApproval order={o} now={now} />
              </span>
            </li>
          ))}
          {tables && cooking.length === 0 ? <li className="px-4 py-4 text-sm text-stone-500">Nothing cooking.</li> : null}
        </ul>
      </section>

      {pending.length ? (
        <section aria-label="Waiting for approval" className="space-y-2">
          <h2 className="text-lg font-semibold">Waiting for the manager <span className="text-stone-400">({pending.length})</span></h2>
          <ul className="space-y-1 text-sm text-stone-600">
            {pending.map((o) => <li key={o.id}>{o.table} · #{o.order_number} · placed {agoLabel(o.created_at, now)}</li>)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Items({ order }: { order: BoardOrder }) {
  return (
    <ul className="space-y-1">
      {order.items.filter((i) => i.status !== 'cancelled').map((i) => (
        <li key={i.id}><span className="font-semibold">{i.quantity} ×</span> {i.name}</li>
      ))}
    </ul>
  );
}
