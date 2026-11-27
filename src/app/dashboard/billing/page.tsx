import type { Metadata } from 'next';
import { requireRole } from '@/lib/require-role';
import { PlanPicker } from '@/components/PlanPicker';

export const metadata: Metadata = { title: 'Your plan' };

export default async function BillingPage() {
  await requireRole('owner');
  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Your plan</h1>
      <PlanPicker />
    </div>
  );
}
