'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/money';
import { LEVEL_STYLE, LIMITS, TOTAL_LIMIT, levelFor } from '@/lib/timers';

type Stat = { avg: number | null; median: number | null; n: number };
type Analytics = {
  range: { from: string; to: string; timezone: string };
  totals: { sales_minor: number; orders: number; avg_order_minor: number; tables_served: number; collected_minor: number; rejected: number; items_sold: number };
  by_day: { day: string; orders: number; sales_minor: number }[];
  by_hour: { hour: number; orders: number }[];
  top_items: { name: string; quantity: number; sales_minor: number }[];
  slow_items: { name: string; quantity: number }[];
  payments: { cash_minor: number; online_minor: number; platform_fee_minor: number };
  speed: { to_approve: Stat; to_start: Stat; cooking: Stat; to_serve: Stat; total: Stat; late_orders: number; slow_orders: number };
  rejections: { reason: string; count: number }[];
  reviews: { count: number; average: number | null; by_rating: Record<string, number>; latest: { rating: number; comment: string; created_at: string }[] };
};

const RANGES = [{ days: 1, label: 'Today' }, { days: 7, label: 'Last 7 days' }, { days: 30, label: 'Last 30 days' }] as const;
const BAR = 'bg-teal-600 dark:bg-teal-400';

