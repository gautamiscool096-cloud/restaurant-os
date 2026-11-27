import { NextResponse, type NextRequest } from 'next/server';
import { createAnonClient } from '@/lib/supabase/anon';

// Razorpay → Dashboard → Webhooks points here. The raw body and signature go
// straight to the database, which checks the HMAC with the webhook secret
// (set by a platform admin) before changing anything.
export async function POST(request: NextRequest) {
  const raw = await request.text();
  const signature = request.headers.get('x-razorpay-signature');
  const { data, error } = await createAnonClient().rpc('razorpay_webhook', { p_body: raw, p_signature: signature });
  if (error) {
    const status = /signature|not configured/.test(error.message) ? 401 : 400;
    return NextResponse.json({ ok: false }, { status });
  }
  return NextResponse.json({ ok: true, result: data });
}
