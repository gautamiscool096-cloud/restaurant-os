import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/context';
import { logOut } from '@/app/(auth)/actions';
import { BillingBlocked } from './BillingBlocked';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, context } = await getSession();
  if (!user) redirect('/login');
  if (!context) redirect('/onboarding');

  const r = context.restaurant;
  return (
    <div className="min-h-dvh">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {r.logo_url
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={r.logo_url} alt="" className="size-9 rounded-lg object-contain" />
              : <div className="grid size-9 shrink-0 place-items-center rounded-lg font-semibold text-white"
                     style={{ background: r.brand_primary_color }}>{r.name[0]?.toUpperCase()}</div>}
            <div className="min-w-0">
              <p className="truncate font-semibold">{r.name}</p>
              <p className="text-xs capitalize text-stone-500">{context.display_name} · {context.role}</p>
            </div>
          </div>
          <form action={logOut}>
            <button className="rounded-lg px-3 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100">Log out</button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {context.operational ? children : <BillingBlocked context={context} />}
      </main>
    </div>
  );
}
