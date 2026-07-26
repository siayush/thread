/**
 * Types for the file-explorer dock. The tree is read straight off disk — it
 * never touches the event log, so there is no command, event, or projection
 * behind any of this.
 */

export interface DirEntry {
  name: string
  /** project-relative, forward-slashed; the project root itself is `''` */
  path: string
  kind: 'dir' | 'file'
  /** gitignored or a dot-entry — dimmed in the tree rather than hidden outright */
  ignored: boolean
  /** immediate child count for the collapsed-folder badge; omitted for files and ignored folders */
  childCount?: number
  /** the count stopped early on a very wide folder — render it as "99+" */
  childCountCapped?: boolean
}

/** result of `listDir`: one level of a project's working tree */
export interface ListDirResult {
  ok: boolean
  /** normalized project-relative path that was listed (echoes the request on failure) */
  path: string
  entries: DirEntry[]
  error?: string
}
