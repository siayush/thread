/** Diff-viewer contract. */
export type DiffScope =
  | { kind: 'working' } // uncommitted working-tree changes
  | { kind: 'turn'; turnId: string } // changes made during a specific turn

export interface DiffFile {
  /** path relative to the repo/project root */
  path: string
  oldPath: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  /** raw unified-diff hunk text for this file */
  patch: string
  binary: boolean
  /** true when this change is in the index (staged), false for working-tree changes. Always false for turn scopes. */
  staged: boolean
}

export interface DiffResult {
  scope: DiffScope
  isGitRepo: boolean
  files: DiffFile[]
  additions: number
  deletions: number
  /** set when the diff couldn't be produced (not a repo, git error, …) */
  error?: string
}

/** Lightweight change counts for a project's working tree — used for the sidebar diff pill. */
export interface DiffSummary {
  isGitRepo: boolean
  files: number
  additions: number
  deletions: number
}

/** A working-tree file action requested from the diff view. */
export type DiffAction = 'stage' | 'unstage' | 'discard'
