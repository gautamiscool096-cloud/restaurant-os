import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Logo } from '@/components/ui';
import { getSession } from '@/lib/context';
import { createClient } from '@/lib/supabase/server';
import { logOut } from '@/app/(auth)/actions';
import { AdminNav } from './AdminNav';

export const metadata: Metadata = { title: 'Platform admin' };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = await getSession();
  if (!user) redirect('/login');
  const { data: isAdmin } = await (await createClient()).rpc('am_platform_admin');
  if (!isAdmin) redirect('/dashboard');
  return (
    <div className="min-h-dvh">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3"><Logo /><span className="rounded-full bg-stone-900 px-2 py-0.5 text-xs font-medium text-white">Platform admin</span></div>
          <form action={logOut}><button className="rounded-lg px-3 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100">Log out</button></form>
        </div>
        <AdminNav />
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
