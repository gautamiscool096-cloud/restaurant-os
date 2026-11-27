import type { Metadata } from 'next';
import { requireRole } from '@/lib/require-role';
import { SITE_URL } from '@/lib/env';
import { TeamView } from './TeamView';

export const metadata: Metadata = { title: 'Team' };

export default async function TeamPage() {
  const ctx = await requireRole('owner', 'manager');
  return <TeamView myRole={ctx.role} joinUrl={`${SITE_URL}/join`} />;
}
