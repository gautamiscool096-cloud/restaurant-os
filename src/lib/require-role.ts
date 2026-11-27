import 'server-only';
import { redirect } from 'next/navigation';
import { getSession, type StaffRole } from '@/lib/context';

/** For pages: the DB enforces access anyway; this just keeps people out of screens they can't use. */
export async function requireRole(...roles: StaffRole[]) {
  const { context } = await getSession();
  if (!context) redirect('/onboarding');
  if (!roles.includes(context.role)) redirect('/dashboard');
  return context;
}
