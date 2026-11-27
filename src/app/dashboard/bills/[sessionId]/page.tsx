import type { Metadata } from 'next';
import { requireRole } from '@/lib/require-role';
import { BillDesk } from './BillDesk';

export const metadata: Metadata = { title: 'Bill' };

export default async function BillPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const [{ sessionId }, ctx] = await Promise.all([params, requireRole('owner', 'manager', 'waiter', 'cashier')]);
  return <BillDesk sessionId={sessionId} canFreeTable={ctx.role === 'owner' || ctx.role === 'manager'} />;
}
