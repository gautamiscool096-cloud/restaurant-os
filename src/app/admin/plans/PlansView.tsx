'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/money';
import { friendlyError } from '@/lib/rpc-error';
import { inputClass } from '@/components/ui';

type Plan = { code: string; name: string; price_minor: number; description: string | null; is_public: boolean };
type Draft = { code: string; name: string; price: string; description: string; is_public: boolean; isNew?: boolean };

export function PlansView() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void createClient().rpc('platform_plans').then(({ data }) => setPlans((data as { plans: Plan[] } | null)?.plans ?? []));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    setError(null); setNotice(null);
    const { data, error: err } = await createClient().rpc('platform_save_plan', {
      p_code: edit.code, p_name: edit.name, p_price_minor: Math.round(Number(edit.price) * 100),
      p_description: edit.description, p_public: edit.is_public,
    });
    if (err) { setError(friendlyError(err)); return; }
    setPlans((data as { plans: Plan[] }).plans);
    setNotice(`Saved ${edit.name}.`);
    setEdit(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Plans</h1>
          <p className="mt-1 text-stone-600">What restaurants pay you each month. Price changes apply from their next payment.</p>
        </div>
        <button type="button" onClick={() => setEdit({ code: '', name: '', price: '', description: '', is_public: true, isNew: true })}
                className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white">New plan</button>
      </div>
      {error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {notice ? <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans?.map((p) => (
          <div key={p.code} className="space-y-2 rounded-2xl border border-stone-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{p.name}</h2>
              {!p.is_public ? <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">Hidden</span> : null}
            </div>
            <p className="text-2xl font-semibold">{formatMoney(p.price_minor)}<span className="text-sm font-normal text-stone-500"> / month</span></p>
            <p className="text-sm text-stone-600">{p.description}</p>
            <button type="button" aria-label={`Edit ${p.name}`} className="rounded-lg px-3 py-1.5 text-sm text-amber-700 hover:bg-amber-50"
                    onClick={() => setEdit({ code: p.code, name: p.name, price: String(p.price_minor / 100), description: p.description ?? '', is_public: p.is_public })}>Edit</button>
          </div>
        ))}
      </div>
      {edit ? (
        <form onSubmit={save} className="max-w-lg space-y-3 rounded-2xl border border-amber-200 bg-white p-5" aria-label="Edit plan">
          <h2 className="font-semibold">{edit.isNew ? 'New plan' : `Edit ${edit.name}`}</h2>
          {edit.isNew ? <div><label htmlFor="p-code" className="block text-sm font-medium">Short code (lowercase, e.g. premium)</label>
            <input id="p-code" required className={inputClass} value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></div> : null}
          <div><label htmlFor="p-name" className="block text-sm font-medium">Name</label>
            <input id="p-name" required className={inputClass} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
          <div><label htmlFor="p-price" className="block text-sm font-medium">Price per month (₹)</label>
            <input id="p-price" required inputMode="decimal" className={inputClass} value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} /></div>
          <div><label htmlFor="p-desc" className="block text-sm font-medium">What’s included</label>
            <input id="p-desc" className={inputClass} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.is_public} onChange={(e) => setEdit({ ...edit, is_public: e.target.checked })} /> Owners can pick this plan</label>
          <div className="flex gap-2">
            <button className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white">Save plan</button>
            <button type="button" onClick={() => setEdit(null)} className="rounded-lg px-4 py-2 text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
