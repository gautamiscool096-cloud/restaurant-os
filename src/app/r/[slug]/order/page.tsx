import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getMenu, resolveTable } from '../data';
import { OrderStatusApp } from './OrderStatusApp';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ t?: string }> };

export const metadata: Metadata = { title: 'Your order' };

export default async function OrderPage({ params, searchParams }: Props) {
  const [{ slug }, { t }] = await Promise.all([params, searchParams]);
  const menu = await getMenu(slug);
  if (!menu) notFound();
  const table = await resolveTable(slug, t);
  return <OrderStatusApp restaurant={menu.restaurant} settings={menu.settings} table={table} tableToken={table ? t! : null} />;
}
