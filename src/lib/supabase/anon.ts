import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL } from '@/lib/env';

/** Server-side client with no user session: acts as `anon`, exactly like a guest's phone. */
export function createAnonClient() {
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}
