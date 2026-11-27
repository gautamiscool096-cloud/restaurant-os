'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { OrderStatus } from '@/lib/menu-types';

export type BoardItem = {
  id: string;
  menu_item_id: string;
  name: string;
  quantity: number;
  unit_price_minor: number;
  special_instructions: string | null;
  status: 'pending' | 'preparing' | 'ready' | 'served' | 'cancelled';
};

export type BoardOrder = {
  id: string;
  order_number: number;
  status: OrderStatus;
  is_paid: boolean;
  customer_note: string | null;
  rejected_reason: string | null;
  subtotal_minor: number;
  service_charge_minor: number;
  tax_minor: number;
  total_minor: number;
  created_at: string;
  approved_at: string | null;
  by_staff: boolean;
  items: BoardItem[];
};

export type BoardTable = {
  table_id: string;
  number: number;
  label: string | null;
  seats: number;
  assigned_waiter_id: string | null;
  session: { id: string; opened_at: string; last_activity_at: string } | null;
  orders: BoardOrder[];
};

export type LiveState = 'connecting' | 'live' | 'polling';

const POLL_MS = 10_000;

/**
 * The restaurant's live board. Realtime `postgres_changes` events are
 * filtered by RLS on the server, so this only ever hears about its own
 * restaurant. A slow poll keeps the screen correct if the socket drops
 * (flaky Wi-Fi in a kitchen, laptop asleep, etc.).
 */
export function useBoard() {
  const [tables, setTables] = useState<BoardTable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState>('connecting');
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const { data, error: err } = await createClient().rpc('staff_board');
    if (err) {
      setError('Could not load orders. Retrying…');
      return;
    }
    setError(null);
    setTables(data as BoardTable[]);
  }, []);

  // Coalesce bursts of change events (an order + its items) into one fetch.
  const scheduleRefresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refresh(), 250);
  }, [refresh]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load
    void refresh();
    const supabase = createClient();
    const channel = supabase.channel('staff-board');
    for (const table of ['orders', 'order_items', 'table_sessions']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, scheduleRefresh);
    }
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') setLive('live');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setLive('polling');
    });
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
      void supabase.removeChannel(channel);
    };
  }, [refresh, scheduleRefresh]);

  return { tables, error, live, now, refresh };
}

export function minutesSince(iso: string, now: number) {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

export function agoLabel(iso: string, now: number) {
  const m = minutesSince(iso, now);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min ago`;
}

export const STATUS_PILL: Record<OrderStatus, { label: string; className: string }> = {
  pending:   { label: 'New',       className: 'bg-amber-100 text-amber-900 ring-amber-300' },
  approved:  { label: 'Approved',  className: 'bg-sky-100 text-sky-900 ring-sky-300' },
  preparing: { label: 'In kitchen', className: 'bg-violet-100 text-violet-900 ring-violet-300' },
  ready:     { label: 'Ready',     className: 'bg-teal-100 text-teal-900 ring-teal-300' },
  served:    { label: 'Served',    className: 'bg-emerald-100 text-emerald-900 ring-emerald-300' },
  rejected:  { label: 'Rejected',  className: 'bg-red-100 text-red-900 ring-red-300' },
  cancelled: { label: 'Cancelled', className: 'bg-stone-100 text-stone-600 ring-stone-300' },
};

export function friendlyError(message: string) {
  if (/no longer waiting/.test(message)) return 'Someone already handled this order.';
  if (/at least one item/.test(message)) return 'An order needs at least one item. Reject it instead.';
  if (/waiting for approval/.test(message)) return 'This order is already approved, so it can’t be edited.';
  if (/already free/.test(message)) return 'This table is already free.';
  return 'Something went wrong. Please try again.';
}
