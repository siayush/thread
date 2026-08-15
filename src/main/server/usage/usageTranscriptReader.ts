/**
 * Raw filesystem access for transcript scanning.
 *
 * The direct `node:fs` streaming is deliberate: a cold 30-day window can be
 * gigabytes across hundreds of files, and `readline` over a read stream is
 * roughly an order of magnitude cheaper than materialising each file.
 */
import * as NodeFS from 'node:fs'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'
import * as NodeReadline from 'node:readline'

import type { UsageProviderKind } from '@shared/usage'
import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  type UsageRecord
} from './usageTranscripts'

export interface TranscriptFile {
  path: string
  size: number
  mtimeMs: number
}

/**
 * Lists `.jsonl` transcripts under `root` last modified at or after `sinceMs`.
 *
 * Errors on individual entries are swallowed: session files rotate and get
 * removed while the walk is in flight, and a partial listing is far better than
 * failing the page.
 */
export async function listTranscriptFiles(root: string, sinceMs: number): Promise<TranscriptFile[]> {
  const found: TranscriptFile[] = []

  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(child)
        continue
      }
      if (!entry.name.endsWith('.jsonl')) continue
      try {
        const stats = await NodeFSP.stat(child)
        if (stats.mtimeMs >= sinceMs) {
          found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs })
        }
      } catch {
        // vanished between readdir and stat
      }
    }
  }

  await walk(root)
  return found
}

/**
 * Streams one transcript and returns the usage records it contains, or `null`
 * when the file could not be read.
 *
 * The distinction matters to the caller's cache: a genuinely empty transcript
 * is a stable fact worth memoising, while a transient read failure memoised
 * under the same `(size, mtime)` key would silently drop that file's usage
 * until the file next changes.
 *
 * Codex carries the active model on `turn_context` lines that hold no usage of
 * their own, so those still have to pass through the reducer to keep model
 * attribution correct.
 */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind
): Promise<UsageRecord[] | null> {
  const records: UsageRecord[] = []
  const codexState = initialCodexScanState()

  try {
    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity
    })

    for await (const line of lines) {
      if (provider === 'codex') {
        if (!mightCarryUsage(line, provider) && !line.includes('"turn_context"') && !line.includes('"session_meta"')) {
          continue
        }
        const record = parseCodexLine(line, codexState)
        if (record !== null) records.push(record)
        continue
      }

      if (!mightCarryUsage(line, provider)) continue
      const record = parseClaudeLine(line)
      if (record !== null) records.push(record)
    }
  } catch {
    return null
  }

  return records
}
