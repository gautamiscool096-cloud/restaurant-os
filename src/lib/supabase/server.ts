import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { SUPABASE_KEY, SUPABASE_URL } from '@/lib/env';

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 * It acts as the signed-in user (their JWT), so every query is subject to RLS.
 * There is deliberately no service-role client in the web app.
 */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // The proxy refreshes the session cookie instead.
        }
      },
    },
  });
}
