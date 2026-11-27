'use client';

export function PrintButton({ label = 'Print receipt' }: { label?: string }) {
  return (
    <button type="button" onClick={() => window.print()}
            className="rounded-lg px-4 py-2.5 font-medium ring-1 ring-stone-300 hover:bg-stone-50 print:hidden">
      {label}
    </button>
  );
}
