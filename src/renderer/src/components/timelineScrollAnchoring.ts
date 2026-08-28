/** Pure anchored-turn scroll metrics — ported from t3's timelineScrollAnchoring.ts + chatList.ts. */

export type TimelineScrollMode = 'following-end' | 'anchoring-new-turn' | 'free-scrolling'

export const CHAT_LIST_ANCHOR_OFFSET = 16

export interface ChatListAnchoredEndSpace {
  readonly anchorIndex: number
  readonly anchorOffset: number
}

export function resolveChatListAnchoredEndSpace<Item, AnchorId>(
  items: ReadonlyArray<Item>,
  anchorId: AnchorId | null,
  getAnchorId: (item: Item) => AnchorId | null
): ChatListAnchoredEndSpace | undefined {
  if (anchorId === null) return undefined

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && getAnchorId(item) === anchorId) {
      return { anchorIndex: index, anchorOffset: CHAT_LIST_ANCHOR_OFFSET }
    }
  }

  return undefined
}

export interface TimelineListMeasurementState {
  readonly data: readonly unknown[]
  readonly scroll: number
  readonly scrollLength: number
  readonly positionAtIndex: (index: number) => number | undefined
  readonly sizeAtIndex: (index: number) => number | undefined
}

export interface AnchoredTurnMetrics {
  readonly anchorTop: number
  readonly lastBottom: number
  readonly turnHeight: number
  readonly usableViewportHeight: number
  readonly visibleUsableBottom: number
  readonly overflowsUsableViewport: boolean
  readonly targetScrollToRevealEnd: number
  readonly scrollDeltaToRevealEnd: number
}

export function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index)
  const height = state.sizeAtIndex(index)
  if (typeof top !== 'number' || typeof height !== 'number' || !Number.isFinite(top) || !Number.isFinite(height)) {
    return null
  }

  return top + Math.max(1, height)
}

export function getAnchoredTurnMetrics({
  state,
  anchorIndex,
  composerOverlayHeight,
  anchorOffset
}: {
  readonly state: TimelineListMeasurementState
  readonly anchorIndex: number
  readonly composerOverlayHeight: number
  readonly anchorOffset: number
}): AnchoredTurnMetrics | null {
  if (state.data.length === 0) return null

  const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1))
  const anchorTop = state.positionAtIndex(boundedAnchorIndex)
  const lastBottom = getRowBottom(state, state.data.length - 1)
  if (typeof anchorTop !== 'number' || !Number.isFinite(anchorTop) || lastBottom === null) {
    return null
  }

  const usableViewportHeight = Math.max(0, state.scrollLength - composerOverlayHeight - anchorOffset)
  const turnHeight = Math.max(0, lastBottom - anchorTop)
  const visibleUsableBottom = state.scroll + usableViewportHeight
  const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight)
  const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll)

  return {
    anchorTop,
    lastBottom,
    turnHeight,
    usableViewportHeight,
    visibleUsableBottom,
    overflowsUsableViewport: turnHeight > usableViewportHeight,
    targetScrollToRevealEnd,
    scrollDeltaToRevealEnd
  }
}

export interface TimelineEndState {
  readonly isAtEnd?: boolean
  readonly contentLength?: number
  readonly scroll?: number
  readonly scrollLength?: number
}

/**
 * Follow re-arm band above the hard bottom. Strict on purpose: a near-end
 * check within half a viewport re-armed live-follow while the user was reading
 * history and yanked them back down on the next stream chunk.
 */
export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40

export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined, endInset = 0): boolean | undefined {
  if (!state) return undefined
  if (state.isAtEnd) return true
  const { contentLength, scroll, scrollLength } = state
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd
  }
  // contentLength includes the end inset (composer overlay), so subtract it to
  // measure the distance to the real content bottom.
  return contentLength - scroll - scrollLength - endInset <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX
}
