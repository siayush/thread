/** FNV-1a content hash — @pierre/diffs' worker pool caches rendered output by
 *  cache key, so it must change whenever the content does (length alone collides). */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}
