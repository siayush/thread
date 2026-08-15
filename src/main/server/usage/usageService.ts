/**
 * UsageService — scans provider transcripts and returns priced usage buckets.
 *
 * The scan reads the provider CLIs' own session files rather than Thread's
 * orchestration projections, so usage covers turns driven outside Thread too
 * (the approach `ccusage` takes).
 *
 * Transcripts are append-only, so parsed records are memoised per file by
 * `(size, mtime, provider)` for the lifetime of the process; warm scans only
 * reparse files that changed.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as NodeFSP from 'node:fs/promises'

import type { UsageProviderKind, UsageSource, UsageSummary, UsageSummaryInput } from '@shared/usage'
import { UsageAggregator } from './usageAggregation'
import { parseRateTable, type RateTable } from './usagePricing'
import { listTranscriptFiles, readTranscriptRecords } from './usageTranscriptReader'
import type { UsageRecord } from './usageTranscripts'

const LITELLM_RATES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000

interface CachedFile {
  size: number
  mtimeMs: number
  provider: UsageProviderKind
  records: UsageRecord[]
}

/**
 * Drops repeats of the same `dedupeKey` within one file, keeping the first.
 * This is 99% of all duplicates; the aggregator still runs the cross-file pass.
 */
function dedupeWithinFile(records: UsageRecord[]): UsageRecord[] {
  const seen = new Set<string>()
  const kept: UsageRecord[] = []
  for (const record of records) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue
      seen.add(record.dedupeKey)
    }
    kept.push(record)
  }
  return kept
}

export class UsageService {
  readonly #ratesCachePath: string
  readonly #fileCache = new Map<string, CachedFile>()
  #rates: RateTable = new Map()
  #ratesFetchedAtMs: number | null = null
  #ratesStatus: UsageSummary['pricing']['status'] = 'unavailable'

  constructor(stateDir: string) {
    this.#ratesCachePath = join(stateDir, 'usage-model-rates.json')
  }

  /**
   * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
   * the on-disk snapshot. With neither, every model reports as unpriced rather
   * than the page failing.
   */
  async #ensureRates(): Promise<void> {
    const now = Date.now()
    if (this.#ratesFetchedAtMs !== null && now - this.#ratesFetchedAtMs < RATES_TTL_MS) return

    if (this.#ratesFetchedAtMs === null) {
      try {
        const raw = await NodeFSP.readFile(this.#ratesCachePath, 'utf8')
        const fromDisk = JSON.parse(raw) as { fetchedAtMs?: unknown; document?: unknown }
        if (typeof fromDisk.fetchedAtMs === 'number') {
          const parsed = parseRateTable(fromDisk.document)
          if (parsed.size > 0) {
            this.#rates = parsed
            this.#ratesFetchedAtMs = fromDisk.fetchedAtMs
            this.#ratesStatus = 'cached'
            if (now - fromDisk.fetchedAtMs < RATES_TTL_MS) return
          }
        }
      } catch {
        // no snapshot yet, or it is unreadable — fetch below
      }
    }

    let fetched: unknown = null
    try {
      const response = await fetch(LITELLM_RATES_URL, { signal: AbortSignal.timeout(10_000) })
      if (response.ok) fetched = await response.json()
    } catch {
      // offline is fine; we keep whatever we have
    }
    if (fetched === null) {
      // the refresh failed; whatever we are serving is now past its TTL and
      // must not keep claiming to be fresh
      if (this.#rates.size > 0) this.#ratesStatus = 'cached'
      return
    }

    const parsed = parseRateTable(fetched)
    if (parsed.size === 0) return

    this.#rates = parsed
    this.#ratesFetchedAtMs = now
    this.#ratesStatus = 'fresh'

    try {
      await NodeFSP.writeFile(this.#ratesCachePath, JSON.stringify({ fetchedAtMs: now, document: fetched }))
    } catch {
      // a snapshot we cannot write is a slower next start, not a failed read
    }
  }

  /**
   * Resolves the transcript directory for each provider. Claude Code's config
   * dir may be overridden with CLAUDE_CONFIG_DIR; Codex's home with CODEX_HOME.
   */
  #resolveTranscriptDirs(): { provider: UsageProviderKind; dir: string }[] {
    const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
    return [
      { provider: 'claude', dir: join(claudeHome, 'projects') },
      { provider: 'codex', dir: join(codexHome, 'sessions') }
    ]
  }

  /** Parses one transcript, reusing the cached result when it is unchanged. */
  async #readFileRecords(
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind
  ): Promise<UsageRecord[]> {
    const cached = this.#fileCache.get(filePath)
    // provider is part of the identity: if both providers were ever pointed at
    // one directory, a hit parsed by the other parser must not be reused
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs && cached.provider === provider) {
      return cached.records
    }

    const parsed = await readTranscriptRecords(filePath, provider)
    // a read failure is not an empty transcript: caching it under this
    // (size, mtime) would silently drop the file's usage until it changes
    if (parsed === null) return []
    const records = dedupeWithinFile(parsed)

    this.#fileCache.set(filePath, { size, mtimeMs, provider, records })
    return records
  }

