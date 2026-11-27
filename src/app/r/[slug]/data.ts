import 'server-only';
import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import type { PublicMenu } from '@/lib/menu-types';

// Both calls go through SECURITY DEFINER functions that pin everything to
// the restaurant named by the slug (and, for tables, the QR token too).
export const getMenu = cache(async (slug: string) => {
  const supabase = await createClient();
  const { data } = await supabase.rpc('get_public_menu', { p_slug: slug });
  return (data as PublicMenu | null) ?? null;
});

export const resolveTable = cache(async (slug: string, token: string | undefined) => {
  if (!token) return null;
  const supabase = await createClient();
  const { data } = await supabase.rpc('resolve_table', { p_slug: slug, p_qr_token: token });
  return (data as { table_number: number; label: string | null } | null) ?? null;
});
