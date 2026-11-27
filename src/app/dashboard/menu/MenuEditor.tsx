'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/money';
import { friendlyError } from '@/lib/rpc-error';
import { inputClass } from '@/components/ui';

type Item = {
  id: string; category_id: string; name: string; description: string | null; price_minor: number;
  is_veg: boolean; spice_level: number; is_available: boolean; photo_url: string | null; sort_order: number;
};
type Category = { id: string; name: string; sort_order: number; items: Item[] };
type Draft = Partial<Item> & { price: string };

const SPICE = ['Not spicy', 'Mild', 'Medium', 'Hot'];

export function MenuEditor({ currency, canEdit }: { currency: string; canEdit: boolean }) {
  const [menu, setMenu] = useState<Category[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [newCat, setNewCat] = useState('');
  const [busy, setBusy] = useState(false);
  const money = (m: number) => formatMoney(m, currency);

  const load = useCallback(async () => {
    const { data, error: e } = await createClient().rpc('staff_menu_editor');
    if (e) setError(friendlyError(e, 'Could not load the menu.'));
    else setMenu(data as Category[]);
  }, []);
  useEffect(() => {
    void createClient().rpc('staff_menu_editor').then(({ data, error: e }) => {
      if (e) setError(friendlyError(e, 'Could not load the menu.'));
      else setMenu(data as Category[]);
    });
  }, []);

  async function run(fn: () => PromiseLike<{ error: { message?: string } | null }>, ok: string) {
    setBusy(true); setError(null); setNotice(null);
    const { error: e } = await fn();
    setBusy(false);
    if (e) { setError(friendlyError(e)); return false; }
    setNotice(ok);
    await load();
    return true;
  }

  const sb = () => createClient();

  async function toggle(item: Item) {
    await run(() => sb().rpc('set_menu_item_available', { p_id: item.id, p_available: !item.is_available }),
      item.is_available ? `${item.name} is now sold out.` : `${item.name} is back on the menu.`);
  }

  async function addCategory(e: React.FormEvent) {
    e.preventDefault();
    if (await run(() => sb().rpc('save_menu_category', { p_id: null, p_name: newCat }), `Added ${newCat.trim()}.`)) setNewCat('');
  }

  async function renameCategory(c: Category) {
    const name = window.prompt('New name for this section', c.name);
    if (!name || name === c.name) return;
    await run(() => sb().rpc('save_menu_category', { p_id: c.id, p_name: name }), 'Section renamed.');
  }

  async function saveDish(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const rupees = Number(editing.price);
    if (!Number.isFinite(rupees) || rupees < 0) { setError('Enter a price, like 249 or 249.50.'); return; }
    const payload = {
      id: editing.id ?? null, category_id: editing.category_id, name: editing.name ?? '',
      description: editing.description ?? '', price_minor: Math.round(rupees * 100), is_veg: editing.is_veg ?? true,
      spice_level: editing.spice_level ?? 0, is_available: editing.is_available ?? true, photo_url: editing.photo_url ?? '',
    };
    if (await run(() => sb().rpc('save_menu_item', { p_item: payload }), `Saved ${payload.name.trim()}.`)) setEditing(null);
  }

  async function deleteDish(item: Item) {
    if (!window.confirm(`Delete ${item.name}? This cannot be undone.`)) return;
    if (await run(() => sb().rpc('delete_menu_item', { p_id: item.id }), `Deleted ${item.name}.`)) setEditing(null);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Menu</h1>
        <p className="mt-1 text-stone-600">
          {canEdit ? 'Add dishes, change prices, and mark things sold out. Guests see changes straight away.'
                   : 'Mark dishes sold out when the kitchen runs out, and back on when they return.'}
        </p>
      </div>

      {error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {notice ? <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}

      {canEdit ? (
        <form onSubmit={addCategory} className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1">
            <label htmlFor="new-cat" className="block text-sm font-medium text-stone-800">New menu section</label>
            <input id="new-cat" className={inputClass} placeholder="e.g. Desserts" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
          </div>
          <button disabled={busy || !newCat.trim()} className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            Add section
          </button>
        </form>
      ) : null}

      {!menu ? <p className="py-10 text-center text-stone-500">Loading…</p> : menu.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-stone-300 p-8 text-center text-stone-500">
          Your menu is empty. Add a section like “Starters”, then add dishes to it.
        </p>
      ) : menu.map((c) => (
        <section key={c.id} aria-label={c.name} className="rounded-2xl border border-stone-200 bg-white">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 px-4 py-3">
            <h2 className="font-semibold">{c.name} <span className="text-sm font-normal text-stone-500">· {c.items.length} {c.items.length === 1 ? 'dish' : 'dishes'}</span></h2>
            {canEdit ? (
              <div className="flex gap-2">
                <button type="button" onClick={() => renameCategory(c)} className="rounded-lg px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100">Rename</button>
                <button type="button" onClick={() => setEditing({ category_id: c.id, price: '', is_veg: true, spice_level: 0, is_available: true })}
                        className="rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-600">
                  Add dish
                </button>
              </div>
            ) : null}
          </header>
          <ul className="divide-y divide-stone-100">
            {c.items.length === 0 ? <li className="px-4 py-4 text-sm text-stone-500">No dishes yet.</li> : null}
            {c.items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span aria-label={i.is_veg ? 'Vegetarian' : 'Non-vegetarian'}
                      className={`grid size-4 shrink-0 place-items-center rounded-sm border-2 ${i.is_veg ? 'border-emerald-600' : 'border-red-700'}`}>
                  <span className={`size-1.5 rounded-full ${i.is_veg ? 'bg-emerald-600' : 'bg-red-700'}`} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`font-medium ${i.is_available ? '' : 'text-stone-400 line-through'}`}>{i.name}</p>
                  <p className="text-sm text-stone-500">{money(i.price_minor)}{i.spice_level ? ` · ${SPICE[i.spice_level]}` : ''}</p>
                </div>
                <button type="button" disabled={busy} onClick={() => toggle(i)}
                        aria-label={`${i.is_available ? 'Mark sold out' : 'Back on'}: ${i.name}`}
                        className={`rounded-full px-3 py-1.5 text-sm font-medium ${i.is_available
                          ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' : 'bg-red-50 text-red-800 ring-1 ring-red-200'}`}>
                  {i.is_available ? 'Available' : 'Sold out'}
                </button>
                {canEdit ? (
                  <button type="button" onClick={() => setEditing({ ...i, price: String(i.price_minor / 100) })}
                          aria-label={`Edit ${i.name}`} className="rounded-lg px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100">
                    Edit
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {editing ? (
        <div role="dialog" aria-modal="true" aria-label={editing.id ? 'Edit dish' : 'Add dish'}
             className="fixed inset-0 z-20 grid place-items-end bg-black/40 sm:place-items-center" onClick={() => setEditing(null)}>
          <form onSubmit={saveDish} onClick={(e) => e.stopPropagation()}
                className="max-h-[92dvh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl">
            <h2 className="text-lg font-semibold">{editing.id ? 'Edit dish' : 'Add dish'}</h2>
            {error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
            <div>
              <label htmlFor="d-name" className="block text-sm font-medium">Name</label>
              <input id="d-name" required className={inputClass} value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div>
              <label htmlFor="d-desc" className="block text-sm font-medium">Description <span className="font-normal text-stone-500">(optional)</span></label>
              <textarea id="d-desc" rows={2} className={inputClass} value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="d-price" className="block text-sm font-medium">Price (₹)</label>
                <input id="d-price" required inputMode="decimal" className={inputClass} value={editing.price} onChange={(e) => setEditing({ ...editing, price: e.target.value })} />
              </div>
              <div>
                <label htmlFor="d-spice" className="block text-sm font-medium">Spice</label>
                <select id="d-spice" className={inputClass} value={editing.spice_level ?? 0} onChange={(e) => setEditing({ ...editing, spice_level: Number(e.target.value) })}>
                  {SPICE.map((s, n) => <option key={s} value={n}>{s}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label htmlFor="d-cat" className="block text-sm font-medium">Section</label>
              <select id="d-cat" className={inputClass} value={editing.category_id} onChange={(e) => setEditing({ ...editing, category_id: e.target.value })}>
                {menu?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="d-photo" className="block text-sm font-medium">Photo link <span className="font-normal text-stone-500">(optional, starts with https://)</span></label>
              <input id="d-photo" type="url" className={inputClass} value={editing.photo_url ?? ''} onChange={(e) => setEditing({ ...editing, photo_url: e.target.value })} />
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={editing.is_veg ?? true} onChange={(e) => setEditing({ ...editing, is_veg: e.target.checked })} /> Vegetarian</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={editing.is_available ?? true} onChange={(e) => setEditing({ ...editing, is_available: e.target.checked })} /> Available now</label>
            </div>
            <div className="flex flex-wrap justify-between gap-2 pt-2">
              {editing.id ? (
                <button type="button" onClick={() => deleteDish(editing as Item)} className="rounded-lg px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50">Delete dish</button>
              ) : <span />}
              <div className="flex gap-2">
                <button type="button" onClick={() => setEditing(null)} className="rounded-lg px-4 py-2 text-sm text-stone-600 hover:bg-stone-100">Cancel</button>
                <button disabled={busy} className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Save dish</button>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
