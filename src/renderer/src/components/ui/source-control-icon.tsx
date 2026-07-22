import { useId } from 'react'

/**
 * VS Code's Source Control glyph: two hollow rings on a vertical trunk with a curved
 * branch to a third ring. Uses the authentic codicon geometry, recolored to a single
 * `currentColor` with a mask punching the ring holes transparent (so it themes and works
 * on any hover background). Square viewBox keeps it undistorted in `size-*` slots.
 */
export function SourceControlIcon({ className }: { className?: string }): JSX.Element {
  const id = useId()
  return (
    <svg className={className} viewBox="-9.5 4 138 138" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <mask id={id} maskUnits="userSpaceOnUse" x="-20" y="-20" width="180" height="200">
        <rect x="-20" y="-20" width="180" height="200" fill="#fff" />
        <circle cx="37" cy="34" r="10.5" fill="#000" />
        <circle cx="82" cy="49" r="10.5" fill="#000" />
        <circle cx="37" cy="112" r="10.5" fill="#000" />
      </mask>
      <g mask={`url(#${id})`} fill="currentColor" stroke="currentColor" strokeWidth={0} strokeLinecap="round">
        <line x1="37" y1="34" x2="37" y2="112" strokeWidth={14} />
        <path d="M37 96C78 96 82 74 82 49" fill="none" strokeWidth={14} />
        <circle cx="37" cy="34" r="22" />
        <circle cx="82" cy="49" r="22" />
        <circle cx="37" cy="112" r="22" />
      </g>
    </svg>
  )
}
