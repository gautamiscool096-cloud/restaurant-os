// Speed-of-service timers. Pure functions so they can be unit tested and
// shared by the manager, kitchen and waiter screens.

export type TimedOrder = {
  status: string;
  created_at: string;
  approved_at: string | null;
  preparing_at: string | null;
  ready_at: string | null;
  served_at: string | null;
};

export type Level = 'ok' | 'warn' | 'late';

/**
 * Minutes after which a stage turns amber (warn) and red (late).
 * Defaults for now; later these become per-restaurant settings.
 */
export const LIMITS = {
  pending: { warn: 3, late: 5, label: 'Waiting for approval' },
  approved: { warn: 5, late: 10, label: 'Waiting for the kitchen' },
  preparing: { warn: 15, late: 25, label: 'Cooking' },
  ready: { warn: 3, late: 6, label: 'Ready, waiting to be served' },
} as const;

/** Whole order, from approval to served. */
export const TOTAL_LIMIT = { warn: 20, late: 30 };

const ms = (iso: string | null) => (iso ? new Date(iso).getTime() : null);

export function levelFor(minutes: number, limit: { warn: number; late: number }): Level {
  if (minutes >= limit.late) return 'late';
  if (minutes >= limit.warn) return 'warn';
  return 'ok';
}

/** "4:07" under an hour, "1:02:07" above. Never negative. */
export function clock(fromMs: number, toMs: number) {
  const total = Math.max(0, Math.floor((toMs - fromMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Short duration for a finished stage: "45 s", "12 min", "1 h 5 min". */
export function duration(fromMs: number, toMs: number) {
  const sec = Math.max(0, Math.round((toMs - fromMs) / 1000));
  if (sec < 60) return `${sec} s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The stage an order is in right now, when it started and how late it is. */
export function currentStage(o: TimedOrder, now: number) {
  const key = o.status as keyof typeof LIMITS;
  if (!(key in LIMITS)) return null;
  const startIso = { pending: o.created_at, approved: o.approved_at, preparing: o.preparing_at, ready: o.ready_at }[key]
    ?? o.approved_at ?? o.created_at;
  const start = ms(startIso)!;
  const minutes = (now - start) / 60_000;
  return { key, label: LIMITS[key].label, start, minutes, level: levelFor(minutes, LIMITS[key]) };
}

/** Time since approval (stops when served), with its own colour. */
export function sinceApproval(o: TimedOrder, now: number) {
  const start = ms(o.approved_at);
  if (start === null) return null;
  const end = ms(o.served_at) ?? now;
  const minutes = (end - start) / 60_000;
  return { start, end, running: o.served_at === null, minutes, level: levelFor(minutes, TOTAL_LIMIT) };
}

export type Step = { key: 'approved' | 'preparing' | 'ready' | 'served'; label: string; at: number | null; took: string | null };

/**
 * The order's journey: when each step happened and how long the step
 * before it took. A skipped step (e.g. served straight from approved) has
 * no time.
 */
export function steps(o: TimedOrder): Step[] {
  const raw: [Step['key'], string, number | null][] = [
    ['approved', 'Approved', ms(o.approved_at)],
    ['preparing', 'Cooking', ms(o.preparing_at)],
    ['ready', 'Ready', ms(o.ready_at)],
    ['served', 'Served', ms(o.served_at)],
  ];
  let prev = ms(o.created_at)!;
  return raw.map(([key, label, at]) => {
    const took = at !== null ? duration(prev, at) : null;
    if (at !== null) prev = at;
    return { key, label, at, took };
  });
}

export const LEVEL_STYLE: Record<Level, string> = {
  ok: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  warn: 'bg-amber-100 text-amber-900 ring-amber-400',
  late: 'bg-red-100 text-red-800 ring-red-400',
};
