import { Alert, Card } from '@/components/ui';
import { getSession } from '@/lib/context';
import { createClient } from '@/lib/supabase/server';
import { SITE_URL } from '@/lib/env';

function daysLeft(iso: string) {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

export default async function DashboardHome({
  searchParams,
}: { searchParams: Promise<{ welcome?: string; logo?: string }> }) {
  const params = await searchParams;
  const { context } = await getSession();
  if (!context) return null;
  const r = context.restaurant;

  // Plain RLS-scoped reads: these can only ever return this restaurant's rows.
  const supabase = await createClient();
  const [tables, items] = await Promise.all([
    supabase.from('dining_tables').select('id', { count: 'exact', head: true }),
    supabase.from('menu_items').select('id', { count: 'exact', head: true }),
  ]);

  const menuUrl = `${SITE_URL}/r/${r.slug}/menu`;
  const steps = [
    { done: true, title: 'Create your restaurant', body: `${tables.count ?? 0} tables are ready.` },
    { done: (items.count ?? 0) > 0, title: 'Add your menu', body: 'Dishes, prices, photos, veg/non-veg. Coming in the next update.' },
    { done: false, title: 'Print table QR codes', body: 'One code per table, ready to print. Coming soon.' },
    { done: false, title: 'Invite your staff', body: 'Logins for managers, waiters and chefs. Coming soon.' },
  ];

  return (
    <div className="space-y-6">
      {params.welcome ? <Alert tone="success">Welcome aboard! {r.name} is set up.</Alert> : null}
      {params.logo === 'failed' ? <Alert>Your restaurant was created, but the logo didn&apos;t upload. You can add it later in settings.</Alert> : null}
      {r.subscription_status === 'trialing'
        ? <Alert tone="info">Free trial: {daysLeft(r.trial_ends_at)} days left.</Alert>
        : r.subscription_status === 'past_due'
          ? <Alert>Your last payment failed. Please update your payment details within 7 days.</Alert>
          : null}

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Get set up</h1>
        <p className="mt-1 text-stone-600">Finish these steps and guests can start ordering from their tables.</p>
      </div>

      <Card className="divide-y divide-stone-100 p-0">
        {steps.map((s, i) => (
          <div key={s.title} className="flex items-start gap-4 p-5">
            <span className={`grid size-7 shrink-0 place-items-center rounded-full text-sm font-medium ${
              s.done ? 'bg-emerald-500 text-white' : 'bg-stone-100 text-stone-500'}`}>
              {s.done ? '✓' : i + 1}
            </span>
            <div>
              <p className="font-medium">{s.title}</p>
              <p className="text-sm text-stone-600">{s.body}</p>
            </div>
          </div>
        ))}
      </Card>

      <Card>
        <p className="text-sm font-medium text-stone-500">Your menu link</p>
        <p className="mt-1 break-all font-mono text-sm">{menuUrl}</p>
      </Card>
    </div>
  );
}
