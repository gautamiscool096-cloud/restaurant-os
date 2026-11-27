'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/money';
import { friendlyError } from '@/lib/rpc-error';

type Overview = {
  plan: string; status: 'trialing' | 'active' | 'past_due' | 'cancelled'; trial_ends_at: string; current_period_end: string | null;
  suspended: boolean; operational: boolean; test_mode: boolean;
  plans: { code: string; name: string; price_minor: number; description: string | null }[];
};

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

export function PlanPicker({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void createClient().rpc('subscription_overview').then(({ data, error: e }) => {
      if (e) setError(friendlyError(e, 'Could not load your plan.'));
      else setO(data as Overview);
    });
  }, []);

  async function choose(code: string) {
    setBusy(code); setError(null);
    const { data, error: e } = await createClient().rpc('start_subscription', { p_plan: code });
    setBusy(null);
    if (e) { setError(friendlyError(e)); return; }
    setO(data as Overview);
    router.refresh();
  }

  if (!o) return error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null;
  const summary = o.status === 'active' ? `You’re on ${o.plan}, paid until ${date(o.current_period_end)}.`
    : o.status === 'trialing' ? (o.operational ? `Free trial until ${date(o.trial_ends_at)}.` : 'Your free trial has ended.')
    : o.status === 'past_due' ? 'Your last payment did not go through.' : 'Your plan is cancelled.';

  return (
    <div className="space-y-4 text-left">
      {!compact ? <p className="text-stone-700" data-testid="plan-summary">{summary}</p> : null}
      {error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {o.test_mode ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">Test mode: choosing a plan activates it straight away. No real money is taken.</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {o.plans.map((p) => {
          const current = o.status === 'active' && o.plan === p.code;
          return (
            <div key={p.code} className={`space-y-2 rounded-2xl border bg-white p-4 ${current ? 'border-emerald-400' : 'border-stone-200'}`}>
              <p className="font-semibold">{p.name}</p>
              <p className="text-xl font-semibold">{formatMoney(p.price_minor)}<span className="text-sm font-normal text-stone-500"> / month</span></p>
              <p className="text-sm text-stone-600">{p.description}</p>
              <button type="button" disabled={busy !== null || current} onClick={() => choose(p.code)}
                      className="w-full rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {current ? 'Current plan' : busy === p.code ? 'Please wait…' : o.status === 'active' ? `Switch to ${p.name}` : `Choose ${p.name}`}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
