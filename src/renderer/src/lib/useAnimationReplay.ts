import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Replays an element's `animate-in` enter animation without remounting it.
 *
 * View swaps in this app re-animate for free because their `key` changes (see
 * ChatView's `key="chat"` / `key="diff"`). Full-screen overlays like Settings
 * are different: they stack on top, so the view underneath stays mounted and
 * its enter animation never fires again on the way back. Remounting to force it
 * would throw away scroll position and refetch, so restart the animation on the
 * existing node instead.
 *
 * Pass the flag that is `true` while the overlay covers this element; the
 * animation replays on each true→false edge.
 */
export function useAnimationReplay<T extends HTMLElement>(covered: boolean): RefObject<T> {
  const ref = useRef<T>(null)
  const wasCovered = useRef(covered)

  // layout, not passive: useEffect would let the browser paint the finished
  // state for a frame before the animation restarts, which reads as a flash
  useLayoutEffect(() => {
    const el = ref.current
    if (el && wasCovered.current && !covered) {
      // dropping animation-name cancels the animation; reading offsetWidth
      // flushes style so re-adding the class starts a fresh one rather than
      // being coalesced into a no-op
      el.classList.remove('animate-in')
      void el.offsetWidth
      el.classList.add('animate-in')
    }
    wasCovered.current = covered
  }, [covered])

  return ref
}
