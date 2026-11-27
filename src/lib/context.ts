import 'server-only';
import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';

export type StaffRole = 'owner' | 'manager' | 'waiter' | 'chef' | 'cashier';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'cancelled';

export type AppContext = {
  staff_id: string;
  role: StaffRole;
  display_name: string;
  is_platform_admin: boolean;
  operational: boolean;
  restaurant: {
    id: string;
    slug: string;
    name: string;
    logo_url: string | null;
    brand_primary_color: string;
    brand_accent_color: string;
    subscription_status: SubscriptionStatus;
    trial_ends_at: string;
    current_period_end: string | null;
    suspended: boolean;
  };
};

/** The signed-in user, and their restaurant context (null = not onboarded yet). */
export const getSession = cache(async () => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { user: null, context: null } as const;
  const { data, error } = await supabase.rpc('my_context');
  if (error) throw error;
  return { user, context: (data as AppContext | null) ?? null } as const;
});
