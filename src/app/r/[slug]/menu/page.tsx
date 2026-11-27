import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getMenu, resolveTable } from '../data';
import { MenuApp } from './MenuApp';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ t?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const menu = await getMenu(slug);
  return { title: menu ? `${menu.restaurant.name} menu` : 'Menu' };
}

export default async function MenuPage({ params, searchParams }: Props) {
  const [{ slug }, { t }] = await Promise.all([params, searchParams]);
  const menu = await getMenu(slug);
  if (!menu) notFound();
  const table = await resolveTable(slug, t);
  return <MenuApp menu={menu} table={table} tableToken={table ? t! : null} />;
}