  async readSummary(input: UsageSummaryInput): Promise<UsageSummary> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.sinceDay) || !/^\d{4}-\d{2}-\d{2}$/.test(input.untilDay)) {
      throw new Error(`Invalid usage window: '${input.sinceDay}' to '${input.untilDay}'`)
    }
    if (input.sinceDay > input.untilDay) {
      throw new Error(`Invalid usage window: sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`)
    }

    let hourlyWindow: { sinceTimeMs: number; untilTimeMs: number } | null = null
    if (input.resolution === 'hour') {
      const sinceTimeMs = input.sinceTime === undefined ? Number.NaN : Date.parse(input.sinceTime)
      const untilTimeMs = input.untilTime === undefined ? Number.NaN : Date.parse(input.untilTime)
      if (Number.isNaN(sinceTimeMs) || Number.isNaN(untilTimeMs)) {
        throw new Error('Hourly usage requires valid sinceTime and untilTime instants')
      }
      const durationMs = untilTimeMs - sinceTimeMs
      if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
        throw new Error('Hourly usage window must be greater than zero and at most 24 hours')
      }
      hourlyWindow = { sinceTimeMs, untilTimeMs }
    }

    const startedAtMs = Date.now()
    await this.#ensureRates()

    const windowStartMs = (hourlyWindow?.sinceTimeMs ?? Date.parse(`${input.sinceDay}T00:00:00Z`)) - MTIME_SLACK_MS

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? 'day',
      ...(hourlyWindow ?? {}),
      rates: this.#rates
    })

    const sources: UsageSource[] = []

    for (const { provider, dir } of this.#resolveTranscriptDirs()) {
      let exists = false
      try {
        exists = (await NodeFSP.stat(dir)).isDirectory()
      } catch {
        exists = false
      }

      if (!exists) {
        sources.push({ provider, path: dir, status: 'missing', scannedFiles: 0, skippedFiles: 0, distinctSessions: 0 })
        continue
      }

      const files = await listTranscriptFiles(dir, windowStartMs)
      let scannedFiles = 0
      let skippedFiles = 0
      // distinct per directory: buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead
      const sessionIds = new Set<string>()

      for (const file of files) {
        const records = await this.#readFileRecords(file.path, file.size, file.mtimeMs, provider)
        if (records.length === 0) {
          skippedFiles += 1
          continue
        }
        scannedFiles += 1
        for (const record of records) {
          // only sessions that contributed in-window count: the mtime slack
          // admits boundary files whose records fall outside the range
          if (aggregator.add(record) && record.sessionId.length > 0) {
            sessionIds.add(record.sessionId)
          }
        }
      }

      sources.push({ provider, path: dir, status: 'ok', scannedFiles, skippedFiles, distinctSessions: sessionIds.size })
    }

    const aggregated = aggregator.finish()

    return {
      readAt: new Date().toISOString(),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      sources,
      pricing: {
        status: this.#ratesStatus,
        fetchedAt: this.#ratesFetchedAtMs === null ? null : new Date(this.#ratesFetchedAtMs).toISOString(),
        knownModels: this.#rates.size
      },
      scanDurationMs: Math.max(0, Date.now() - startedAtMs)
    }
  }
}
