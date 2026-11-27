// Database functions raise plain-English messages; show those, and a
// generic line for anything technical.
export function friendlyError(e: { message?: string } | null | undefined, fallback = 'Something went wrong. Please try again.') {
  const m = e?.message ?? '';
  if (!m || /violates|syntax|function|relation|column|permission denied|jwt/i.test(m)) return fallback;
  return m.charAt(0).toUpperCase() + m.slice(1) + (/[.!?]$/.test(m) ? '' : '.');
}
