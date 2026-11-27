'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { StaffRole } from '@/lib/context';

const LINKS: { href: string; label: string; roles: StaffRole[] }[] = [
  { href: '/dashboard', label: 'Overview', roles: ['owner', 'manager', 'waiter', 'chef', 'cashier'] },
  { href: '/dashboard/orders', label: 'Orders', roles: ['owner', 'manager'] },
  { href: '/dashboard/floor', label: 'Floor', roles: ['owner', 'manager'] },
  { href: '/dashboard/kitchen', label: 'Kitchen', roles: ['owner', 'manager', 'chef'] },
  { href: '/dashboard/service', label: 'Service', roles: ['owner', 'manager', 'waiter'] },
  { href: '/dashboard/bills', label: 'Bills', roles: ['owner', 'manager', 'waiter', 'cashier'] },
  { href: '/dashboard/analytics', label: 'Analytics', roles: ['owner', 'manager'] },
  { href: '/dashboard/menu', label: 'Menu', roles: ['owner', 'manager', 'chef'] },
  { href: '/dashboard/tables', label: 'Tables & QR', roles: ['owner', 'manager'] },
  { href: '/dashboard/team', label: 'Team', roles: ['owner', 'manager'] },
  { href: '/dashboard/settings', label: 'Settings', roles: ['owner', 'manager'] },
];

export function DashboardNav({ role }: { role: StaffRole }) {
  const path = usePathname();
  return (
    <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 sm:px-6" aria-label="Dashboard">
      {LINKS.filter((l) => l.roles.includes(role)).map((l) => {
        const active = l.href === '/dashboard' ? path === l.href : path.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} aria-current={active ? 'page' : undefined}
                className={`shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium ${
                  active ? 'border-amber-500 text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-800'}`}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
