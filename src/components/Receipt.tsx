import { formatMoney } from '@/lib/money';
import { paymentLabel, receiptNumber, tableName, type Bill } from '@/lib/bill';

/** Printable receipt; used by guests (their phone) and staff (print at the counter). */
export function Receipt({ bill: b }: { bill: Bill }) {
  const money = (m: number) => formatMoney(m, b.restaurant.currency);
  const s = b.settings;
  const when = new Date(b.closed_at ?? b.payments.at(-1)?.created_at ?? b.opened_at);
  return (
    <article aria-label="Receipt" className="mx-auto max-w-sm space-y-4 rounded-2xl bg-white p-6 font-mono text-sm text-stone-900 ring-1 ring-stone-200 print:max-w-none print:p-0 print:ring-0">
      <header className="space-y-1 text-center">
        <h1 className="font-sans text-lg font-semibold">{b.restaurant.name}</h1>
        {b.restaurant.address ? <p className="text-xs text-stone-600">{b.restaurant.address}</p> : null}
        <p className="text-xs text-stone-600">
          {receiptNumber(b)} · {tableName(b)} · {when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
        </p>
      </header>
      <table className="w-full">
        <thead className="sr-only"><tr><th>Item</th><th>Amount</th></tr></thead>
        <tbody>
          {(b.lines ?? []).map((l) => (
            <tr key={`${l.name}-${l.unit_price_minor}`} className="align-top">
              <td className="py-0.5 pr-2">{l.quantity} × {l.name}</td>
              <td className="py-0.5 text-right tabular-nums">{money(l.amount_minor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="space-y-0.5 border-t border-dashed border-stone-300 pt-2">
        <Row label="Subtotal" value={money(b.subtotal_minor)} />
        {b.service_charge_minor ? <Row label={`Service charge${s ? ` (${Number(s.service_charge_percent)}%)` : ''}`} value={money(b.service_charge_minor)} /> : null}
        {b.tax_minor ? <Row label={`Tax${s ? ` (${Number(s.tax_percent)}%)` : ''}`} value={money(b.tax_minor)} /> : null}
        {s?.prices_include_tax ? <p className="text-xs text-stone-500">Prices include tax</p> : null}
        <Row label="Total" value={money(b.total_minor)} strong />
      </dl>
      {b.payments.length ? (
        <dl className="space-y-0.5 border-t border-dashed border-stone-300 pt-2">
          {b.payments.map((p) => (
            <Row key={p.id} label={p.status === 'refunded' ? `${paymentLabel(p)} (refunded)` : paymentLabel(p)} value={money(p.amount_minor)} />
          ))}
          <Row label={b.due_minor ? 'Still to pay' : 'Balance'} value={money(b.due_minor)} strong />
        </dl>
      ) : null}
      <p className="text-center font-sans text-sm font-semibold">{b.due_minor === 0 && b.total_minor > 0 ? 'PAID — thank you!' : ''}</p>
      {s?.receipt_footer ? <p className="text-center text-xs text-stone-600">{s.receipt_footer}</p> : null}
    </article>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? 'font-semibold' : ''}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
