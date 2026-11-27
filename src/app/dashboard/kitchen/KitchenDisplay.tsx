'use client';

import { useEffect, useRef } from 'react';
import { useBoard, type BoardOrder, type BoardTable } from '@/lib/board';
import { LiveBadge } from '../LiveBadge';
import { NextStepButton } from '../NextStepButton';
import { SinceApproval, StageClock } from '../OrderTimer';

type Ticket = BoardOrder & { table: string };

const COLUMNS = [
  { status: 'approved', title: 'To cook', empty: 'No new tickets.' },
  { status: 'preparing', title: 'Cooking', empty: 'Nothing on the stove.' },
  { status: 'ready', title: 'Ready for pickup', empty: 'Nothing waiting for a waiter.' },
] as const;

export function KitchenDisplay({ canServe }: { canServe: boolean }) {
  const { tables, error, live, now, refresh, offline } = useBoard();
  const tickets: Ticket[] = (tables ?? []).flatMap((t: BoardTable) =>
    t.orders.map((o) => ({ ...o, table: t.label ?? `Table ${t.number}` })));

  // Count tickets waiting to be cooked in the browser tab.
  const toCook = tickets.filter((o) => o.status === 'approved').length;
  useEffect(() => {
    document.title = toCook ? `(${toCook}) To cook · Kitchen` : 'Kitchen · Restaurant OS';
  }, [toCook]);

  // short beep when a new ticket arrives (browsers allow sound after the first tap on the page)
  const newIds = tables ? tickets.filter((o) => o.status === 'approved').map((o) => o.id).join(',') : null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (newIds === null) return;
    const before = seen.current;
    seen.current = newIds;
    if (before !== null && newIds.split(',').some((x) => x && !before.split(',').includes(x))) beep();
  }, [newIds]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Kitchen</h1>
        <LiveBadge live={live} />
      </div>
      {offline ? (
        <p role="status" className="rounded-lg bg-red-600 px-4 py-3 font-medium text-white">
          No internet. Showing the last orders we had. Buttons will work again as soon as the connection is back.
        </p>
      ) : error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {tables === null ? <p className="py-10 text-center text-stone-500">Loading tickets…</p> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {COLUMNS.map((col) => {
          const list = tickets
            .filter((o) => o.status === col.status)
            .sort((a, b) => (a.approved_at ?? a.created_at).localeCompare(b.approved_at ?? b.created_at));
          return (
            <section key={col.status} aria-label={col.title} className="space-y-3 rounded-2xl bg-stone-100 p-3">
              <h2 className="flex items-center justify-between px-1 font-semibold">
                {col.title}
                <span className="rounded-full bg-white px-2.5 py-0.5 text-sm ring-1 ring-stone-200">{list.length}</span>
              </h2>
              {tables && list.length === 0 ? <p className="px-1 py-6 text-center text-sm text-stone-500">{col.empty}</p> : null}
              {list.map((o) => (
                <article key={o.id} aria-label={`Order #${o.order_number}, ${o.table}`}
                         className="space-y-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-stone-200">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-lg font-bold">{o.table}</span>
                    <span className="text-stone-500">#{o.order_number}</span>
                    <span className="ml-auto"><SinceApproval order={o} now={now} size="lg" /></span>
                  </div>
                  <StageClock order={o} now={now} />
                  <ul className="space-y-1.5">
                    {o.items.filter((i) => i.status !== 'cancelled').map((i) => (
                      <li key={i.id} className="text-lg leading-snug">
                        <span className="font-bold">{i.quantity} ×</span> {i.name}
                        {i.special_instructions ? (
                          <span className="mt-0.5 block rounded bg-yellow-100 px-2 py-0.5 text-sm font-semibold text-yellow-900">
                            {i.special_instructions}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {o.customer_note ? (
                    <p className="rounded-lg bg-yellow-50 px-3 py-2 text-sm text-yellow-900"><span className="font-semibold">Guest note:</span> {o.customer_note}</p>
                  ) : null}
                  {col.status !== 'ready' || canServe
                    ? <NextStepButton order={o} onDone={refresh} big />
                    : <p className="text-center text-sm text-stone-500">Waiting for a waiter to pick up</p>}
                </article>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    osc.onended = () => void ctx.close();
  } catch {
    // no sound available; the screen still updates
  }
}
