'use client';

import { LEVEL_STYLE, clock, currentStage, sinceApproval, steps, type TimedOrder } from '@/lib/timers';

/** Big running clock since approval, coloured by how late the order is. */
export function SinceApproval({ order, now, size = 'md' }: { order: TimedOrder; now: number; size?: 'md' | 'lg' }) {
  const t = sinceApproval(order, now);
  if (!t) return null;
  const word = t.running ? (t.level === 'late' ? 'Late' : t.level === 'warn' ? 'Running slow' : 'On time') : 'Done in';
  return (
    <span data-timer="since-approval" data-level={t.level}
          title={t.running ? 'Time since the order was approved' : 'Approval to served'}
          className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 font-mono font-semibold tabular-nums ring-1 ${LEVEL_STYLE[t.level]} ${size === 'lg' ? 'text-lg' : 'text-sm'}`}>
      <span aria-hidden>⏱</span>
      <span className="sr-only">{word}: </span>
      {clock(t.start, t.end)}
    </span>
  );
}

/** "Cooking 12:04" – how long the order has been in its current stage. */
export function StageClock({ order, now }: { order: TimedOrder; now: number }) {
  const s = currentStage(order, now);
  if (!s) return null;
  return (
    <span data-timer="stage" data-level={s.level}
          className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium tabular-nums ring-1 ${LEVEL_STYLE[s.level]}`}>
      {s.label} · <span className="font-mono">{clock(s.start, now)}</span>
    </span>
  );
}

/**
 * Placed → Approved → Cooking → Ready → Served. The time on each arrow is
 * how long that gap took, e.g. "Cooking –12 min→ Ready" = 12 minutes of cooking.
 */
export function StageTimeline({ order }: { order: TimedOrder }) {
  if (!order.approved_at) return null;
  return (
    <ol aria-label="Order timeline" className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-stone-500">
      <li className="font-medium text-stone-700">Placed</li>
      {steps(order).map((s) => (
        <li key={s.key} className="flex items-center gap-1">
          <span aria-hidden className="text-stone-300">→</span>
          {s.took ? <span className="rounded bg-stone-100 px-1 tabular-nums text-stone-600">{s.took}</span> : null}
          {s.took ? <span aria-hidden className="text-stone-300">→</span> : null}
          <span className={s.at ? 'font-medium text-stone-700' : 'text-stone-400'}>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}
