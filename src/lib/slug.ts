// Restaurant web-address rules. Must match app.slug_is_valid() in
// supabase/migrations/20261127000004_onboarding.sql (the database is the
// authority; this copy only gives instant feedback in the form).

export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'auth', 'billing', 'dashboard', 'docs', 'help', 'kitchen', 'login', 'logout',
  'menu', 'onboarding', 'platform', 'pricing', 'r', 'signup', 'static', 'status', 'support', 'waiter', 'www',
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;

/** "Café Mumbai Bistro!" -> "cafe-mumbai-bistro" */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

/** Returns a human-readable problem, or null if the slug is well-formed. */
export function slugProblem(slug: string): string | null {
  if (slug.length < 3) return 'Use at least 3 characters.';
  if (slug.length > 48) return 'Use at most 48 characters.';
  if (!SLUG_RE.test(slug)) return 'Use only lowercase letters, numbers and dashes, not at the start or end.';
  if (RESERVED_SLUGS.has(slug)) return 'That address is reserved. Try another.';
  return null;
}
