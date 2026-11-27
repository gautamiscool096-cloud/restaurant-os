import type { Metadata } from 'next';
import { requireRole } from '@/lib/require-role';
import { AnalyticsView } from './AnalyticsView';

export const metadata: Metadata = { title: 'Analytics' };

export default async function AnalyticsPage() {
  const ctx = await requireRole('owner', 'manager');
  return <AnalyticsView currency={ctx.restaurant.currency} />;
}
