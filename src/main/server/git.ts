import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DiffAction, DiffFile, DiffResult, DiffScope, DiffSummary } from '@shared/diff'

const execFileP = promisify(execFile)

/** The canonical empty-tree object hash — used as the "before" when a repo has no commits. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const MAX_BUFFER = 64 * 1024 * 1024

// async so the Electron main process never blocks on a large working tree
async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER
  })
  return stdout
}

async function tryGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    return await git(cwd, args, env)
  } catch {
    return null
  }
}

/** Sync on purpose: called from the synchronous command-dispatch path (project.add). */
export function isGitRepo(cwd: string): boolean {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim() === 'true'
    )
  } catch {
    return false
  }
}

/** HEAD's tree hash, or the empty tree if the repo has no commits yet. */
async function headTree(cwd: string): Promise<string> {
  return (await tryGit(cwd, ['rev-parse', 'HEAD^{tree}']))?.trim() ?? EMPTY_TREE
}

/**
 * Snapshot the entire working tree (tracked + untracked) into a git tree object
 * WITHOUT touching the repo's real index or working tree, by using a throwaway
 * temp index. Returns the tree hash, or null if git isn't usable.
 */
export async function snapshotWorkingTree(cwd: string): Promise<string | null> {
  if (!isGitRepo(cwd)) return null
  const indexFile = join(tmpdir(), `thread-index-${randomUUID()}`)
  const env = { ...process.env, GIT_INDEX_FILE: indexFile }
  try {
    // seed from HEAD so unchanged tracked files are present, then stage everything
    await tryGit(cwd, ['read-tree', 'HEAD'], env)
    await git(cwd, ['add', '-A'], env)
    return (await git(cwd, ['write-tree'], env)).trim()
  } catch {
    return null
  } finally {
    void rm(indexFile, { force: true }).catch(() => {})
  }
}

interface Stat {
  filesChanged: number
  additions: number
  deletions: number
}

async function statBetween(cwd: string, before: string, after: string): Promise<Stat> {
  const out = (await tryGit(cwd, ['diff', '--numstat', before, after])) ?? ''
  let additions = 0
  let deletions = 0
  let filesChanged = 0
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [add, del] = line.split('\t')
    filesChanged++
    additions += add === '-' ? 0 : Number(add) || 0
    deletions += del === '-' ? 0 : Number(del) || 0
  }
  return { filesChanged, additions, deletions }
}

/** Stats for changes made during a turn (before-tree → after-tree). */
export async function turnDiffStat(cwd: string, beforeTree: string, afterTree: string): Promise<Stat> {
  return statBetween(cwd, beforeTree, afterTree)
}

/** Split a full `git diff` into per-file raw patch sections. */
function splitPatches(raw: string): string[] {
  return raw.split(/(?=^diff --git )/m).filter((p) => p.startsWith('diff --git'))
}

/** Strip git's `a/`/`b/` prefix (and optional quoting) from a `---`/`+++` path; null for /dev/null. */
function headerPath(raw: string): string | null {
  let p = raw.trim()
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1)
  if (p === '/dev/null') return null
  return p.replace(/^[ab]\//, '')
}

/**
 * Parse one per-file patch by reading its header lines and counting hunk
 * lines — the same facts `--numstat`/`--name-status` report, already in hand.
 */
function parsePatch(patch: string, staged: boolean): DiffFile {
  let from: string | null = null
  let to: string | null = null
  let status: DiffFile['status'] = 'modified'
  let binary = false
  let additions = 0
  let deletions = 0
  let inHunks = false
  for (const line of patch.split('\n')) {
    if (inHunks) {
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) deletions++
      continue
    }
    if (line.startsWith('@@')) inHunks = true
    else if (line.startsWith('new file mode')) status = 'added'
    else if (line.startsWith('deleted file mode')) status = 'deleted'
    else if (line.startsWith('rename from ')) {
      status = 'renamed'
      from = line.slice('rename from '.length)
    } else if (line.startsWith('rename to ')) to = line.slice('rename to '.length)
    else if (line.startsWith('--- ')) from ??= headerPath(line.slice(4))
    else if (line.startsWith('+++ ')) to ??= headerPath(line.slice(4))
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true
  }
  // binary / mode-only patches carry no ---/+++ lines — fall back to the diff header
  if (!from && !to) {
    const m = patch.match(/^diff --git a\/(.*) b\/(.*)$/m)
    if (m) to = m[2]
  }
  return {
    path: to ?? from ?? 'unknown',
    oldPath: status === 'renamed' ? from : null,
    status,
    additions,
    deletions,
    patch,
    binary,
    staged
  }
}

/** Parse one raw `git diff` into DiffFile[], tagging each with the given staged flag. */
function filesFromDiff(rawDiff: string, staged: boolean): DiffFile[] {
  return splitPatches(rawDiff).map((p) => parsePatch(p, staged))
}

function buildResult(scope: DiffScope, files: DiffFile[]): DiffResult {
  return {
    scope,
    isGitRepo: true,
    files,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0)
  }
}

