import type { Metadata } from 'next';
import { ManageRestaurant } from './ManageRestaurant';

export const metadata: Metadata = { title: 'Manage restaurant · Platform admin' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ManageRestaurant id={id} />;
}
