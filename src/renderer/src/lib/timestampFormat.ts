/** Chat timestamp formatting, ported from t3's timestampFormat.ts (locale format). */

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const numericDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' })
const numericDateWithYearFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'numeric',
  day: 'numeric',
  year: 'numeric'
})
const monthNameFormatter = new Intl.DateTimeFormat(undefined, { month: 'long' })

function ordinalSuffix(day: number): string {
  const lastTwo = day % 100
  if (lastTwo >= 11 && lastTwo <= 13) return 'th'
  switch (day % 10) {
    case 1:
      return 'st'
    case 2:
      return 'nd'
    case 3:
      return 'rd'
    default:
      return 'th'
  }
}

/** Long-form tooltip label, e.g. `12:04, 4th June 2026`. */
export function formatChatTimestampTooltip(ts: number): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ''
  const time = timeFormatter.format(date)
  const day = date.getDate()
  return `${time}, ${day}${ordinalSuffix(day)} ${monthNameFormatter.format(date)} ${date.getFullYear()}`
}

/**
 * Chat timestamp that adds the date once the message is no longer from today:
 * today `12:34 PM`, yesterday `yesterday at 12:34 PM`, older `8/13 12:34 PM`,
 * with the year included once the calendar year differs. Boundaries are local
 * calendar days, not 24-hour windows.
 */
export function formatDayAwareTimestamp(ts: number, nowMs: number = Date.now()): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ''
  const time = timeFormatter.format(date)

  const now = new Date(nowMs)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfMessageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  // Round so DST-shifted 23/25 hour days still count as whole days.
  const dayDiff = Math.round((startOfToday - startOfMessageDay) / 86_400_000)

  if (dayDiff <= 0) return time
  if (dayDiff === 1) return `yesterday at ${time}`
  const dateFormatter =
    date.getFullYear() === now.getFullYear() ? numericDateFormatter : numericDateWithYearFormatter
  return `${dateFormatter.format(date)} ${time}`
}
