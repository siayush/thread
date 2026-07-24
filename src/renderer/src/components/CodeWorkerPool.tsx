import type { ReactNode } from 'react'
import { WorkerPoolContextProvider } from '@pierre/diffs/react'
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker'

/** Single shiki theme for the whole app. The pool controls `theme` for every
 *  CodeView it serves — component-level `theme` options are ignored. */
const CODE_THEME = 'github-dark'

const poolSize = Math.max(2, Math.min(6, Math.floor((navigator.hardwareConcurrency || 4) / 2)))

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
