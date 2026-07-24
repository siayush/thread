/**
 * macOS-style auto-hiding scrollbars: the thumb is transparent by default
 * (styles.css) and only painted while its container carries `data-scrolling`.
 * Scroll events don't bubble, but they do capture — one window-level listener
 * covers every scroll container, including ones mounted later.
 */
const HIDE_DELAY_MS = 800

export function installAutoHideScrollbars(): void {
  const timers = new WeakMap<Element, number>()

  window.addEventListener(
    'scroll',
    (e) => {
      const el = e.target === document ? document.documentElement : (e.target as Element)
      el.setAttribute('data-scrolling', '')
      const prev = timers.get(el)
      if (prev !== undefined) clearTimeout(prev)
      timers.set(
        el,
        window.setTimeout(() => el.removeAttribute('data-scrolling'), HIDE_DELAY_MS)
      )
    },
    { capture: true, passive: true }
  )
}
