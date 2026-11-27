'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { Alert, Card, Field, SubmitButton, inputClass } from '@/components/ui';
import { slugify, slugProblem } from '@/lib/slug';
import { SITE_URL } from '@/lib/env';
import { checkSlug, createRestaurant } from './actions';

const CUISINES = ['North Indian', 'South Indian', 'Chinese', 'Italian', 'Cafe', 'Street food', 'Biryani',
  'Continental', 'Bakery & desserts', 'Multi-cuisine', 'Other'];

type SlugStatus = { state: 'idle' | 'checking' | 'ok' | 'bad'; message?: string };

export function OnboardingForm() {
  const [state, action, pending] = useActionState(createRestaurant, undefined);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugStatus, setSlugStatus] = useState<SlugStatus>({ state: 'idle' });
  const [primary, setPrimary] = useState('#111827');
  const [accent, setAccent] = useState('#f59e0b');
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const reqId = useRef(0);

  const updateSlug = (value: string) => {
    setSlug(value);
    const local = value ? slugProblem(value) : null;
    setSlugStatus(!value ? { state: 'idle' } : local ? { state: 'bad', message: local } : { state: 'checking' });
  };

  // Live availability check against the database, debounced.
  useEffect(() => {
    if (!slug || slugProblem(slug)) return;
    const id = ++reqId.current;
    const timer = setTimeout(async () => {
      const res = await checkSlug(slug);
      if (id === reqId.current) setSlugStatus(res.ok ? { state: 'ok' } : { state: 'bad', message: res.message });
    }, 350);
    return () => clearTimeout(timer);
  }, [slug]);

  const fe = state?.fieldErrors ?? {};
  const slugMsg = fe.slug ?? (slugStatus.state === 'bad' ? slugStatus.message : null);
  const host = SITE_URL.replace(/^https?:\/\//, '');

  return (
    <form action={action} className="grid gap-6 lg:grid-cols-[1fr_280px]">
      <div className="space-y-6">
        {state?.error ? <Alert>{state.error}</Alert> : null}

        <Card className="space-y-4">
          <h2 className="font-medium">Basics</h2>
          <Field label="Restaurant name" htmlFor="name" error={fe.name}>
            <input id="name" name="name" required maxLength={120} className={inputClass} value={name}
                   placeholder="e.g. Spice Route"
                   onChange={(e) => {
                     setName(e.target.value);
                     if (!slugTouched) updateSlug(slugify(e.target.value));
                   }} />
          </Field>
          <Field label="Menu web address" htmlFor="slug" error={slugMsg}
                 hint={slugStatus.state === 'ok' ? '✓ Available' : slugStatus.state === 'checking' ? 'Checking…'
                   : 'This goes on your QR codes. Pick something short.'}>
            <div className="flex rounded-lg shadow-xs">
              <span className="inline-flex items-center rounded-l-lg border border-r-0 border-stone-300 bg-stone-100 px-3 text-sm text-stone-500">
                {host}/r/
              </span>
              <input id="slug" name="slug" required className={`${inputClass} rounded-l-none`} value={slug}
                     onChange={(e) => { setSlugTouched(true); updateSlug(e.target.value.toLowerCase()); }} />
            </div>
          </Field>
          <Field label="Your name" htmlFor="owner_name" error={fe.owner_name}>
            <input id="owner_name" name="owner_name" required autoComplete="name" className={inputClass} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cuisine" htmlFor="cuisine">
              <select id="cuisine" name="cuisine" className={inputClass} defaultValue="">
                <option value="">Choose…</option>
                {CUISINES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Number of tables" htmlFor="tables" error={fe.tables} hint="We'll make a QR code for each.">
              <input id="tables" name="tables" type="number" min={1} max={200} defaultValue={10} required className={inputClass} />
            </Field>
          </div>
          <Field label="Address" htmlFor="address">
            <textarea id="address" name="address" rows={2} className={inputClass} autoComplete="street-address" />
          </Field>
        </Card>

        <Card className="space-y-4">
          <h2 className="font-medium">Branding</h2>
          <Field label="Logo" htmlFor="logo" error={fe.logo} hint="PNG, JPG or WebP, up to 2 MB. Optional.">
            <input id="logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp"
                   className="block w-full text-sm text-stone-600 file:mr-3 file:rounded-lg file:border-0 file:bg-stone-100 file:px-3 file:py-2 file:font-medium hover:file:bg-stone-200"
                   onChange={(e) => {
                     const f = e.target.files?.[0];
                     setLogoPreview(f ? URL.createObjectURL(f) : null);
                   }} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Main colour" htmlFor="primary_color">
              <input id="primary_color" name="primary_color" type="color" value={primary}
                     onChange={(e) => setPrimary(e.target.value)} className="h-10 w-full cursor-pointer rounded-lg border border-stone-300" />
            </Field>
            <Field label="Accent colour" htmlFor="accent_color">
              <input id="accent_color" name="accent_color" type="color" value={accent}
                     onChange={(e) => setAccent(e.target.value)} className="h-10 w-full cursor-pointer rounded-lg border border-stone-300" />
            </Field>
          </div>
        </Card>

        <div className="lg:hidden"><SubmitButton pending={pending}>Create my restaurant</SubmitButton></div>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <p className="text-sm font-medium text-stone-500">How guests will see it</p>
        <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
          <div className="flex items-center gap-3 px-4 py-5 text-white" style={{ background: primary }}>
            {logoPreview
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={logoPreview} alt="" className="size-10 rounded-lg bg-white object-contain" />
              : <div className="grid size-10 place-items-center rounded-lg bg-white/20 font-semibold">{(name || 'R')[0]?.toUpperCase()}</div>}
            <div>
              <p className="font-semibold">{name || 'Your restaurant'}</p>
              <p className="text-xs opacity-80">Table 5</p>
            </div>
          </div>
          <div className="space-y-2 p-4">
            {['Paneer Tikka', 'Dal Makhani'].map((d) => (
              <div key={d} className="flex items-center justify-between text-sm">
                <span>{d}</span>
                <span className="rounded-md px-2 py-0.5 text-xs font-medium text-white" style={{ background: accent }}>Add</span>
              </div>
            ))}
          </div>
        </div>
        <div className="hidden lg:block"><SubmitButton pending={pending}>Create my restaurant</SubmitButton></div>
      </aside>
    </form>
  );
}
