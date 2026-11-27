import type { Metadata } from 'next';
import { requireRole } from '@/lib/require-role';
import { FloorView } from './FloorView';

export const metadata: Metadata = { title: 'Floor' };

export default async function FloorPage() {
  const ctx = await requireRole('owner', 'manager');
  return <FloorView currency={ctx.restaurant.currency} />;
}
