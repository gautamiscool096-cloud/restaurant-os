'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/board';

type Step = 'preparing' | 'ready' | 'served';

export const NEXT_STEP: Partial<Record<string, { to: Step; label: string; className: string }>> = {
  approved: { to: 'preparing', label: 'Start cooking', className: 'bg-violet-600 hover:bg-violet-700' },
  preparing: { to: 'ready', label: 'Mark ready', className: 'bg-teal-600 hover:bg-teal-700' },
  ready: { to: 'served', label: 'Mark served', className: 'bg-emerald-600 hover:bg-emerald-700' },
};

/**
 * Moves an order one step on. The database decides whether the signed-in
 * role may take that step; the screens only offer the steps that fit.
 */
export function NextStepButton({
  order, onDone, to, label, big = false,
}: {
  order: { id: string; status: string; order_number: number };
  onDone: () => Promise<void> | void;
  to?: Step;
  label?: string;
  big?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const step = NEXT_STEP[order.status];
  const target = to ?? step?.to;
  if (!target || !step) return null;

  async function go() {
    setBusy(true);
    setErr(null);
    const { error } = await createClient().rpc('advance_order', { p_order_id: order.id, p_to: target });
    setBusy(false);
    if (error) {
      setErr(/fetch|network/i.test(error.message) ? 'No connection. Check the Wi-Fi and try again.' : friendlyError(error.message));
      return;
    }
    await onDone();
  }

  return (
    <div className="space-y-1">
      <button type="button" disabled={busy} onClick={go}
              aria-label={`${label ?? step.label}: order #${order.order_number}`}
              className={`w-full rounded-lg px-4 font-semibold text-white disabled:opacity-50 ${big ? 'py-3.5 text-lg' : 'py-2.5'} ${
                to === 'served' ? NEXT_STEP.ready!.className : step.className}`}>
        {busy ? 'Saving…' : label ?? step.label}
      </button>
      {err ? <p role="alert" className="text-sm text-red-700">{err}</p> : null}
    </div>
  );
}
