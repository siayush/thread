import { cn } from '@/lib/utils'

interface PanelResizerProps {
  /** which edge of the window the panel is docked to */
  side: 'left' | 'right'
  width: number
  min: number
  max: number
  /** true mid-drag; suppresses the position transition so the handle tracks the cursor */
  resizing: boolean
  /** noun for the accessible name, e.g. "sidebar" */
  label: string
  setWidth: (width: number) => void
  setResizing: (resizing: boolean) => void
  /** double-click target — the panel's default width */
  onReset: () => void
}

/** How far one arrow-key press moves the edge. */
const KEY_STEP = 16

/**
 * The drag handle shared by the sidebar and the explorer dock. Fixed rather than
 * in-flow, so the overflow-hidden panel it belongs to can't clip it.
 */
export function PanelResizer({ side, width, min, max, resizing, label, setWidth, setResizing, onReset }: PanelResizerProps): JSX.Element {
  // a right-docked panel widens as the cursor moves left; a left-docked one as it moves right
  const grow = side === 'left' ? 1 : -1

  const startDrag = (e: React.PointerEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    setResizing(true)
    const prevUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    const onMove = (ev: PointerEvent): void => setWidth(startWidth + grow * (ev.clientX - startX))
    const onUp = (): void => {
      setResizing(false)
      document.body.style.userSelect = prevUserSelect
      document.body.style.cursor = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={cn(
        // no-drag: the top of the handle overlaps the title-bar drag region
        'group/resizer no-drag fixed inset-y-0 z-20 w-1.5 cursor-col-resize outline-none',
        !resizing && (side === 'left' ? 'transition-[left] duration-150 ease-out' : 'transition-[right] duration-150 ease-out')
      )}
      style={side === 'left' ? { left: width - 3 } : { right: width - 3 }}
      onPointerDown={startDrag}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        setWidth(width + grow * (e.key === 'ArrowLeft' ? -KEY_STEP : KEY_STEP))
      }}
      title="Drag to resize · double-click to reset"
    >
      <div
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-primary/60 opacity-0 transition-opacity duration-100',
          'group-hover/resizer:opacity-100 group-focus-visible/resizer:opacity-100',
          resizing && 'opacity-100'
        )}
      />
    </div>
  )
}
