import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getMenu } from '../data';
import { GuestReceipt } from './GuestReceipt';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ t?: string }> };

export const metadata: Metadata = { title: 'Receipt' };

export default async function ReceiptPage({ params, searchParams }: Props) {
  const [{ slug }, { t }] = await Promise.all([params, searchParams]);
  const menu = await getMenu(slug);
  if (!menu) notFound();
  return <GuestReceipt slug={slug} tableToken={t ?? null} />;
}
