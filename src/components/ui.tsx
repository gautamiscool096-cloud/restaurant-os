import Link from 'next/link';

export function Logo() {
  return (
    <Link href="/" className="inline-flex items-center gap-2 font-semibold tracking-tight text-stone-900">
      <span aria-hidden className="grid size-7 place-items-center rounded-lg bg-amber-500 text-sm text-white">R</span>
      Restaurant OS
    </Link>
  );
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-stone-200 bg-white p-6 shadow-sm ${className}`}>{children}</div>;
}

export function Field({
  label, hint, error, children, htmlFor,
}: { label: string; hint?: React.ReactNode; error?: string | null; children: React.ReactNode; htmlFor: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-stone-800">{label}</label>
      {children}
      {error ? <p className="text-sm text-red-600">{error}</p> : hint ? <p className="text-sm text-stone-500">{hint}</p> : null}
    </div>
  );
}

export const inputClass =
  'block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900 shadow-xs ' +
  'placeholder:text-stone-400 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/30 ' +
  'disabled:bg-stone-100';

export function SubmitButton({ children, pending }: { children: React.ReactNode; pending?: boolean }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex w-full items-center justify-center rounded-lg bg-stone-900 px-4 py-2.5 font-medium text-white
                 hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-amber-500/50 disabled:opacity-60"
    >
      {pending ? 'Please wait…' : children}
    </button>
  );
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'info' | 'success'; children: React.ReactNode }) {
  const tones = {
    error: 'border-red-200 bg-red-50 text-red-800',
    info: 'border-amber-200 bg-amber-50 text-amber-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  };
  return <div role="status" className={`rounded-lg border px-3 py-2 text-sm ${tones[tone]}`}>{children}</div>;
}

export function NotConfigured() {
  return (
    <Alert tone="info">
      Supabase is not connected yet. Copy <code>.env.example</code> to <code>.env.local</code> and fill in your
      project URL and publishable key.
    </Alert>
  );
}
