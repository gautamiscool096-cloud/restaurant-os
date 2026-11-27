import type { Metadata } from 'next';
import { Card, NotConfigured } from '@/components/ui';
import { isSupabaseConfigured } from '@/lib/env';
import { AuthForm } from '../AuthForm';
import { logIn } from '../actions';

export const metadata: Metadata = { title: 'Log in' };

export default function LoginPage() {
  return (
    <Card className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Log in</h1>
        <p className="mt-1 text-sm text-stone-600">Owners, managers and staff all log in here.</p>
      </div>
      {isSupabaseConfigured() ? <AuthForm mode="login" action={logIn} /> : <NotConfigured />}
    </Card>
  );
}
