'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

type Entry = { id: number; actor_user_id: string | null; action: string; details: Record<string, unknown> | null; created_at: string };

const LABEL: Record<string, string> = {
  restaurant_update: 'Restaurant changed', payment_settings: 'Payment settings changed', plan_saved: 'Plan saved',
  test_subscription: 'Plan started (test mode)', subscription_webhook: 'Razorpay subscription update',
};

export function ActivityView() {
  const [log, setLog] = useState<Entry[] | null>(null);
  useEffect(() => {
    void createClient().rpc('platform_audit_recent', { p_limit: 100 }).then(({ data }) => setLog((data as Entry[]) ?? []));
  }, []);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-1 text-stone-600">Every change made from this console, newest first.</p>
      </div>
      <ul className="divide-y divide-stone-100 rounded-2xl border border-stone-200 bg-white">
        {!log ? <li className="px-5 py-6 text-stone-500">Loading…</li> : log.length === 0 ? <li className="px-5 py-6 text-stone-500">Nothing yet.</li> : null}
        {log?.map((e) => (
          <li key={e.id} className="px-5 py-3">
            <p className="font-medium">{LABEL[e.action] ?? e.action}</p>
            <p className="text-xs text-stone-500">{new Date(e.created_at).toLocaleString('en-IN')} · {e.action === 'test_subscription' ? 'by the owner' : e.actor_user_id ? 'by an admin' : 'by Razorpay'}</p>
            {e.details ? <pre className="mt-1 overflow-x-auto rounded bg-stone-50 p-2 text-xs text-stone-700">{JSON.stringify(e.details)}</pre> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
