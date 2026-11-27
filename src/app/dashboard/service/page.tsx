import type { Metadata } from 'next';
import { requireRole } from '@/lib/require-role';
import { ServiceView } from './ServiceView';

export const metadata: Metadata = { title: 'Service' };

export default async function ServicePage() {
  await requireRole('owner', 'manager', 'waiter');
  return <ServiceView />;
}
