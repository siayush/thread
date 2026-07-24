import type { ReactNode } from 'react'
import { WorkerPoolContextProvider } from '@pierre/diffs/react'
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker'

/** Single shiki theme for the whole app. The pool controls `theme` for every
 *  CodeView it serves — component-level `theme` options are ignored. */
const CODE_THEME = 'github-dark'

const poolSize = Math.max(2, Math.min(6, Math.floor((navigator.hardwareConcurrency || 4) / 2)))

/** FNV-1a content hash — @pierre/diffs' worker pool caches rendered output by
 *  cache key, so it must change whenever the content does (length alone collides). */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** Shares one shiki worker pool for syntax highlighting. */
export function CodeWorkerPool({ children }: { children: ReactNode }): JSX.Element {
  return (
    <WorkerPoolContextProvider
      poolOptions={{ workerFactory: () => new DiffsWorker(), poolSize, totalASTLRUCacheSize: 240 }}
      highlighterOptions={{ theme: CODE_THEME, tokenizeMaxLineLength: 1000, useTokenTransformer: true }}
    >
      {children}
    </WorkerPoolContextProvider>
  )
}
