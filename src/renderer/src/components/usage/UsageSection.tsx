import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { DailyTotals, HourlyTotals, UsageProviderKind, UsageSummary, UsageSummaryInput } from '@shared/usage'
import { summarizeUsage } from '@shared/usage'
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow
} from '@shared/usageFormat'
import { rpc } from '../../rpc/client'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { UsageChartLegend, UsageProviderChart, type UsageChartMetric } from './UsageProviderChart'
import { PROVIDER_LABEL, PROVIDER_COLOR, PROVIDER_MARK, PROVIDER_ORDER } from './usageProviders'

const WINDOW_OPTIONS = [
  { days: 1, label: 'Past 24h' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' }
] as const

/**
 * Scans take seconds cold, so answers are kept briefly per window: toggling
 * between ranges reuses a recent summary instead of rescanning.
 */
const STALE_MS = 60_000
const summaryCache = new Map<string, { at: number; summary: UsageSummary }>()

interface UsageState {
  summary: UsageSummary | null
  error: string | null
  loading: boolean
}

function useUsageSummary(window: UsageSummaryInput, generation: number): UsageState {
  // answers are keyed by request so a stale response for a previous window is
  // never shown against the current one
  const [result, setResult] = useState<{ key: string; summary: UsageSummary | null; error: string | null } | null>(null)

  const cacheKey = JSON.stringify(window)
  const requestKey = `${cacheKey}#${generation}`
  // a cached answer is served while any rescan runs; the refresh button bumps
  // `generation` to force a live scan even when the cache is fresh
  const cached = generation === 0 ? summaryCache.get(cacheKey) : undefined

  useEffect(() => {
    // staleness is judged here, not in render: a fresh hit needs no request
    const hit = summaryCache.get(cacheKey)
    if (generation === 0 && hit !== undefined && Date.now() - hit.at < STALE_MS) return

    let cancelled = false
    rpc
      .request<UsageSummary>('getUsage', window)
      .then((summary) => {
        summaryCache.set(cacheKey, { at: Date.now(), summary })
        if (!cancelled) setResult({ key: requestKey, summary, error: null })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setResult({ key: requestKey, summary: null, error: error instanceof Error ? error.message : String(error) })
        }
      })
    return () => {
      cancelled = true
    }
    // requestKey identifies the window + refresh generation; the rest derive from it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey])

  if (result !== null && result.key === requestKey) return { summary: result.summary, error: result.error, loading: false }
  if (cached !== undefined) return { summary: cached.summary, error: null, loading: false }
  return { summary: null, error: null, loading: true }
}

export function UsageSection(): JSX.Element {
  const [windowSelection, setWindowSelection] = useState(() => ({ days: 30, window: makeWindow(30) }))
  const [metric, setMetric] = useState<UsageChartMetric>('cost')
  const [breakdown, setBreakdown] = useState<'model' | 'time'>('model')
  // bumped by the refresh button to bypass the stale cache
  const [generation, setGeneration] = useState(0)
  const { days: windowDays, window } = windowSelection
  const isPast24Hours = windowDays === 1
  const { summary, error, loading } = useUsageSummary(window, generation)

  const merged = useMemo(() => (summary === null ? null : summarizeUsage(summary)), [summary])

  const days = useMemo(() => enumerateDays(window.sinceDay, window.untilDay), [window.sinceDay, window.untilDay])
  const hours = useMemo(
    () =>
      window.sinceTime === undefined || window.untilTime === undefined
        ? []
        : enumerateHourStarts(window.sinceTime, window.untilTime),
    [window.sinceTime, window.untilTime]
  )
  const recentPeriods = useMemo<(DailyTotals | HourlyTotals)[]>(
    () => (merged === null ? [] : [...(isPast24Hours ? merged.hourly : merged.daily)].reverse().slice(0, 8)),
    [isPast24Hours, merged]
  )

  // ranked by whatever the toggle is showing, so the bars always descend
  const orderedProviders = useMemo(
    () =>
      merged === null
        ? []
        : [...merged.providers].sort((a, b) => (metric === 'cost' ? b.costUsd - a.costUsd : b.totalTokens - a.totalTokens)),
    [merged, metric]
  )

  const activePeriods =
    merged === null ? 0 : (isPast24Hours ? merged.hourly : merged.daily).filter((period) => period.totalTokens > 0).length
  const periodAverage = merged === null || activePeriods === 0 ? 0 : merged.totalTokens / activePeriods
  const observedInput = merged === null ? 0 : merged.uncachedInputTokens + merged.cachedInputTokens
  const cachedShare = merged === null || observedInput === 0 ? 0 : merged.cachedInputTokens / observedInput

  const selectWindow = (days: number): void => {
    setGeneration(0)
    setWindowSelection({ days, window: makeWindow(days, undefined, days === 1 ? 'hour' : 'day') })
  }
  const refreshWindow = (): void => {
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? 'hour' : 'day')
    if (
      nextWindow.sinceDay === window.sinceDay &&
      nextWindow.untilDay === window.untilDay &&
      nextWindow.sinceTime === window.sinceTime &&
      nextWindow.untilTime === window.untilTime
    ) {
      setGeneration((g) => g + 1)
    } else {
      setGeneration(0)
      setWindowSelection({ days: windowDays, window: nextWindow })
    }
  }

  const missingSources = summary === null ? [] : summary.sources.filter((source) => source.status === 'missing')

  return (
    <div className="flex flex-col gap-8 py-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {isPast24Hours && window.sinceTime !== undefined && window.untilTime !== undefined
            ? `${formatDateTimeShort(window.sinceTime, window.timeZone)} to ${formatDateTimeShort(window.untilTime, window.timeZone)}`
            : `${formatDayShort(window.sinceDay)} to ${formatDayShort(window.untilDay)}`}
        </p>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border">
            {WINDOW_OPTIONS.map((option) => (
              <button
                key={option.days}
                type="button"
                aria-pressed={option.days === windowDays}
                onClick={() => selectWindow(option.days)}
                className={cn(
                  'relative cursor-pointer px-3 py-1.5 text-xs outline-none first:rounded-s-[5px] last:rounded-e-[5px] focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring',
                  option.days === windowDays ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" className="size-8 p-0" onClick={refreshWindow} aria-label="Refresh usage">
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>

      {error !== null ? (
        <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
          Usage could not be read: {error}
        </div>
      ) : loading || merged === null || summary === null ? (
        <UsageSkeleton resolution={isPast24Hours ? 'hour' : 'day'} />
      ) : (
        <>
          {missingSources.length > 0 && (
            <div className="flex flex-col gap-1 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
              {missingSources.map((source) => (
                <span key={source.provider}>
                  No {PROVIDER_LABEL[source.provider]} transcripts found at {source.path}.
                </span>
              ))}
            </div>
          )}

          {/* Cost first: the financial answer, then the provider split. */}
          <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
            {/* The summary follows the chart toggle, so the headline and the
                series are always reading the same units. */}
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-1">
                <span className="text-xs tracking-wide text-muted-foreground uppercase">
                  {metric === 'cost' ? 'Raw token cost' : 'Processed tokens'}
                </span>
                <span className="text-4xl font-semibold text-foreground tabular-nums">
                  {metric === 'cost' ? `${formatUsd(merged.costUsd)}*` : formatTokens(merged.totalTokens)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {metric === 'cost'
                    ? '* if billed at full API rate'
                    : `Input, cache reads and output across ${formatCount(merged.sessions)} sessions.`}
                </span>
              </div>

              {orderedProviders.map((provider) => {
                const share = metric === 'cost' ? provider.costShare : provider.tokenShare
                return (
                  <div key={provider.provider} className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between">
                      <span className="flex items-center gap-2 text-sm text-foreground">
                        <ProviderMark provider={provider.provider} className="size-4" />
                        {PROVIDER_LABEL[provider.provider]}
                      </span>
                      <span className="text-sm text-foreground tabular-nums">
                        {metric === 'cost' ? formatUsd(provider.costUsd) : formatTokens(provider.totalTokens)}
                      </span>
                    </div>
                    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full"
                        style={{
                          width: `${(share * 100).toFixed(1)}%`,
                          backgroundColor: PROVIDER_COLOR[provider.provider]
                        }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {metric === 'cost'
                        ? `${formatPercent(share)} of cost · ${formatTokens(provider.totalTokens)} tokens`
                        : `${formatPercent(share)} of tokens · ${formatUsd(provider.costUsd)}`}
                    </span>
                  </div>
                )
              })}
            </div>

            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-medium text-foreground">
                  {isPast24Hours ? 'Hourly' : 'Daily'} {metric === 'tokens' ? 'processed tokens' : 'cost'}
                </h2>
                <div className="flex items-center gap-4">
                  <div className="flex overflow-hidden rounded-md border border-border">
                    {(['cost', 'tokens'] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setMetric(option)}
                        className={cn(
                          'cursor-pointer px-2.5 py-1 text-[10px] tracking-wide uppercase',
                          option === metric ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                  <UsageChartLegend />
                </div>
              </div>
              <UsageProviderChart
                days={days}
                daily={merged.daily}
                hours={hours}
                hourly={merged.hourly}
                metric={metric}
                referenceTime={window.untilTime}
                resolution={isPast24Hours ? 'hour' : 'day'}
                timeZone={window.timeZone}
              />
            </div>
          </section>

          <section className="grid grid-cols-2 gap-px border-y border-border bg-border md:grid-cols-5">
            <Metric
              label="Processed tokens"
              value={formatTokens(merged.totalTokens)}
              detail={`${formatTokens(periodAverage)} per active ${isPast24Hours ? 'hour' : 'day'}`}
            />
            <Metric
              label="Cached input"
              value={formatTokens(merged.cachedInputTokens)}
              detail={`${formatPercent(cachedShare)} of observed input`}
            />
            <Metric
              label="Uncached input"
              value={formatTokens(merged.uncachedInputTokens)}
              detail={`${formatTokens(merged.cacheCreationTokens)} cache writes`}
            />
            <Metric
              label="Output"
              value={formatTokens(merged.outputTokens)}
              detail={`includes ${formatTokens(merged.reasoningTokens)} reasoning`}
            />
            <Metric
              label="Cache savings"
              value={formatUsd(merged.cacheSavingsUsd)}
              detail={
                merged.costUsd > 0
                  ? `${(merged.cacheSavingsUsd / merged.costUsd).toFixed(1)}x the raw token cost`
                  : 'vs full input rates'
              }
            />
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
              <div className="flex overflow-hidden rounded-md border border-border">
                {(
                  [
                    { value: 'model', label: 'model' },
                    { value: 'time', label: isPast24Hours ? 'hour' : 'day' }
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setBreakdown(option.value)}
                    className={cn(
                      'cursor-pointer px-2.5 py-1 text-[10px] tracking-wide uppercase',
                      option.value === breakdown ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {breakdown === 'model' ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 font-normal">Model</th>
                    <th className="py-2 text-right font-normal">Cost</th>
                    <th className="py-2 text-right font-normal">Share</th>
                    <th className="py-2 text-right font-normal">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {merged.models.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-muted-foreground">
                        No activity in this window.
                      </td>
                    </tr>
                  ) : (
                    merged.models.map((model) => (
                      <tr key={`${model.provider}:${model.model}`} className="border-b border-border/50">
                        <td className="py-2 text-foreground">
                          <span className="flex items-center gap-2">
                            <ProviderMark provider={model.provider} className="size-3.5" />
                            {model.model}
                          </span>
                        </td>
                        <td className="py-2 text-right text-foreground tabular-nums">{formatUsd(model.costUsd)}</td>
                        <td className="py-2 text-right text-muted-foreground tabular-nums">{formatPercent(model.costShare)}</td>
                        <td className="py-2 text-right text-muted-foreground tabular-nums">{formatTokens(model.totalTokens)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 font-normal">{isPast24Hours ? 'Hour' : 'Day'}</th>
                    {PROVIDER_ORDER.map((provider) => (
                      <th key={provider} className="py-2 text-right font-normal">
                        {PROVIDER_LABEL[provider]}
                      </th>
                    ))}
                    <th className="py-2 text-right font-normal">Total</th>
                    <th className="py-2 text-right font-normal">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {recentPeriods.length === 0 ? (
                    <tr>
                      <td colSpan={3 + PROVIDER_ORDER.length} className="py-6 text-center text-muted-foreground">
                        No activity in this window.
                      </td>
                    </tr>
                  ) : (
                    recentPeriods.map((period) => (
                      <tr key={'hourStart' in period ? period.hourStart : period.day} className="border-b border-border/50">
                        <td className="py-2 text-foreground">
                          {'hourStart' in period ? formatHourShort(period.hourStart, window.timeZone) : formatDayShort(period.day)}
                        </td>
                        {PROVIDER_ORDER.map((provider) => (
                          <td key={provider} className="py-2 text-right text-muted-foreground tabular-nums">
                            {formatUsd(period.byProvider.get(provider)?.costUsd ?? 0)}
                          </td>
                        ))}
                        <td className="py-2 text-right text-foreground tabular-nums">{formatUsd(period.costUsd)}</td>
                        <td className="py-2 text-right text-muted-foreground tabular-nums">{formatTokens(period.totalTokens)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  )
}

/** Brand mark for the provider a row belongs to. */
function ProviderMark({ provider, className }: { provider: UsageProviderKind; className: string }): JSX.Element {
  const Mark = PROVIDER_MARK[provider]
  return <Mark className={cn('shrink-0', className)} aria-hidden />
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 bg-background px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg text-foreground tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  )
}

/** Deterministic bar heights (each unique: they double as keys). */
const SKELETON_BAR_HEIGHTS = [34, 58, 41, 72, 22, 12, 49, 63, 80, 38, 55, 26, 44, 67]

/**
 * Static stand-in with the loaded page's shape: headline, provider split,
 * chart and metrics strip. No shimmer; blocks fill in exactly once when the
 * scan answers.
 */
function UsageSkeleton({ resolution }: { resolution: 'day' | 'hour' }): JSX.Element {
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <span className="text-xs tracking-wide text-muted-foreground uppercase">Raw token cost</span>
            <div className="my-1.5 h-8 w-36 rounded-sm bg-muted" />
            <div className="h-3 w-28 rounded-sm bg-muted" />
          </div>

          {PROVIDER_ORDER.map((provider) => (
            <div key={provider} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm text-foreground">
                  <ProviderMark provider={provider} className="size-4" />
                  {PROVIDER_LABEL[provider]}
                </span>
                <div className="h-3.5 w-14 rounded-sm bg-muted" />
              </div>
              <div className="h-1 w-full rounded-full bg-muted" />
              <div className="h-3 w-36 rounded-sm bg-muted" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <h2 className="py-1 text-sm font-medium text-foreground">{resolution === 'hour' ? 'Hourly' : 'Daily'} cost</h2>
          {/* Mirrors the chart's h-56 body and w-14 axis gutter to avoid a
              relayout when the real chart swaps in. */}
          <div className="flex h-56 items-end gap-1 pl-16">
            {SKELETON_BAR_HEIGHTS.map((height) => (
              <div key={height} className="flex-1 rounded-sm bg-muted" style={{ height: `${height}%` }} />
            ))}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-px border-y border-border bg-border md:grid-cols-5">
        {['Processed tokens', 'Cached input', 'Uncached input', 'Output', 'Cache savings'].map((label) => (
          <div key={label} className="flex flex-col gap-0.5 bg-background px-4 py-3">
            <span className="text-xs text-muted-foreground">{label}</span>
            <div className="my-1 h-5 w-16 rounded-sm bg-muted" />
            <div className="h-3 w-24 rounded-sm bg-muted" />
          </div>
        ))}
      </section>
    </>
  )
}
