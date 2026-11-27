import type { Metadata } from 'next';
import { requireRole } from '@/lib/require-role';
import { OrdersBoard } from './OrdersBoard';

export const metadata: Metadata = { title: 'Orders' };

export default async function OrdersPage() {
  const ctx = await requireRole('owner', 'manager');
  return <OrdersBoard currency={ctx.restaurant.currency} />;
}
