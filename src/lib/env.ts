// Public (browser-safe) configuration. The publishable/anon key is designed to
// be public: what it can reach is decided entirely by RLS in the database.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export const isSupabaseConfigured = () => Boolean(SUPABASE_URL && SUPABASE_KEY);
