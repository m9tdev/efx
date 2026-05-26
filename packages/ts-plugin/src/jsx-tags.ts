import { getEfxVirtualCode } from "./virtual-code.ts"

export interface NameSpan {
  readonly start: number
  readonly length: number
}

/**
 * Given a cursor position in a `.efx` source, find the JSX tag at that position
 * and its paired partner (opening↔closing). Returns name spans only; consumers
 * highlight just the names, not the brackets.
 *
 * Backed by compiler-emitted `jsxRanges` — no source-text regex, no depth
 * counting. Babel's parser already paired the tags; we read its work.
 *
 * Cursor positions that count as "on a tag":
 *   - on the name (e.g. on `div` inside `<div>` or `</div>`)
 *   - on the opening `<` / closing `>` / self-closing `/`
 *   - NOT on attributes (e.g. inside `class="x"`)
 *
 * Fragments (`<>...</>`) have no names — skipped.
 */
export function findJsxTagPair(
  efxPath: string,
  position: number,
): { current: NameSpan; partner: NameSpan } | null {
  const vc = getEfxVirtualCode(efxPath)
  if (!vc) return null

  for (const r of vc.jsxRanges) {
    if (r.kind === "fragment") continue

    // On the opening tag?
    if (position >= r.openingTag.start && position < r.openingTag.end) {
      const onName = position >= r.openingTag.nameStart && position < r.openingTag.nameEnd
      const onLeadBracket = position < r.openingTag.nameStart // `<`
      const onTrailBracket = position >= r.openingTag.end - 1 // `>`
      const onSelfSlash = r.isSelfClosing && position === r.openingTag.end - 2 // `/`
      if (!(onName || onLeadBracket || onTrailBracket || onSelfSlash)) continue

      // Self-closing has no partner
      if (r.isSelfClosing || !r.closingTag) return null
      return {
        current: nameSpanOf(r.openingTag),
        partner: nameSpanOf(r.closingTag),
      }
    }

    // On the closing tag?
    if (r.closingTag && position >= r.closingTag.start && position < r.closingTag.end) {
      return {
        current: nameSpanOf(r.closingTag),
        partner: nameSpanOf(r.openingTag),
      }
    }
  }
  return null
}

const nameSpanOf = (t: { nameStart: number; nameEnd: number }): NameSpan => ({
  start: t.nameStart,
  length: t.nameEnd - t.nameStart,
})
