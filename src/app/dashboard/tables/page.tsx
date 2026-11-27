import type { Metadata } from 'next';
import QRCode from 'qrcode';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/context';
import { createClient } from '@/lib/supabase/server';
import { SITE_URL } from '@/lib/env';
import { PrintButton } from './PrintButton';

export const metadata: Metadata = { title: 'Table QR codes' };

export default async function TablesPage() {
  const { context } = await getSession();
  if (!context) redirect('/onboarding');
  if (!['owner', 'manager'].includes(context.role)) redirect('/dashboard');
  const r = context.restaurant;

  // RLS returns only this restaurant's tables.
  const supabase = await createClient();
  const { data: tables } = await supabase
    .from('dining_tables')
    .select('id, number, label, qr_token, is_active')
    .eq('is_active', true)
    .order('number');

  const codes = await Promise.all((tables ?? []).map(async (t) => {
    // Each code carries the restaurant slug AND this table's secret token.
    const url = `${SITE_URL}/r/${r.slug}/menu?t=${encodeURIComponent(t.qr_token)}`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { ...t, url, svg };
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Table QR codes</h1>
          <p className="mt-1 text-stone-600">
            Print these and stick one on each table. Guests scan to see your menu and order for that table.
          </p>
        </div>
        <PrintButton />
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 print:grid-cols-3 print:gap-6">
        {codes.map((c) => (
          <figure key={c.id} className="break-inside-avoid rounded-2xl border border-stone-200 bg-white p-4 text-center">
            <p className="text-sm font-medium text-stone-500">{r.name}</p>
            <p className="text-xl font-semibold">{c.label ?? `Table ${c.number}`}</p>
            <div className="mx-auto my-3 w-full max-w-44 [&_svg]:h-auto [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: c.svg }} />
            <figcaption className="text-xs text-stone-500">Scan to see the menu and order</figcaption>
            <a href={c.url} target="_blank" rel="noreferrer" className="mt-1 block text-xs text-amber-700 underline print:hidden">
              Open link
            </a>
          </figure>
        ))}
      </div>
    </div>
  );
}
