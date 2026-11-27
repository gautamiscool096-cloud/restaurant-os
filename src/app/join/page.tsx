import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, Logo } from '@/components/ui';
import { getSession } from '@/lib/context';

export const metadata: Metadata = { title: 'Join your team' };

export default async function JoinPage() {
  const { user, context } = await getSession();
  if (context) redirect('/dashboard');
  if (user) redirect('/onboarding');
  return (
    <main className="mx-auto max-w-md px-4 py-6">
      <Logo />
      <Card className="mt-10 space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Join your restaurant’s team</h1>
        <ol className="list-decimal space-y-1 pl-5 text-stone-700">
          <li>Create an account with your own email (or log in).</li>
          <li>Type the invite code your manager gave you.</li>
        </ol>
        <div className="flex gap-2">
          <Link href="/signup" className="rounded-lg bg-stone-900 px-4 py-2 font-medium text-white">Create account</Link>
          <Link href="/login" className="rounded-lg px-4 py-2 font-medium text-stone-700 ring-1 ring-stone-200">Log in</Link>
        </div>
      </Card>
    </main>
  );
}
