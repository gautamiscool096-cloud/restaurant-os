import type { LiveState } from '@/lib/board';

export function LiveBadge({ live }: { live: LiveState }) {
  const map = {
    live: ['bg-emerald-500', 'Live'],
    connecting: ['bg-stone-400', 'Connecting…'],
    polling: ['bg-amber-500', 'Updating every 10 s'],
  } as const;
  const [dot, text] = map[live];
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-sm text-stone-600 ring-1 ring-stone-200" aria-live="polite">
      <span className={`size-2 rounded-full ${dot} ${live === 'live' ? 'animate-pulse' : ''}`} />
      {text}
    </span>
  );
}
