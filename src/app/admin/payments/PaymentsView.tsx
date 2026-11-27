'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/rpc-error';
import { inputClass } from '@/components/ui';

type Settings = { payments_test_mode: boolean; platform_fee_bps: number; webhook_secret_set: boolean; updated_at: string };

export function PaymentsView() {
  const [s, setS] = useState<Settings | null>(null);
  const [fee, setFee] = useState('0');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void createClient().rpc('platform_payment_settings').then(({ data }) => {
      const v = data as Settings;
      setS(v);
      if (v) setFee(String(v.platform_fee_bps / 100));
    });
  }, []);

  async function save(change: { p_test_mode?: boolean; p_fee_bps?: number; p_webhook_secret?: string }, ok: string) {
    setError(null); setNotice(null);
    const { data, error: e } = await createClient().rpc('platform_set_payment_settings', change);
    if (e) { setError(friendlyError(e)); return; }
    setS(data as Settings);
    setSecret('');
    setNotice(ok);
  }

  if (!s) return <p className="py-10 text-center text-stone-500">Loading…</p>;
  const card = 'space-y-3 rounded-2xl border border-stone-200 bg-white p-5';
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
      {error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {notice ? <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}

      <section className={card} aria-label="Test mode">
        <h2 className="font-semibold">Test mode is {s.payments_test_mode ? 'ON' : 'OFF'}</h2>
        <p className="text-sm text-stone-600">
          {s.payments_test_mode
            ? 'Guests and owners can “pay” without real money. Turn this off before real restaurants start taking payments.'
            : 'Real money only. Guest payments and plan payments go through Razorpay.'}
        </p>
        <button type="button" onClick={() => save({ p_test_mode: !s.payments_test_mode }, s.payments_test_mode ? 'Test mode is off.' : 'Test mode is on.')}
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${s.payments_test_mode ? 'bg-red-700' : 'bg-stone-900'}`}>
          {s.payments_test_mode ? 'Turn test mode off' : 'Turn test mode on'}
        </button>
      </section>

      <section className={card} aria-label="Platform fee">
        <h2 className="font-semibold">Your fee on guest payments</h2>
        <p className="text-sm text-stone-600">Kept by you from each online guest payment; the rest goes to the restaurant.</p>
        <div className="flex items-end gap-3">
          <div className="w-28"><label htmlFor="fee" className="block text-sm font-medium">Fee %</label>
            <input id="fee" type="number" step="0.01" min="0" max="20" className={inputClass} value={fee} onChange={(e) => setFee(e.target.value)} /></div>
          <button type="button" className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white"
                  onClick={() => save({ p_fee_bps: Math.round(Number(fee) * 100) }, `Fee set to ${fee}%.`)}>Save fee</button>
        </div>
      </section>

      <section className={card} aria-label="Webhook secret">
        <h2 className="font-semibold">Razorpay webhook secret</h2>
        <p className="text-sm text-stone-600">
          {s.webhook_secret_set ? 'A secret is saved. It is never shown again; paste a new one to replace it.' : 'Not set yet. Razorpay updates are refused until you add it.'}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1"><label htmlFor="secret" className="block text-sm font-medium">Webhook secret</label>
            <input id="secret" type="password" autoComplete="off" className={inputClass} value={secret} onChange={(e) => setSecret(e.target.value)} /></div>
          <button type="button" disabled={!secret.trim()} className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  onClick={() => save({ p_webhook_secret: secret }, 'Webhook secret saved.')}>Save secret</button>
        </div>
      </section>
    </div>
  );
}
