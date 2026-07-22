import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import parseDiff from 'parse-diff'
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

function classify(f: parseDiff.File): DiffFile['status'] {
  if (f.new) return 'added'
  if (f.deleted) return 'deleted'
  if (f.from && f.to && f.from !== f.to) return 'renamed'
  return 'modified'
}

/** Split a full `git diff` into per-file raw patch sections (aligned with parse-diff order). */
function splitPatches(raw: string): string[] {
  const parts = raw.split(/(?=^diff --git )/m).filter((p) => p.startsWith('diff --git'))
  return parts
}

/** Parse one raw `git diff` into DiffFile[], tagging each with the given staged flag. */
function filesFromDiff(rawDiff: string, staged: boolean): DiffFile[] {
  const parsed = parseDiff(rawDiff)
  const patches = splitPatches(rawDiff)
  return parsed.map((f, i) => ({
    path: (f.to && f.to !== '/dev/null' ? f.to : f.from) ?? 'unknown',
    oldPath: f.from && f.from !== f.to ? f.from : null,
    status: classify(f),
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    patch: patches[i] ?? '',
    binary: /Binary files /.test(patches[i] ?? ''),
    staged
  }))
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

/** Raw unified diff for every untracked file, concatenated (each rendered as a new-file add). */
async function untrackedDiff(cwd: string): Promise<string> {
  const paths = splitLines(await tryGit(cwd, ['ls-files', '--others', '--exclude-standard']))
  const patches = await Promise.all(
    // --no-index exits non-zero when there IS a diff, so tryGit swallows the "error"
    paths.map((p) => tryGit(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', p]))
  )
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

/** Stage / unstage / discard a single working-tree path. `discard` is destructive. */
export async function applyFileAction(cwd: string, action: DiffAction, path: string): Promise<{ ok: boolean; error?: string }> {
  if (!isGitRepo(cwd)) return { ok: false, error: 'Not a git repository' }
  try {
    if (action === 'stage') {
      await git(cwd, ['add', '--', path])
    } else if (action === 'unstage') {
      // `restore --staged` needs a HEAD; fall back to `rm --cached` for a first-commit repo
      const restored = await tryGit(cwd, ['restore', '--staged', '--', path])
      if (restored == null) await git(cwd, ['rm', '--cached', '--', path])
    } else {
      // discard: revert tracked paths, delete untracked ones
      const untracked = splitLines(await tryGit(cwd, ['ls-files', '--others', '--exclude-standard', '--', path]))
      if (untracked.includes(path)) await rm(join(cwd, path), { force: true })
      else await git(cwd, ['restore', '--staged', '--worktree', '--', path])
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