export function AnalyticsView({ currency }: { currency: string }) {
  const [days, setDays] = useState<number>(7);
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const money = (m: number) => formatMoney(m, currency);

  useEffect(() => {
    let live = true;
    void createClient().rpc('restaurant_analytics_recent', { p_days: days }).then(({ data: d, error: e }) => {
      if (!live) return;
      setError(e ? 'Could not load analytics.' : null);
      if (d) setData(d as Analytics);
    });
    return () => { live = false; };
  }, [days]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <div role="tablist" aria-label="Date range" className="flex gap-2">
          {RANGES.map((r) => (
            <button key={r.days} role="tab" type="button" aria-selected={days === r.days} onClick={() => setDays(r.days)}
                    className={`rounded-full px-4 py-2 text-sm font-medium ${days === r.days ? 'bg-stone-900 text-white' : 'bg-white text-stone-700 ring-1 ring-stone-200'}`}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {!data ? <p className="py-10 text-center text-stone-500">Loading…</p> : <Report a={data} money={money} />}
    </div>
  );
}

function Report({ a, money }: { a: Analytics; money: (m: number) => string }) {
  const t = a.totals;
  const paidTotal = a.payments.cash_minor + a.payments.online_minor;
  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Sales" value={money(t.sales_minor)} note={`${t.orders} orders`} />
        <Tile label="Average order" value={money(t.avg_order_minor)} note={`${t.items_sold} dishes sold`} />
        <Tile label="Money collected" value={money(t.collected_minor)} note={`${t.tables_served} tables served`} />
        <Tile label="Guest rating" value={a.reviews.average ? `${Number(a.reviews.average).toFixed(1)} ★` : '—'}
              note={`${a.reviews.count} review${a.reviews.count === 1 ? '' : 's'}`} />
      </section>

      {a.by_day.length > 1 ? (
        <Card title="Sales by day">
          <Bars label="Sales by day" rows={a.by_day.map((d, i, all) => ({
            key: d.day, value: d.sales_minor,
            tick: all.length <= 10 || i % 5 === 0 || i === all.length - 1
              ? new Date(`${d.day}T00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '',
            tip: `${new Date(`${d.day}T00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}: ${money(d.sales_minor)} · ${d.orders} orders`,
          }))} />
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Speed of service" subtitle="Average minutes per step. Amber or red means slower than your target.">
          <SpeedTable a={a} />
        </Card>
        <Card title="Busy hours" subtitle="Orders by the hour they were placed">
          <Bars label="Orders by hour" rows={a.by_hour.filter((h) => h.hour >= 8).map((h) => ({
            key: String(h.hour), value: h.orders, tick: h.hour % 3 === 0 ? `${((h.hour + 11) % 12) + 1}${h.hour < 12 ? 'a' : 'p'}` : '',
            tip: `${String(h.hour).padStart(2, '0')}:00–${String(h.hour).padStart(2, '0')}:59 · ${h.orders} orders`,
          }))} />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Best sellers">
          {a.top_items.length ? (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-stone-500"><th className="pb-2 font-medium">Dish</th><th className="pb-2 text-right font-medium">Sold</th><th className="pb-2 text-right font-medium">Sales</th></tr></thead>
              <tbody className="divide-y divide-stone-100">
                {a.top_items.map((i) => (
                  <tr key={i.name}><td className="py-1.5 pr-2">{i.name}</td><td className="py-1.5 text-right tabular-nums">{i.quantity}</td><td className="py-1.5 text-right tabular-nums">{money(i.sales_minor)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <Empty />}
          {a.slow_items.length ? (
            <p className="mt-3 text-sm text-stone-600"><span className="font-medium">Hardly ordered:</span> {a.slow_items.map((i) => i.name).join(', ')}. Consider promoting or removing them.</p>
          ) : null}
        </Card>
        <Card title="How guests paid">
          {paidTotal ? (
            <div className="space-y-3">
              <div className="flex h-3 gap-0.5 overflow-hidden rounded" role="img"
                   aria-label={`Cash ${money(a.payments.cash_minor)}, online ${money(a.payments.online_minor)}`}>
                <div className="rounded-l bg-stone-500" style={{ width: `${(a.payments.cash_minor / paidTotal) * 100}%` }} title={`At the table: ${money(a.payments.cash_minor)}`} />
                <div className="rounded-r bg-teal-600" style={{ width: `${(a.payments.online_minor / paidTotal) * 100}%` }} title={`Online: ${money(a.payments.online_minor)}`} />
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <Legend swatch="bg-stone-500" label="At the table" value={money(a.payments.cash_minor)} pct={a.payments.cash_minor / paidTotal} />
                <Legend swatch="bg-teal-600" label="Online" value={money(a.payments.online_minor)} pct={a.payments.online_minor / paidTotal} />
              </dl>
              {a.payments.platform_fee_minor ? <p className="text-xs text-stone-500">Platform fee on online payments: {money(a.payments.platform_fee_minor)}</p> : null}
            </div>
          ) : <Empty />}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="What guests said">
          {a.reviews.count ? (
            <div className="space-y-3">
              <ul className="space-y-1 text-sm">
                {[5, 4, 3, 2, 1].map((r) => {
                  const n = a.reviews.by_rating[String(r)] ?? 0;
                  return (
                    <li key={r} className="flex items-center gap-2">
                      <span className="w-8 tabular-nums">{r} ★</span>
                      <span className="h-2 flex-1 rounded bg-stone-100"><span className={`block h-2 rounded ${BAR}`} style={{ width: `${(n / a.reviews.count) * 100}%` }} /></span>
                      <span className="w-8 text-right tabular-nums text-stone-600">{n}</span>
                    </li>
                  );
                })}
              </ul>
              <ul className="space-y-2">
                {a.reviews.latest.map((r, i) => (
                  <li key={i} className="rounded-lg bg-stone-50 px-3 py-2 text-sm"><span className="font-medium">{r.rating} ★</span> “{r.comment}”</li>
                ))}
              </ul>
            </div>
          ) : <Empty text="No reviews in this period." />}
        </Card>
        <Card title="Orders turned away">
          {a.totals.rejected ? (
            <ul className="space-y-1 text-sm">
              {a.rejections.map((r) => <li key={r.reason} className="flex justify-between"><span>{r.reason}</span><span className="tabular-nums">{r.count}</span></li>)}
            </ul>
          ) : <Empty text="No orders were rejected." />}
        </Card>
      </div>
    </>
  );
}

function SpeedTable({ a }: { a: Analytics }) {
  const rows: [string, Stat, { warn: number; late: number }][] = [
    ['Approving new orders', a.speed.to_approve, LIMITS.pending],
    ['Kitchen starting', a.speed.to_start, LIMITS.approved],
    ['Cooking', a.speed.cooking, LIMITS.preparing],
    ['Carrying to the table', a.speed.to_serve, LIMITS.ready],
    ['Approval to served', a.speed.total, TOTAL_LIMIT],
  ];
  if (!a.speed.total.n && !a.speed.to_approve.n) return <Empty />;
  return (
    <div className="space-y-3">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-stone-500"><th className="pb-2 font-medium">Step</th><th className="pb-2 text-right font-medium">Average</th><th className="pb-2 text-right font-medium">Typical</th><th className="pb-2 text-right font-medium">Target</th></tr></thead>
        <tbody className="divide-y divide-stone-100">
          {rows.map(([label, s, lim]) => (
            <tr key={label}>
              <td className="py-1.5 pr-2">{label}</td>
              <td className="py-1.5 text-right">
                {s.avg === null ? '—' : (
                  <span data-level={levelFor(Number(s.avg), lim)} className={`rounded px-1.5 py-0.5 tabular-nums ring-1 ${LEVEL_STYLE[levelFor(Number(s.avg), lim)]}`}>{Number(s.avg).toFixed(1)} min</span>
                )}
              </td>
              <td className="py-1.5 text-right tabular-nums text-stone-600">{s.median === null ? '—' : `${Number(s.median).toFixed(1)} min`}</td>
              <td className="py-1.5 text-right tabular-nums text-stone-500">under {lim.warn} min</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-sm text-stone-600">
        {a.speed.late_orders} order{a.speed.late_orders === 1 ? '' : 's'} took {TOTAL_LIMIT.late}+ minutes from approval to table, and {a.speed.slow_orders} took {TOTAL_LIMIT.warn}–{TOTAL_LIMIT.late} minutes.
      </p>
    </div>
  );
}

function Bars({ label, rows }: { label: string; rows: { key: string; value: number; tick: string; tip: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <figure aria-label={label}>
      <div className="flex h-36 items-end gap-0.5 border-b border-stone-200">
        {rows.map((r) => (
          <div key={r.key} className="group relative flex h-full flex-1 items-end" title={r.tip}>
            <div className={`w-full rounded-t ${BAR} ${r.value ? '' : 'opacity-0'}`} style={{ height: `${(r.value / max) * 100}%`, minHeight: r.value ? 2 : 0 }} />
            <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-stone-900 px-2 py-1 text-xs text-white group-hover:block">{r.tip}</span>
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-0.5 text-[10px] text-stone-500">
        {rows.map((r) => <span key={r.key} className="flex-1 overflow-visible whitespace-nowrap text-center">{r.tick}</span>)}
      </div>
      <table className="sr-only"><tbody>{rows.map((r) => <tr key={r.key}><td>{r.tip}</td></tr>)}</tbody></table>
    </figure>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-2xl bg-white p-4 ring-1 ring-stone-200">
      <p className="text-sm text-stone-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-stone-500">{note}</p>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="space-y-3 rounded-2xl bg-white p-4 ring-1 ring-stone-200">
      <div><h2 className="font-semibold">{title}</h2>{subtitle ? <p className="text-xs text-stone-500">{subtitle}</p> : null}</div>
      {children}
    </section>
  );
}

function Legend({ swatch, label, value, pct }: { swatch: string; label: string; value: string; pct: number }) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-stone-600"><span className={`size-2.5 rounded-sm ${swatch}`} />{label}</dt>
      <dd className="font-semibold tabular-nums">{value} <span className="text-xs font-normal text-stone-500">({Math.round(pct * 100)}%)</span></dd>
    </div>
  );
}

function Empty({ text = 'Nothing yet for this period.' }: { text?: string }) {
  return <p className="py-6 text-center text-sm text-stone-500">{text}</p>;
}
