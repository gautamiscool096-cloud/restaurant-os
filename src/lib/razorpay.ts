import 'server-only';

// Razorpay keys live only in the server environment (Vercel → Environment
// Variables). Until they are set, online payments run in test mode (if a
// platform admin switched it on) or are hidden.
const KEY_ID = process.env.RAZORPAY_KEY_ID ?? '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? '';

export const isRazorpayConfigured = () => Boolean(KEY_ID && KEY_SECRET);
export const razorpayKeyId = () => KEY_ID;

type Transfer = { account: string; amount: number; currency: string; on_hold?: boolean };

/** Creates a Razorpay order; with Route, the restaurant's share is transferred to its linked account. */
export async function createRazorpayOrder(input: {
  amount: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
  transfers?: Transfer[];
}): Promise<{ id: string }> {
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`,
    },
    body: JSON.stringify(input),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`razorpay order failed: ${res.status}`);
  return res.json();
}
