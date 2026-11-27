import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { SUPABASE_KEY, SUPABASE_URL, isSupabaseConfigured } from '@/lib/env';

const SIGNED_IN_ONLY = ['/onboarding', '/dashboard'];
const SIGNED_OUT_ONLY = ['/login', '/signup'];

/** Refreshes the Supabase session cookie and does coarse signed-in routing. */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  if (!isSupabaseConfigured()) return response;

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  // Validates the JWT signature; do not put code between client creation and this call.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const path = request.nextUrl.pathname;

  const redirect = (to: string) => {
    const url = request.nextUrl.clone();
    url.pathname = to;
    url.search = '';
    const r = NextResponse.redirect(url);
    for (const c of response.cookies.getAll()) r.cookies.set(c);
    return r;
  };

  if (!signedIn && SIGNED_IN_ONLY.some((p) => path === p || path.startsWith(`${p}/`))) {
    return redirect('/login');
  }
  if (signedIn && SIGNED_OUT_ONLY.includes(path)) {
    return redirect('/dashboard');
  }
  return response;
}
