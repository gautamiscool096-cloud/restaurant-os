'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { slugProblem } from '@/lib/slug';

export type OnboardingState = {
  error?: string;
  fieldErrors?: Partial<Record<'name' | 'slug' | 'owner_name' | 'tables' | 'logo', string>>;
} | undefined;

const HEX = /^#[0-9a-fA-F]{6}$/;
const LOGO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

export async function checkSlug(slug: string): Promise<{ ok: boolean; message?: string }> {
  const problem = slugProblem(slug);
  if (problem) return { ok: false, message: problem };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('is_slug_available', { p_slug: slug });
  if (error) return { ok: false, message: 'Could not check right now.' };
  return data ? { ok: true } : { ok: false, message: 'That address is already taken.' };
}

export async function createRestaurant(_: OnboardingState, form: FormData): Promise<OnboardingState> {
  const name = String(form.get('name') ?? '').trim();
  const slug = String(form.get('slug') ?? '').trim().toLowerCase();
  const ownerName = String(form.get('owner_name') ?? '').trim();
  const address = String(form.get('address') ?? '').trim();
  const cuisine = String(form.get('cuisine') ?? '').trim();
  const tables = Number(form.get('tables'));
  const primary = String(form.get('primary_color') ?? '#111827');
  const accent = String(form.get('accent_color') ?? '#f59e0b');
  const logo = form.get('logo');

  const fieldErrors: NonNullable<OnboardingState>['fieldErrors'] = {};
  if (!name) fieldErrors.name = 'Enter your restaurant’s name.';
  const sp = slugProblem(slug);
  if (sp) fieldErrors.slug = sp;
  if (!ownerName) fieldErrors.owner_name = 'Enter your name.';
  if (!Number.isInteger(tables) || tables < 1 || tables > 200) fieldErrors.tables = 'Enter a number from 1 to 200.';
  const hasLogo = logo instanceof File && logo.size > 0;
  if (hasLogo && !LOGO_TYPES[logo.type]) fieldErrors.logo = 'Use a PNG, JPG or WebP image.';
  if (hasLogo && logo.size > LOGO_MAX_BYTES) fieldErrors.logo = 'Keep the logo under 2 MB.';
  if (Object.keys(fieldErrors).length) return { fieldErrors };

  const supabase = await createClient();
  const { data: restaurant, error } = await supabase.rpc('create_restaurant', {
    p_name: name,
    p_slug: slug,
    p_owner_name: ownerName,
    p_address: address || null,
    p_cuisine_type: cuisine || null,
    p_logo_url: null,
    p_table_count: tables,
    p_primary_color: HEX.test(primary) ? primary : '#111827',
    p_accent_color: HEX.test(accent) ? accent : '#f59e0b',
  });

  if (error) {
    if (/already taken|restaurants_slug_key/.test(error.message)) return { fieldErrors: { slug: 'That address is already taken.' } };
    if (/not allowed/.test(error.message)) return { fieldErrors: { slug: 'That address is not allowed.' } };
    if (/already belongs/.test(error.message)) redirect('/dashboard');
    return { error: 'Something went wrong creating your restaurant. Please try again.' };
  }

  if (hasLogo) {
    // Storage RLS only allows writing inside "<this restaurant's id>/".
    const path = `${restaurant.id}/logo-${Date.now()}.${LOGO_TYPES[logo.type]}`;
    const upload = await supabase.storage.from('restaurant-assets')
      .upload(path, logo, { contentType: logo.type, upsert: false });
    if (!upload.error) {
      const { data } = supabase.storage.from('restaurant-assets').getPublicUrl(path);
      await supabase.from('restaurants').update({ logo_url: data.publicUrl }).eq('id', restaurant.id);
    } else {
      redirect('/dashboard?logo=failed');
    }
  }

  redirect('/dashboard?welcome=1');
}

export type JoinState = { error?: string } | undefined;

export async function joinWithCode(_: JoinState, form: FormData): Promise<JoinState> {
  const code = String(form.get('code') ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[0-9A-F]{4}-?[0-9A-F]{4}$/.test(code)) return { error: 'Codes look like AB12-CD34. Check the code and try again.' };
  const normalized = code.includes('-') ? code : `${code.slice(0, 4)}-${code.slice(4)}`;
  const supabase = await createClient();
  const { error } = await supabase.rpc('accept_staff_invite', { p_code: normalized });
  if (error) {
    if (/already belongs/.test(error.message)) redirect('/dashboard');
    if (/not valid|expired/.test(error.message)) return { error: 'That code is not valid or has expired. Ask your manager for a new one.' };
    return { error: 'Something went wrong. Please try again.' };
  }
  redirect('/dashboard?joined=1');
}
