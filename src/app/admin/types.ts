export type AdminRestaurant = {
  id: string; name: string; slug: string; plan: string; status: 'trialing' | 'active' | 'past_due' | 'cancelled';
  trial_ends_at: string; current_period_end: string | null; suspended: boolean; suspended_reason: string | null;
  payout_account_id: string | null; payout_account_status: string; billing_subscription_id: string | null;
  operational: boolean; created_at: string; owner: string | null; staff: number; orders_30d: number; gmv_30d_minor: number;
};

export const STATUS_LABEL: Record<AdminRestaurant['status'], string> = {
  trialing: 'Free trial', active: 'Paying', past_due: 'Payment failed', cancelled: 'Cancelled',
};

export const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
