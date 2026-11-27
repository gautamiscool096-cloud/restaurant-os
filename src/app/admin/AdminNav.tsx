'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/admin', label: 'Restaurants' },
  { href: '/admin/plans', label: 'Plans' },
  { href: '/admin/payments', label: 'Payments' },
  { href: '/admin/activity', label: 'Activity' },
];

export function AdminNav() {
  const path = usePathname();
  return (
    <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 sm:px-6" aria-label="Admin">
      {LINKS.map((l) => {
        const active = l.href === '/admin' ? path === l.href || path.startsWith('/admin/restaurants') : path.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} aria-current={active ? 'page' : undefined}
                className={`shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium ${active ? 'border-amber-500 text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-800'}`}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
