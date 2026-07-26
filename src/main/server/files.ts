import { opendir, readdir, realpath, stat } from 'node:fs/promises'
import type { Dir } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { DirEntry, ListDirResult } from '@shared/files'
import { ignoredPaths } from './git'

/** Sort like a file tree: folders first, then a natural, case-insensitive name order. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Past this a badge only needs to say "a lot" — counting further would walk the whole folder. */
const CHILD_COUNT_CAP = 99

/** Project-relative form the renderer keys directories by: no leading/trailing slash, `''` for the root. */
function normalizeRel(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

/**
 * Resolve a path against a project root, refusing anything that escapes it —
 * including by way of a symlink, so the check follows links instead of only
 * comparing strings. A path that doesn't exist resolves lexically; the caller's
 * own read is what reports it missing.
 */
export async function resolveInside(rootPath: string, relPath: string): Promise<string | null> {
  const root = resolve(rootPath)
  const abs = resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + sep)) return null
  try {
    const [real, realRoot] = await Promise.all([realpath(abs), realpath(root)])
    return real === realRoot || real.startsWith(realRoot + sep) ? abs : null
  } catch {
    return abs
  }
}

/** Immediate child count for the collapsed-folder badge; undefined when unreadable. */
async function childCount(abs: string): Promise<{ count: number; capped: boolean } | undefined> {
  let dir: Dir
  try {
    dir = await opendir(abs)
  } catch {
    return undefined
  }
  try {
    let count = 0
    while (await dir.read()) {
      if (++count > CHILD_COUNT_CAP) return { count: CHILD_COUNT_CAP, capped: true }
    }
    return { count, capped: false }
  } catch {
    return undefined
  } finally {
    // a `return` inside the loop leaves the handle open; closing twice is not an error worth raising
    await dir.close().catch(() => {})
  }
}

/**
 * One level of a project's working tree. Lazy on purpose: the explorer asks per
 * directory as folders open, so opening a project never walks it recursively.
 */
export async function listDir(rootPath: string, relPath: string): Promise<ListDirResult> {
  const root = resolve(rootPath)
  const rel = normalizeRel(relPath)
  const dir = await resolveInside(root, rel)
  if (!dir) return { ok: false, path: rel, entries: [], error: 'Path is outside the project folder' }

  let dirents
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    const message = code === 'ENOENT' ? 'Folder not found' : code === 'ENOTDIR' ? 'Not a folder' : code === 'EACCES' ? 'Permission denied' : null
    return { ok: false, path: rel, entries: [], error: message ?? (err instanceof Error ? err.message : String(err)) }
  }

  // .git is machinery rather than content, and nothing good comes of browsing it
  dirents = dirents.filter((d) => d.name !== '.git')

  // a symlink needs a stat to know whether it leads to a folder; broken ones read as files
  const kinds = await Promise.all(
    dirents.map(async (d): Promise<DirEntry['kind']> => {
      if (!d.isSymbolicLink()) return d.isDirectory() ? 'dir' : 'file'
      try {
        return (await stat(join(dir, d.name))).isDirectory() ? 'dir' : 'file'
      } catch {
        return 'file'
      }
    })
  )

  const paths = dirents.map((d) => (rel ? `${rel}/${d.name}` : d.name))
  const ignored = await ignoredPaths(root, paths)

  const entries: DirEntry[] = dirents.map((d, i) => ({
    name: d.name,
    path: paths[i],
    kind: kinds[i],
    ignored: ignored.has(paths[i]) || d.name.startsWith('.')
  }))

  // only count children of folders the user is meant to browse — an ignored tree
  // (node_modules) can hold thousands of folders and shows "hidden" instead of a count
  await Promise.all(
    entries.map(async (e) => {
      if (e.kind !== 'dir' || e.ignored) return
      const counted = await childCount(join(dir, e.name))
      if (!counted) return
      e.childCount = counted.count
      if (counted.capped) e.childCountCapped = true
    })
  )

  entries.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'dir' ? -1 : 1))
  return { ok: true, path: rel, entries }
}
