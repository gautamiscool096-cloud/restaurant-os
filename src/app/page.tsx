import Link from 'next/link';
import { Logo } from '@/components/ui';

const features = [
  ['QR menu, no app', 'Guests scan the code on their table, browse your menu and order from their phone.'],
  ['You approve first', 'Every order lands on your dashboard. Approve, edit or reject before the kitchen sees it.'],
  ['Kitchen and waiter screens', 'Chefs see a live queue. Waiters get pinged when food is ready.'],
  ['Your data stays yours', 'Each restaurant is sealed off. No other restaurant can ever see your menu, orders or numbers.'],
];

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <header className="flex items-center justify-between">
        <Logo />
        <nav className="flex items-center gap-3 text-sm">
          <Link href="/login" className="rounded-lg px-3 py-2 font-medium text-stone-700 hover:bg-stone-100">Log in</Link>
          <Link href="/signup" className="rounded-lg bg-stone-900 px-3 py-2 font-medium text-white hover:bg-stone-800">
            Start free trial
          </Link>
        </nav>
      </header>

      <section className="py-16 sm:py-24">
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
          Run your restaurant&apos;s orders from one screen.
        </h1>
        <p className="mt-4 max-w-xl text-lg text-stone-600">
          QR table ordering, manager approval, kitchen display and sales reports. Set up in five minutes.
          14 days free.
        </p>
        <Link href="/signup" className="mt-8 inline-flex rounded-lg bg-amber-500 px-5 py-3 font-medium text-white hover:bg-amber-600">
          Create your restaurant
        </Link>
      </section>

      <section className="grid gap-4 pb-16 sm:grid-cols-2">
        {features.map(([title, body]) => (
          <div key={title} className="rounded-2xl border border-stone-200 bg-white p-5">
            <h2 className="font-medium">{title}</h2>
            <p className="mt-1 text-sm text-stone-600">{body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
