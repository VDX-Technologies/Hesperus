export function PageSkeleton({ cards = 6, blocks = 2 }: { cards?: number; blocks?: number }) {
  return (
    <div className="animate-pulse" aria-busy>
      <div className="h-3 w-24 rounded bg-steel" />
      <div className="mt-2 h-7 w-56 rounded bg-steel" />
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="card h-20" />
        ))}
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {Array.from({ length: blocks }, (_, i) => (
          <div key={i} className="card h-64" />
        ))}
      </div>
    </div>
  );
}
