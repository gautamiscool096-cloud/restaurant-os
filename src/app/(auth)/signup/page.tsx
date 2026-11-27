import type { Metadata } from 'next';
import { Card, NotConfigured } from '@/components/ui';
import { isSupabaseConfigured } from '@/lib/env';
import { AuthForm } from '../AuthForm';
import { signUp } from '../actions';

export const metadata: Metadata = { title: 'Start your free trial' };

export default function SignupPage() {
  return (
    <Card className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Start your free trial</h1>
        <p className="mt-1 text-sm text-stone-600">14 days free, no card needed. You&apos;ll set up your restaurant next.</p>
      </div>
      {isSupabaseConfigured() ? <AuthForm mode="signup" action={signUp} /> : <NotConfigured />}
    </Card>
  );
}
