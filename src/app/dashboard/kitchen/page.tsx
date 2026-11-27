import type { Metadata } from 'next';
import { requireRole } from '@/lib/require-role';
import { KitchenDisplay } from './KitchenDisplay';

export const metadata: Metadata = { title: 'Kitchen' };

export default async function KitchenPage() {
  const ctx = await requireRole('owner', 'manager', 'chef');
  return <KitchenDisplay canServe={ctx.role !== 'chef'} />;
}
