import { memo, useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ExpandedImagePreview } from './ExpandedImagePreview'

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview
  onClose: () => void
}

/** Full-screen image lightbox — ported from t3's ExpandedImageDialog.tsx.
 *  Deliberately a plain fixed overlay (no portal/dialog primitive): backdrop
 *  close is a transparent button beneath the content, navigation is a relative
 *  offset wrapped modulo so arrows cycle infinitely in both directions. */
export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose
}: ExpandedImageDialogProps): JSX.Element | null {
  const [imageOffset, setImageOffset] = useState(0)
  const index = (preview.index + imageOffset + preview.images.length) % preview.images.length

  const navigateImage = useCallback((direction: -1 | 1) => {
    setImageOffset((current) => current + direction)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (preview.images.length <= 1) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        event.stopPropagation()
        navigateImage(-1)
        return
      }
      if (event.key !== 'ArrowRight') return
      event.preventDefault()
      event.stopPropagation()
      navigateImage(1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigateImage, onClose, preview.images.length])

  const item = preview.images[index]
  if (!item) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
    >
      <button type="button" className="absolute inset-0 z-0 cursor-zoom-out" aria-label="Close image preview" onClick={onClose} />
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute top-1/2 left-6 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white"
          aria-label="Previous image"
          onClick={() => navigateImage(-1)}
        >
          <ChevronLeft className="size-5" />
        </Button>
      )}
      <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="absolute top-2 right-2"
          onClick={onClose}
          aria-label="Close image preview"
        >
          <X />
        </Button>
        <img
          src={item.src}
          alt={item.name}
          className="max-h-[86vh] max-w-[92vw] rounded-lg border border-border/70 bg-background object-contain shadow-2xl select-none"
          draggable={false}
        />
        <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
          {item.name}
          {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ''}
        </p>
      </div>
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute top-1/2 right-6 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white"
          aria-label="Next image"
          onClick={() => navigateImage(1)}
        >
          <ChevronRight className="size-5" />
        </Button>
      )}
    </div>
  )
})
