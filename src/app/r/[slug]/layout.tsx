import { notFound } from 'next/navigation';
import { getMenu } from './data';

export default async function RestaurantLayout({
  children, params,
}: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const menu = await getMenu(slug);
  if (!menu) notFound();
  const r = menu.restaurant;
  return (
    <div
      className="min-h-dvh bg-white"
      style={{ '--brand': r.brand_primary_color, '--accent': r.brand_accent_color } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
