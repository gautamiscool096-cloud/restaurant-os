import type { PublicMenu } from '@/lib/menu-types';

export function BrandHeader({
  restaurant, tableLabel, right,
}: { restaurant: PublicMenu['restaurant']; tableLabel?: string | null; right?: React.ReactNode }) {
  return (
    <header className="bg-[var(--brand)] text-white">
      <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-4">
        {restaurant.logo_url
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={restaurant.logo_url} alt="" className="size-11 shrink-0 rounded-xl bg-white object-contain p-0.5" />
          : <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-white/20 text-lg font-semibold">
              {restaurant.name[0]?.toUpperCase()}
            </div>}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold leading-tight">{restaurant.name}</h1>
          <p className="truncate text-sm opacity-80">
            {tableLabel ?? restaurant.cuisine_type ?? 'Menu'}
          </p>
        </div>
        {right}
      </div>
    </header>
  );
}

export function VegMark({ veg }: { veg: boolean }) {
  return (
    <span
      role="img"
      aria-label={veg ? 'Vegetarian' : 'Non-vegetarian'}
      title={veg ? 'Vegetarian' : 'Non-vegetarian'}
      className={`inline-grid size-4 shrink-0 place-items-center rounded-[3px] border-[1.5px] ${veg ? 'border-green-600' : 'border-red-700'}`}
    >
      <span className={`size-2 rounded-full ${veg ? 'bg-green-600' : 'bg-red-700'}`} />
    </span>
  );
}

export function Spice({ level }: { level: number }) {
  if (!level) return null;
  const label = ['', 'Mild', 'Medium', 'Hot'][level];
  return <span className="text-xs text-red-700" title={`${label} spice`} aria-label={`${label} spice`}>{'🌶'.repeat(level)}</span>;
}
