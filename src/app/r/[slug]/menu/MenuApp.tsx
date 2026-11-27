'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { computeTotals, formatMoney } from '@/lib/money';
import { storageKeys, type MenuItem, type PublicMenu } from '@/lib/menu-types';
import { BrandHeader, Spice, VegMark } from '../BrandHeader';

type CartLine = { itemId: string; qty: number; note: string };
type DietFilter = 'all' | 'veg' | 'nonveg';

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

export function MenuApp({
  menu, table, tableToken,
}: { menu: PublicMenu; table: { table_number: number; label: string | null } | null; tableToken: string | null }) {
  const router = useRouter();
  const { restaurant: r, settings } = menu;
  const keys = storageKeys(r.slug, tableToken ?? 'none');

  const [cart, setCart] = useState<CartLine[]>([]);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [query, setQuery] = useState('');
  const [diet, setDiet] = useState<DietFilter>('all');
  const [maxSpice, setMaxSpice] = useState(3);
  const [cartOpen, setCartOpen] = useState(false);
  const [orderNote, setOrderNote] = useState('');
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore cart + session for this restaurant/table from the device.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- one-time hydration from localStorage */
    setCart(readJSON<CartLine[]>(keys.cart, []));
    setSessionToken(readJSON<string | null>(keys.session, null));
    setHydrated(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [keys.cart, keys.session]);
  useEffect(() => { if (hydrated) writeJSON(keys.cart, cart); }, [cart, hydrated, keys.cart]);

  const itemsById = useMemo(() => {
    const m = new Map<string, MenuItem>();
    for (const c of menu.categories) for (const i of c.items) m.set(i.id, i);
    return m;
  }, [menu]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return menu.categories
      .map((c) => ({
        ...c,
        items: c.items.filter((i) =>
          (diet === 'all' || (diet === 'veg') === i.is_veg)
          && i.spice_level <= maxSpice
          && (!q || i.name.toLowerCase().includes(q) || (i.description ?? '').toLowerCase().includes(q))),
      }))
      .filter((c) => c.items.length > 0);
  }, [menu, query, diet, maxSpice]);

  const qtyOf = (id: string) => cart.filter((l) => l.itemId === id).reduce((n, l) => n + l.qty, 0);
  const setQty = (id: string, qty: number) =>
    setCart((prev) => {
      if (qty <= 0) return prev.filter((l) => l.itemId !== id);
      const q = Math.min(qty, 99);
      return prev.some((l) => l.itemId === id)
        ? prev.map((l) => (l.itemId === id ? { ...l, qty: q } : l))
        : [...prev, { itemId: id, qty: q, note: '' }];
    });
  const setNote = (id: string, note: string) =>
    setCart((prev) => prev.map((l) => (l.itemId === id ? { ...l, note: note.slice(0, 500) } : l)));

  const lines = cart.filter((l) => itemsById.get(l.itemId)?.is_available);
  const count = lines.reduce((n, l) => n + l.qty, 0);
  const subtotal = lines.reduce((n, l) => n + l.qty * (itemsById.get(l.itemId)?.price_minor ?? 0), 0);
  const totals = computeTotals(subtotal, settings);
  const money = (m: number) => formatMoney(m, r.currency);

  async function placeOrder() {
    if (!tableToken || lines.length === 0) return;
    setPlacing(true);
    setError(null);
    const supabase = createClient();
    const { data, error: err } = await supabase.rpc('place_order', {
      p_slug: r.slug,
      p_qr_token: tableToken,
      p_items: lines.map((l) => ({ menu_item_id: l.itemId, quantity: l.qty, special_instructions: l.note || null })),
      p_note: orderNote || null,
      p_session_token: sessionToken,
    });
    setPlacing(false);
    if (err) {
      if (/open order/.test(err.message)) {
        setError('This table already has an open order from another phone. Please ask your waiter to help.');
      } else if (/not available/.test(err.message)) {
        setError('Something in your cart just sold out. Please check your cart and try again.');
        router.refresh();
      } else {
        setError('We couldn’t send your order. Please try again, or ask your waiter.');
      }
      return;
    }
    if (data?.session_token) writeJSON(keys.session, data.session_token);
    writeJSON(keys.cart, []);
    setCart([]);
    router.push(`/r/${r.slug}/order?t=${encodeURIComponent(tableToken)}`);
  }

  const tableLabel = table ? (table.label ?? `Table ${table.table_number}`) : null;

  return (
    <div className="pb-28">
      <BrandHeader
        restaurant={r}
        tableLabel={tableLabel}
        right={sessionToken && tableToken ? (
          <Link href={`/r/${r.slug}/order?t=${encodeURIComponent(tableToken)}`}
                className="shrink-0 rounded-lg bg-white/15 px-3 py-2 text-sm font-medium hover:bg-white/25">
            My orders
          </Link>
        ) : null}
      />

      {!tableToken ? (
        <div className="mx-auto max-w-2xl px-4 pt-3">
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            You&apos;re browsing the menu. To order, scan the QR code on your table.
          </p>
        </div>
      ) : null}

      {/* search + filters */}
      <div className="sticky top-0 z-10 border-b border-stone-100 bg-white/95 backdrop-blur">
        <div className="mx-auto max-w-2xl space-y-2 px-4 py-3">
          <input
            type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search dishes"
            aria-label="Search dishes"
            className="w-full rounded-xl border border-stone-200 bg-stone-50 px-4 py-2.5 text-base outline-none focus:border-[var(--brand)] focus:bg-white"
          />
          <div className="flex items-center gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none]">
            {([['all', 'All'], ['veg', 'Veg'], ['nonveg', 'Non-veg']] as const).map(([v, label]) => (
              <button key={v} type="button" onClick={() => setDiet(v)} aria-pressed={diet === v}
                      className={`shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium ${
                        diet === v ? 'border-[var(--brand)] bg-[var(--brand)] text-white' : 'border-stone-200 text-stone-700'}`}>
                {label}
              </button>
            ))}
            <select value={maxSpice} onChange={(e) => setMaxSpice(Number(e.target.value))} aria-label="Spice level"
                    className="shrink-0 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-sm font-medium text-stone-700">
              <option value={3}>Any spice</option>
              <option value={0}>Not spicy</option>
              <option value={1}>Up to mild</option>
              <option value={2}>Up to medium</option>
            </select>
          </div>
          {visible.length > 1 ? (
            <nav className="flex gap-4 overflow-x-auto text-sm [scrollbar-width:none]" aria-label="Categories">
              {visible.map((c) => (
                <a key={c.id} href={`#cat-${c.id}`} className="shrink-0 py-1 font-medium text-stone-500 hover:text-stone-900">{c.name}</a>
              ))}
            </nav>
          ) : null}
        </div>
      </div>

      <main className="mx-auto max-w-2xl px-4">
        {visible.length === 0 ? (
          <p className="py-16 text-center text-stone-500">
            {menu.categories.some((c) => c.items.length) ? 'No dishes match your filters.' : 'The menu is being prepared. Please check back soon.'}
          </p>
        ) : null}
        {visible.map((c) => (
          <section key={c.id} id={`cat-${c.id}`} className="scroll-mt-40 pt-6">
            <h2 className="mb-2 text-lg font-semibold">{c.name}</h2>
            <ul className="divide-y divide-stone-100">
              {c.items.map((i) => {
                const q = qtyOf(i.id);
                return (
                  <li key={i.id} className={`flex gap-3 py-4 ${i.is_available ? '' : 'opacity-50'}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <VegMark veg={i.is_veg} />
                        <Spice level={i.spice_level} />
                      </div>
                      <h3 className="mt-1 font-medium">{i.name}</h3>
                      <p className="text-sm font-medium text-stone-800">{money(i.price_minor)}</p>
                      {i.description ? <p className="mt-1 line-clamp-2 text-sm text-stone-500">{i.description}</p> : null}
                    </div>
                    <div className="flex w-28 shrink-0 flex-col items-center">
                      {i.photo_url
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={i.photo_url} alt="" loading="lazy" className="mb-[-14px] aspect-square w-28 rounded-xl object-cover" />
                        : null}
                      {!i.is_available ? (
                        <span className="relative mt-3 rounded-lg bg-stone-100 px-3 py-1.5 text-sm font-medium text-stone-500">Sold out</span>
                      ) : q === 0 ? (
                        <button type="button" onClick={() => setQty(i.id, 1)} aria-label={`Add ${i.name}`}
                                className="relative mt-3 w-24 rounded-lg border border-stone-200 bg-white py-1.5 text-sm font-semibold text-[var(--brand)] shadow-sm">
                          ADD
                        </button>
                      ) : (
                        <Stepper qty={q} onChange={(n) => setQty(i.id, n)} name={i.name} className="relative mt-3" />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </main>

      {/* cart bar */}
      {count > 0 && !cartOpen ? (
        <div className="fixed inset-x-0 bottom-0 z-20 p-3">
          <button type="button" onClick={() => setCartOpen(true)}
                  className="mx-auto flex w-full max-w-2xl items-center justify-between rounded-xl bg-[var(--brand)] px-4 py-3.5 text-white shadow-lg">
            <span className="text-sm font-medium">{count} item{count > 1 ? 's' : ''} · {money(subtotal)}</span>
            <span className="font-semibold">View cart →</span>
          </button>
        </div>
      ) : null}

      {/* cart sheet */}
      {cartOpen ? (
        <div className="fixed inset-0 z-30 flex flex-col bg-black/40" role="dialog" aria-modal="true" aria-label="Your cart">
          <button type="button" aria-label="Close cart" className="min-h-12 flex-1" onClick={() => setCartOpen(false)} />
          <div className="mx-auto flex max-h-[88dvh] w-full max-w-2xl flex-col rounded-t-2xl bg-white">
            <div className="flex items-center justify-between border-b border-stone-100 px-4 py-3">
              <h2 className="text-lg font-semibold">Your order{tableLabel ? ` · ${tableLabel}` : ''}</h2>
              <button type="button" onClick={() => setCartOpen(false)} className="rounded-lg px-2 py-1 text-stone-500 hover:bg-stone-100">Close</button>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
              {lines.length === 0 ? <p className="text-stone-500">Your cart is empty.</p> : null}
              {lines.map((l) => {
                const i = itemsById.get(l.itemId)!;
                return (
                  <div key={l.itemId} className="space-y-2">
                    <div className="flex items-start gap-3">
                      <VegMark veg={i.is_veg} />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium leading-tight">{i.name}</p>
                        <p className="text-sm text-stone-500">{money(i.price_minor)} each</p>
                      </div>
                      <Stepper qty={l.qty} onChange={(n) => setQty(l.itemId, n)} name={i.name} />
                      <p className="w-16 text-right font-medium">{money(i.price_minor * l.qty)}</p>
                    </div>
                    <div className="flex items-center gap-2 pl-7">
                      <input value={l.note} onChange={(e) => setNote(l.itemId, e.target.value)} maxLength={500}
                             placeholder="Special instructions (e.g. less spicy)" aria-label={`Instructions for ${i.name}`}
                             className="min-w-0 flex-1 rounded-lg border border-stone-200 px-3 py-1.5 text-sm outline-none focus:border-[var(--brand)]" />
                      <button type="button" onClick={() => setQty(l.itemId, 0)} className="text-sm text-stone-500 underline">Remove</button>
                    </div>
                  </div>
                );
              })}
              {lines.length ? (
                <textarea value={orderNote} onChange={(e) => setOrderNote(e.target.value.slice(0, 500))} rows={2}
                          placeholder="Note for the whole order (optional)" aria-label="Order note"
                          className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm outline-none focus:border-[var(--brand)]" />
              ) : null}
            </div>
            <div className="space-y-1 border-t border-stone-100 px-4 py-3 text-sm">
              <Row label="Items" value={money(totals.subtotal)} />
              {totals.service ? <Row label={`Service charge (${Number(settings.service_charge_percent)}%)`} value={money(totals.service)} /> : null}
              {totals.tax ? <Row label={`Tax (${Number(settings.tax_percent)}%)`} value={money(totals.tax)} /> : null}
              {settings.prices_include_tax ? <p className="text-xs text-stone-500">Prices include tax.</p> : null}
              <Row label="Total" value={money(totals.total)} strong />
              {error ? <p role="alert" className="pt-2 text-sm text-red-700">{error}</p> : null}
              <button type="button" disabled={!tableToken || !lines.length || placing} onClick={placeOrder}
                      className="mt-2 w-full rounded-xl bg-[var(--brand)] py-3.5 font-semibold text-white disabled:opacity-50">
                {placing ? 'Sending…' : tableToken ? `Place order · ${money(totals.total)}` : 'Scan your table QR to order'}
              </button>
              <p className="pt-1 text-center text-xs text-stone-500">The restaurant confirms your order before it goes to the kitchen.</p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'pt-1 text-base font-semibold' : 'text-stone-600'}`}>
      <span>{label}</span><span>{value}</span>
    </div>
  );
}

function Stepper({ qty, onChange, name, className = '' }: { qty: number; onChange: (n: number) => void; name: string; className?: string }) {
  return (
    <div className={`inline-flex w-24 items-center justify-between rounded-lg bg-[var(--brand)] text-white shadow-sm ${className}`}>
      <button type="button" onClick={() => onChange(qty - 1)} aria-label={`Remove one ${name}`} className="px-3 py-1.5 font-semibold">−</button>
      <span className="text-sm font-semibold" aria-live="polite">{qty}</span>
      <button type="button" onClick={() => onChange(qty + 1)} aria-label={`Add one ${name}`} className="px-3 py-1.5 font-semibold">+</button>
    </div>
  );
}
