import type { Metadata } from 'next';
import { requireRole } from '@/lib/require-role';
import { MenuEditor } from './MenuEditor';

export const metadata: Metadata = { title: 'Menu' };

export default async function MenuPage() {
  const ctx = await requireRole('owner', 'manager', 'chef');
  return <MenuEditor currency={ctx.restaurant.currency} canEdit={ctx.role !== 'chef'} />;
}
