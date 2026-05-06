import clsx from 'clsx'
import type { StarRating } from './convictionTier'
import { renderStars, starColor } from './convictionTier'

/**
 * Compact star rating pill — rendered next to every signal's grade badge.
 * 5★ rows get a pulsing amber dot to pull the eye first.
 * See convictionTier.ts for the 5★ / 3★ / 2★ rules.
 */
export function Stars({ count, className }: { count: StarRating; className?: string }) {
  const label =
    count === 5 ? 'High conviction — A · score ≥ 8 (take this trade)' :
    count === 3 ? 'Mid conviction — A (score < 8) or B' :
                  'Low conviction — C or below / WATCH snapshot'

  return (
    <span
      title={label}
      className={clsx('inline-flex items-center gap-1 leading-none tracking-tight', className)}
    >
      {count === 5 && (
        <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full rounded-full bg-accent-amber opacity-75 animate-ping" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-accent-amber" />
        </span>
      )}
      <span className={clsx('text-[12px]', starColor(count), count === 5 && 'animate-star-glow drop-shadow-[0_0_6px_rgba(255,152,0,0.55)]')}>
        {renderStars(count)}
      </span>
    </span>
  )
}
