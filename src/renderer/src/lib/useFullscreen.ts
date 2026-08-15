import { useSyncExternalStore } from 'react'

/**
 * Live macOS-fullscreen state, pushed from the main process. Fullscreen hides
 * the traffic lights, so the fixed titlebar controls slide into the freed
 * space — the same trick t3 code's workspace controls use.
 */
let fullscreen = false
const listeners = new Set<() => void>()
let started = false

function notify(): void {
  listeners.forEach((l) => l())
}

function start(): void {
  if (started) return
  started = true
  window.native.onFullScreenChange((value) => {
    fullscreen = value
    notify()
  })
  // catch a window that launched (or reloaded) already fullscreen
  void window.native.isFullScreen().then((value) => {
    if (value !== fullscreen) {
      fullscreen = value
      notify()
    }
  })
}

export function useFullscreen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      start()
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => fullscreen
  )
}
