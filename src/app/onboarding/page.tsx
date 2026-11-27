import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Logo } from '@/components/ui';
import { getSession } from '@/lib/context';
import { OnboardingForm } from './OnboardingForm';
import { JoinForm } from './JoinForm';

export const metadata: Metadata = { title: 'Set up your restaurant' };

export default async function OnboardingPage() {
  const { user, context } = await getSession();
  if (!user) redirect('/login');
  if (context) redirect('/dashboard');

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <Logo />
      <div className="pt-8"><JoinForm /></div>
      <div className="py-8">
        <p className="text-sm font-medium text-amber-700">Step 2 of 2</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Or set up your own restaurant</h1>
        <p className="mt-2 text-stone-600">
          You can change all of this later. We&apos;ll create your tables and an empty menu so you can start adding dishes.
        </p>
      </div>
      <OnboardingForm />
    </main>
  );
}
