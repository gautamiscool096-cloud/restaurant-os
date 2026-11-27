'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { SITE_URL, isSupabaseConfigured } from '@/lib/env';

export type AuthState = { error?: string; info?: string; email?: string } | undefined;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function signUp(_: AuthState, form: FormData): Promise<AuthState> {
  if (!isSupabaseConfigured()) return { error: 'Supabase is not connected yet.' };
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const password = String(form.get('password') ?? '');
  if (!EMAIL_RE.test(email)) return { error: 'Enter a valid email address.', email };
  if (password.length < 8) return { error: 'Use a password of at least 8 characters.', email };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${SITE_URL}/auth/callback?next=/onboarding` },
  });
  if (error) return { error: error.message, email };

  // Projects with "Confirm email" turned off sign the user straight in.
  if (data.session) redirect('/onboarding');
  return { info: `We sent a confirmation link to ${email}. Open it on this device to continue.`, email };
}

export async function logIn(_: AuthState, form: FormData): Promise<AuthState> {
  if (!isSupabaseConfigured()) return { error: 'Supabase is not connected yet.' };
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const password = String(form.get('password') ?? '');
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: 'Wrong email or password.', email };
  redirect('/dashboard');
}

export async function logOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
