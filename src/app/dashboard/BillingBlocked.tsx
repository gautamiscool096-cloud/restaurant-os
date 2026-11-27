import { Card } from '@/components/ui';
import type { AppContext } from '@/lib/context';

// Shown when the database reports the tenant may not operate. RLS has already
// hidden the data; this screen just explains why.
export function BillingBlocked({ context }: { context: AppContext }) {
  const r = context.restaurant;
  const reason = r.suspended
    ? 'This restaurant has been paused by the platform. Contact support to restore access.'
    : r.subscription_status === 'trialing'
      ? 'Your free trial has ended. Choose a plan to keep taking orders.'
      : r.subscription_status === 'past_due'
        ? 'Your last payment did not go through. Update your payment details to restore access.'
        : 'Your subscription is cancelled. Restart it to use the dashboard again.';
  return (
    <Card className="mx-auto max-w-lg space-y-3 text-center">
      <h1 className="text-xl font-semibold">Your dashboard is paused</h1>
      <p className="text-stone-600">{reason}</p>
      <p className="text-sm text-stone-500">Guests can&apos;t order from your QR menu until this is sorted. Your data is safe.</p>
      {context.role === 'owner' && !r.suspended
        ? <p className="text-sm text-stone-500">Online plan checkout is coming soon. For now, contact support to reactivate.</p>
        : null}
    </Card>
  );
}
