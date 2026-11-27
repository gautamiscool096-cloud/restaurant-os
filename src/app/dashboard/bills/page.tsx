import type { Metadata } from 'next';
import { requireRole } from '@/lib/require-role';
import { OpenBills } from './OpenBills';

export const metadata: Metadata = { title: 'Bills' };

export default async function BillsPage() {
  const ctx = await requireRole('owner', 'manager', 'waiter', 'cashier');
  return <OpenBills currency={ctx.restaurant.currency} />;
}
