'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/rpc-error';
import { inputClass } from '@/components/ui';

type Profile = {
  name: string; slug: string; address: string | null; cuisine_type: string | null; logo_url: string | null;
  brand_primary_color: string; brand_accent_color: string;
  tax_percent: number; service_charge_percent: number; prices_include_tax: boolean; require_order_approval: boolean;
  accepts_cash: boolean; accepts_online: boolean; receipt_footer: string | null;
};

export function SettingsForm() {
  const router = useRouter();
  const [p, setP] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void createClient().rpc('restaurant_profile').then(({ data, error: e }) => {
      if (e) setError(friendlyError(e, 'Could not load settings.'));
      else setP(data as Profile);
    });
  }, []);

  if (!p) return <p className="py-10 text-center text-stone-500">{error ?? 'Loading…'}</p>;
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setP({ ...p, [k]: v });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!p) return;
    setBusy(true); setError(null); setNotice(null);
    const { slug: _slug, ...rest } = p;
    void _slug;
    const { data, error: err } = await createClient().rpc('update_restaurant_profile', {
      p: { ...rest, tax_percent: Number(p.tax_percent), service_charge_percent: Number(p.service_charge_percent),
           address: p.address ?? '', cuisine_type: p.cuisine_type ?? '', logo_url: p.logo_url ?? '', receipt_footer: p.receipt_footer ?? '' },
    });
    setBusy(false);
    if (err) { setError(friendlyError(err)); return; }
    setP(data as Profile);
    setNotice('Settings saved.');
    router.refresh();
  }

  const check = (k: 'prices_include_tax' | 'require_order_approval' | 'accepts_cash' | 'accepts_online', label: string, hint: string) => (
    <label className="flex items-start gap-3 rounded-lg p-2 hover:bg-stone-50">
      <input type="checkbox" className="mt-1" checked={p[k]} onChange={(e) => set(k, e.target.checked)} />
      <span><span className="block font-medium">{label}</span><span className="text-sm text-stone-500">{hint}</span></span>
    </label>
  );

  return (
    <form onSubmit={save} className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-stone-600">Your restaurant’s details, look and bill rules. Your menu link stays <b>/r/{p.slug}</b>.</p>
      </div>
      {error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {notice ? <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}

      <section className="space-y-4 rounded-2xl border border-stone-200 bg-white p-5">
        <h2 className="font-semibold">Restaurant</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div><label htmlFor="s-name" className="block text-sm font-medium">Name</label>
            <input id="s-name" required className={inputClass} value={p.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div><label htmlFor="s-cuisine" className="block text-sm font-medium">Cuisine</label>
            <input id="s-cuisine" className={inputClass} value={p.cuisine_type ?? ''} onChange={(e) => set('cuisine_type', e.target.value)} /></div>
          <div className="sm:col-span-2"><label htmlFor="s-address" className="block text-sm font-medium">Address</label>
            <input id="s-address" className={inputClass} value={p.address ?? ''} onChange={(e) => set('address', e.target.value)} /></div>
          <div className="sm:col-span-2"><label htmlFor="s-logo" className="block text-sm font-medium">Logo link <span className="font-normal text-stone-500">(optional, https://)</span></label>
            <input id="s-logo" type="url" className={inputClass} value={p.logo_url ?? ''} onChange={(e) => set('logo_url', e.target.value)} /></div>
        </div>
      </section>

      <section className="space-y-4 rounded-2xl border border-stone-200 bg-white p-5">
        <h2 className="font-semibold">Colours</h2>
        <div className="flex flex-wrap gap-6">
          {(['brand_primary_color', 'brand_accent_color'] as const).map((k) => (
            <div key={k} className="flex items-center gap-3">
              <input id={k} type="color" className="h-10 w-14 rounded border border-stone-300" value={p[k]} onChange={(e) => set(k, e.target.value)} />
              <label htmlFor={k} className="text-sm font-medium">{k === 'brand_primary_color' ? 'Main colour' : 'Highlight colour'}</label>
            </div>
          ))}
          <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white" style={{ background: p.brand_primary_color }}>
            Preview <span className="rounded px-2 py-0.5" style={{ background: p.brand_accent_color }}>Add</span>
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-2xl border border-stone-200 bg-white p-5">
        <h2 className="font-semibold">Bills and orders</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div><label htmlFor="s-tax" className="block text-sm font-medium">Tax (GST) %</label>
            <input id="s-tax" type="number" step="0.01" min="0" max="100" className={inputClass} value={p.tax_percent} onChange={(e) => set('tax_percent', e.target.value as unknown as number)} /></div>
          <div><label htmlFor="s-service" className="block text-sm font-medium">Service charge %</label>
            <input id="s-service" type="number" step="0.01" min="0" max="100" className={inputClass} value={p.service_charge_percent} onChange={(e) => set('service_charge_percent', e.target.value as unknown as number)} /></div>
        </div>
        <div className="grid gap-1 sm:grid-cols-2">
          {check('prices_include_tax', 'Menu prices already include tax', 'Tax is not added on top of the bill.')}
          {check('require_order_approval', 'Approve each order first', 'New orders wait for staff before going to the kitchen.')}
          {check('accepts_cash', 'Guests can pay at the table', 'Cash, card machine or UPI to staff.')}
          {check('accepts_online', 'Guests can pay online', 'Guests pay from their phone.')}
        </div>
        <div><label htmlFor="s-footer" className="block text-sm font-medium">Message at the bottom of receipts</label>
          <input id="s-footer" className={inputClass} placeholder="Thank you, see you again!" value={p.receipt_footer ?? ''} onChange={(e) => set('receipt_footer', e.target.value)} /></div>
      </section>

      <button disabled={busy} className="rounded-lg bg-stone-900 px-5 py-2.5 font-medium text-white disabled:opacity-50">
        {busy ? 'Saving…' : 'Save settings'}
      </button>
    </form>
  );
}
