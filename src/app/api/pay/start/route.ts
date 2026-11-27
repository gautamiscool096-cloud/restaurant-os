import { NextResponse, type NextRequest } from 'next/server';
import { createAnonClient } from '@/lib/supabase/anon';
import { createRazorpayOrder, isRazorpayConfigured, razorpayKeyId } from '@/lib/razorpay';

type Started = {
  payment_id: string;
  amount_minor: number;
  platform_fee_minor: number;
  currency: string;
  restaurant_name: string;
  gateway_order_id: string | null;
  payout_account_id: string | null;
  test_mode: boolean;
};

const fail = (message: string, status = 400) => NextResponse.json({ error: message }, { status });

// A guest taps "Pay online". The database works out what is due (never the
// browser), then we open a Razorpay order for exactly that amount.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { token?: unknown } | null;
  const token = typeof body?.token === 'string' ? body.token : '';
  if (!token) return fail('missing session');

  const supabase = createAnonClient();
  const { data, error } = await supabase.rpc('guest_start_online_payment', { p_session_token: token });
  if (error) {
    if (/nothing to pay/.test(error.message)) return fail('Your bill is already paid.');
    if (/does not take online/.test(error.message)) return fail('This restaurant takes payment at the table.');
    return fail('Could not start the payment. Please ask your waiter.');
  }
  const p = data as Started;

  if (isRazorpayConfigured()) {
    let orderId = p.gateway_order_id;
    if (!orderId) {
      try {
        const order = await createRazorpayOrder({
          amount: p.amount_minor,
          currency: p.currency,
          receipt: p.payment_id.replace(/-/g, '').slice(0, 40),
          notes: { payment_id: p.payment_id },
          transfers: p.payout_account_id
            ? [{ account: p.payout_account_id, amount: p.amount_minor - p.platform_fee_minor, currency: p.currency }]
            : undefined,
        });
        orderId = order.id;
      } catch {
        return fail('The payment service is not responding. Please try again or pay at the table.', 502);
      }
      const { error: attachErr } = await supabase.rpc('guest_attach_gateway_order', {
        p_session_token: token, p_payment_id: p.payment_id, p_gateway_order_id: orderId,
      });
      if (attachErr) return fail('Could not start the payment. Please try again.');
    }
    return NextResponse.json({
      mode: 'razorpay', key_id: razorpayKeyId(), order_id: orderId,
      amount: p.amount_minor, currency: p.currency, name: p.restaurant_name,
    });
  }

  if (p.test_mode) return NextResponse.json({ mode: 'test', payment_id: p.payment_id, amount: p.amount_minor });
  return fail('Online payment is not available yet. Please pay at the table.');
}
