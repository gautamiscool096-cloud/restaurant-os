'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Alert, Field, SubmitButton, inputClass } from '@/components/ui';
import type { AuthState } from './actions';

export function AuthForm({
  mode, action,
}: { mode: 'signup' | 'login'; action: (s: AuthState, f: FormData) => Promise<AuthState> }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const isSignup = mode === 'signup';

  if (state?.info) return <Alert tone="success">{state.info}</Alert>;

  return (
    <form action={formAction} className="space-y-4">
      {state?.error ? <Alert>{state.error}</Alert> : null}
      <Field label="Email" htmlFor="email">
        <input id="email" name="email" type="email" autoComplete="email" required
               defaultValue={state?.email} className={inputClass} />
      </Field>
      <Field label="Password" htmlFor="password" hint={isSignup ? 'At least 8 characters.' : undefined}>
        <input id="password" name="password" type="password" required minLength={isSignup ? 8 : undefined}
               autoComplete={isSignup ? 'new-password' : 'current-password'} className={inputClass} />
      </Field>
      <SubmitButton pending={pending}>{isSignup ? 'Create account' : 'Log in'}</SubmitButton>
      <p className="text-center text-sm text-stone-600">
        {isSignup ? 'Already have an account? ' : 'New here? '}
        <Link href={isSignup ? '/login' : '/signup'} className="font-medium text-amber-700 hover:underline">
          {isSignup ? 'Log in' : 'Start a free trial'}
        </Link>
      </p>
    </form>
  );
}
