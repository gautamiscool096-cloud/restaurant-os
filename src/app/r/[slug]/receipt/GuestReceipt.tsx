'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { storageKeys } from '@/lib/menu-types';
import type { Bill } from '@/lib/bill';
import { Receipt } from '@/components/Receipt';
import { PrintButton } from '@/components/PrintButton';

export function GuestReceipt({ slug, tableToken }: { slug: string; tableToken: string | null }) {
  const [bill, setBill] = useState<Bill | null | undefined>(undefined);

  useEffect(() => {
    let token: string | null = null;
    try { token = JSON.parse(localStorage.getItem(storageKeys(slug, tableToken ?? 'none').session) ?? 'null'); } catch { /* ignore */ }
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing stored on this phone
      setBill(null);
      return;
    }
    void createClient().rpc('guest_bill', { p_session_token: token }).then(({ data }) => setBill((data as Bill) ?? null));
  }, [slug, tableToken]);

  const back = `/r/${slug}/order${tableToken ? `?t=${encodeURIComponent(tableToken)}` : ''}`;
  return (
    <main className="mx-auto max-w-md space-y-4 px-4 py-6">
      <div className="flex items-center justify-between print:hidden">
        <Link href={back} className="text-sm text-stone-600 underline">← Back to your order</Link>
        {bill ? <PrintButton label="Save or print" /> : null}
      </div>
      {bill === undefined ? <p className="py-10 text-center text-stone-500">Loading receipt…</p> : null}
      {bill === null ? <p className="py-10 text-center text-stone-500">No receipt on this phone.</p> : null}
      {bill ? <Receipt bill={bill} /> : null}
    </main>
  );
}