/** Newline-split, NUL-safe list of paths git reports for `ls-files`-style output. */
function splitLines(out: string | null): string[] {
  return (out ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
}

/** `git diff --no-index` exits 1 when there IS a diff — recover the patch from the "error". */
async function noIndexDiff(cwd: string, path: string): Promise<string | null> {
  try {
    return await git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', path])
  } catch (err) {
    const out = (err as { stdout?: unknown })?.stdout
    return typeof out === 'string' && out ? out : null
  }
}

/** Raw unified diff for every untracked file, concatenated (each rendered as a new-file add). */
async function untrackedDiff(cwd: string): Promise<string> {
  const paths = splitLines(await tryGit(cwd, ['ls-files', '--others', '--exclude-standard']))
  const patches = await Promise.all(paths.map((p) => noIndexDiff(cwd, p)))
  return patches.filter(Boolean).join('\n')
}

/**
 * Working-tree diff, split VS Code-style:
 *  - staged   = index vs HEAD          (`git diff --cached`)
 *  - unstaged = working tree vs index  (`git diff`) + untracked files as adds
 * A partially-staged file correctly appears in BOTH groups.
 */
export async function workingDiff(cwd: string): Promise<DiffResult> {
  const scope: DiffScope = { kind: 'working' }
  if (!isGitRepo(cwd)) return { scope, isGitRepo: false, files: [], additions: 0, deletions: 0 }
  const head = await headTree(cwd)
  const [stagedRaw, unstagedRaw, untrackedRaw] = await Promise.all([
    tryGit(cwd, ['diff', '--no-color', '--cached', head]),
    tryGit(cwd, ['diff', '--no-color']),
    untrackedDiff(cwd)
  ])
  if (stagedRaw == null && unstagedRaw == null) {
    return { scope, isGitRepo: true, files: [], additions: 0, deletions: 0, error: 'Failed to compute diff' }
  }
  const files = [
    ...filesFromDiff(stagedRaw ?? '', true),
    ...filesFromDiff([unstagedRaw ?? '', untrackedRaw].filter(Boolean).join('\n'), false)
  ]
  return buildResult(scope, files)
}

/** Diff for a specific turn, using the stored before/after tree snapshots. */
export async function turnDiff(cwd: string, turnId: string, beforeTree: string, afterTree: string): Promise<DiffResult> {
  const scope: DiffScope = { kind: 'turn', turnId }
  if (!isGitRepo(cwd)) return { scope, isGitRepo: false, files: [], additions: 0, deletions: 0 }
  const raw = await tryGit(cwd, ['diff', '--no-color', beforeTree, afterTree])
  if (raw == null) return { scope, isGitRepo: true, files: [], additions: 0, deletions: 0, error: 'Failed to compute diff' }
  return buildResult(scope, filesFromDiff(raw, false))
}

/** Lightweight working-tree change counts for the sidebar diff pill. */
export async function workingSummary(cwd: string): Promise<DiffSummary> {
  if (!isGitRepo(cwd)) return { isGitRepo: false, files: 0, additions: 0, deletions: 0 }
  const [status, numstat, cachedNumstat] = await Promise.all([
    tryGit(cwd, ['status', '--porcelain']),
    tryGit(cwd, ['diff', '--numstat']),
    tryGit(cwd, ['diff', '--numstat', '--cached'])
  ])
  const files = splitLines(status).length
  let additions = 0
  let deletions = 0
  for (const line of `${numstat ?? ''}\n${cachedNumstat ?? ''}`.split('\n')) {
    if (!line.trim()) continue
    const [add, del] = line.split('\t')
    additions += add === '-' ? 0 : Number(add) || 0
    deletions += del === '-' ? 0 : Number(del) || 0
  }
  return { isGitRepo: true, files, additions, deletions }
}

/** Stage / unstage / discard working-tree paths in a single git invocation
 *  (one call per action even for "all files", so nothing races on the index lock).
 *  `discard` is destructive. */
export async function applyFileAction(cwd: string, action: DiffAction, paths: string[]): Promise<{ ok: boolean; error?: string }> {
  if (!isGitRepo(cwd)) return { ok: false, error: 'Not a git repository' }
  if (paths.length === 0) return { ok: true }
  try {
    if (action === 'stage') {
      await git(cwd, ['add', '--', ...paths])
    } else if (action === 'unstage') {
      // `restore --staged` needs a HEAD; fall back to `rm --cached` for a first-commit repo
      const restored = await tryGit(cwd, ['restore', '--staged', '--', ...paths])
      if (restored == null) await git(cwd, ['rm', '--cached', '-r', '--', ...paths])
    } else {
      // discard: delete untracked paths, revert tracked ones
      const untracked = new Set(splitLines(await tryGit(cwd, ['ls-files', '--others', '--exclude-standard', '--', ...paths])))
      const tracked = paths.filter((p) => !untracked.has(p))
      await Promise.all([...untracked].map((p) => rm(join(cwd, p), { force: true })))
      if (tracked.length > 0) await git(cwd, ['restore', '--staged', '--worktree', '--', ...tracked])
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
