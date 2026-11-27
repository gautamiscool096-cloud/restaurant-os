'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/rpc-error';
import { inputClass } from '@/components/ui';

type Table = { id: string; number: number; label: string | null; seats: number; is_active: boolean };

export function TablesManager() {
  const router = useRouter();
  const [tables, setTables] = useState<Table[] | null>(null);
  const [count, setCount] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const { data } = await createClient().from('dining_tables').select('id, number, label, seats, is_active').order('number');
    setTables((data ?? []) as Table[]);
  }, []);
  useEffect(() => {
    void createClient().from('dining_tables').select('id, number, label, seats, is_active').order('number')
      .then(({ data }) => setTables((data ?? []) as Table[]));
  }, []);

  async function run(fn: () => PromiseLike<{ error: { message?: string } | null }>, ok: string) {
    setBusy(true); setError(null); setNotice(null);
    const { error: e } = await fn();
    setBusy(false);
    if (e) { setError(friendlyError(e)); return; }
    setNotice(ok);
    await load();
    router.refresh();
  }

  const update = (t: Table, patch: Partial<Table>, ok: string) => {
    const next = { ...t, ...patch };
    return run(() => createClient().rpc('update_dining_table', {
      p_id: t.id, p_label: next.label ?? '', p_seats: next.seats, p_active: next.is_active,
    }), ok);
  };

  return (
    <section aria-label="Manage tables" className="rounded-2xl border border-stone-200 bg-white print:hidden">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
              className="flex w-full items-center justify-between px-5 py-4 text-left font-semibold">
        Manage tables <span className="text-sm font-normal text-stone-500">{tables ? `${tables.filter((t) => t.is_active).length} in use` : ''} {open ? '▲' : '▼'}</span>
      </button>
      {open ? (
        <div className="space-y-4 border-t border-stone-100 px-5 py-4">
          {error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
          {notice ? <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
            e.preventDefault();
            void run(() => createClient().rpc('add_dining_tables', { p_count: Number(count) }), `Added ${count} table${count === '1' ? '' : 's'}. Print their QR codes below.`);
          }}>
            <div className="w-28">
              <label htmlFor="t-count" className="block text-sm font-medium">Add tables</label>
              <input id="t-count" type="number" min="1" max="100" className={inputClass} value={count} onChange={(e) => setCount(e.target.value)} />
            </div>
            <button disabled={busy} className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Add</button>
          </form>
          <ul className="divide-y divide-stone-100">
            {tables?.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="w-20 font-medium">Table {t.number}</span>
                <input aria-label={`Name for table ${t.number}`} placeholder="Name (optional)" defaultValue={t.label ?? ''}
                       className={`${inputClass} !w-48`}
                       onBlur={(e) => { if (e.target.value !== (t.label ?? '')) void update(t, { label: e.target.value }, `Table ${t.number} renamed.`); }} />
                <label className="flex items-center gap-2 text-sm">Seats
                  <input type="number" min="1" max="50" defaultValue={t.seats} className={`${inputClass} !w-20`}
                         onBlur={(e) => { const s = Number(e.target.value); if (s !== t.seats) void update(t, { seats: s }, `Table ${t.number} updated.`); }} />
                </label>
                <button type="button" disabled={busy} onClick={() => update(t, { is_active: !t.is_active }, t.is_active ? `Table ${t.number} taken out of use.` : `Table ${t.number} back in use.`)}
                        className={`ml-auto rounded-full px-3 py-1.5 text-sm font-medium ${t.is_active ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' : 'bg-stone-100 text-stone-600'}`}>
                  {t.is_active ? 'In use' : 'Not in use'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
