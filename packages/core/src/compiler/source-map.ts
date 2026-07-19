import { decode } from "@jridgewell/sourcemap-codec"
import type { JsxRange } from "./transform.ts"

/**
 * Source-to-generated mapping with explicit lengths on both sides.
 *
 * Babel's source map records POINT mappings — each segment is a single
 * (generatedLine, generatedColumn, sourceLine, sourceColumn) tuple. Volar's
 * `Mapping` records SPAN mappings with separate source/generated lengths,
 * because the two can differ: `(n) =>` compiles to `n =>` (paren strip), so
 * a 2-char source span pairs with a 1-char generated span. We compute those
 * lengths here, in the compiler, and ship them out as a typed array.
 *
 * `kind` is the semantic role of the mapped source span:
 *   - `"user"`        — normal user code, full editor features
 *   - `"h-call"`      — JSX-derived position inside an `h(...)` call's
 *                       internals, semantic highlighting suppressed so cursor
 *                       on a tag name doesn't highlight every `h` in the file
 *   - `"punctuation"` — JSX angle brackets `<` `>` `/` inside a tag span,
 *                       no semantic / completion / navigation
 *
 * Downstream consumers (`verrex/language/convertSourceMap`) translate `kind`
 * to a Volar `CodeInformation` profile.
 */
export interface CompilerMapping {
  readonly source: { readonly offset: number; readonly length: number }
  readonly generated: { readonly offset: number; readonly length: number }
  readonly kind: CompilerMappingKind
}

export type CompilerMappingKind = "user" | "h-call" | "punctuation"

/**
 * Build `CompilerMapping[]` from Babel's source map + the compiler's
 * `jsxRanges`. This is the single source of truth for source↔generated
 * position translation. Consumers should NOT re-process Babel's source map.
 *
 * Algorithm:
 *   1. Decode Babel's V3 mappings into (genOffset, srcOffset, srcChar) segments.
 *   2. Dedupe by source offset (first wins) — Babel sometimes emits multiple
 *      generated points for the same source point.
 *   3. Compute source spans by sorting segments by source offset and taking
 *      consecutive differences.
 *   4. Compute generated spans by sorting INDEPENDENTLY by generated offset
 *      and taking consecutive differences. Source and generated spans can
 *      differ because Babel transforms (paren strip, `.value` → `h.read(x)`,
 *      JSX → `h(...)`) shift byte counts.
 *   5. Classify each mapping's `kind` by intersecting its source offset
 *      against `jsxRanges` (punctuation inside tag spans, h-call inside any
 *      JSX range, otherwise user code).
 */
export function computeMappings(
  map: { mappings?: string } | null | undefined,
  source: string,
  generated: string,
  jsxRanges: ReadonlyArray<JsxRange>,
): CompilerMapping[] {
  if (!map?.mappings) {
    // No source map (e.g., JSX-free input where Babel emits trivial output) —
    // produce a single passthrough mapping covering both sides.
    const length = Math.min(source.length, generated.length)
    return [
      {
        source: { offset: 0, length },
        generated: { offset: 0, length },
        kind: "user",
      },
    ]
  }

  const decoded = decode(map.mappings)
  const sourceLineStarts = computeLineStarts(source)
  const generatedLineStarts = computeLineStarts(generated)

  // Collect segments, deduplicating by source offset (first occurrence wins).
  const segmentsBySource = new Map<
    number,
    { genOffset: number; srcOffset: number; srcChar: string }
  >()
  for (let genLine = 0; genLine < decoded.length; genLine++) {
    const segments = decoded[genLine]
    if (!segments) continue

    for (const segment of segments) {
      if (segment.length < 4) continue
      const [genCol, , srcLine, srcCol] = segment
      if (srcLine === undefined || srcCol === undefined) continue
      const genOffset = lineColToOffset(generatedLineStarts, genLine, genCol)
      const srcOffset = lineColToOffset(sourceLineStarts, srcLine, srcCol)
      const srcChar = source[srcOffset] || ""

      if (!segmentsBySource.has(srcOffset)) {
        segmentsBySource.set(srcOffset, { genOffset, srcOffset, srcChar })
      }
    }
  }

  // Sort by generated offset to compute generated spans independently —
  // Babel transforms can pair a multi-char source span with a single-char
  // generated span (paren strip), so source-order length ≠ generated-order
  // length.
  const sortedByGen = [...segmentsBySource.values()].sort(
    (a, b) => a.genOffset - b.genOffset,
  )
  const nextGenOffset = new Map<number, number>()
  for (let i = 0; i < sortedByGen.length; i++) {
    const cur = sortedByGen[i]!
    const next = sortedByGen[i + 1]
    nextGenOffset.set(cur.genOffset, next ? next.genOffset : cur.genOffset + 1)
  }

  // JSX punctuation is `<`/`>`/`/` AND falls inside an opening/closing tag
  // span — that condition keeps `{a > b}` inside a JSX expression from
  // false-positively matching the angle-bracket profile.
  const jsxPunctuation = new Set(["<", ">", "/"])
  const insideJsxNode = (srcOffset: number): boolean =>
    jsxRanges.some((r) => srcOffset >= r.start && srcOffset < r.end)
  const insideTagPunctuationSpan = (srcOffset: number): boolean =>
    jsxRanges.some((r) => {
      if (srcOffset >= r.openingTag.start && srcOffset < r.openingTag.end)
        return true
      if (
        r.closingTag &&
        srcOffset >= r.closingTag.start &&
        srcOffset < r.closingTag.end
      )
        return true
      return false
    })

  // Sort by source offset and build the final spans + kind classification.
  const sortedBySource = [...segmentsBySource.values()].sort(
    (a, b) => a.srcOffset - b.srcOffset,
  )
  const mappings: CompilerMapping[] = []
  for (let i = 0; i < sortedBySource.length; i++) {
    const seg = sortedBySource[i]!
    const nextSeg = sortedBySource[i + 1]

    const srcLength = nextSeg ? nextSeg.srcOffset - seg.srcOffset : 1
    const genLength =
      (nextGenOffset.get(seg.genOffset) ?? seg.genOffset + 1) - seg.genOffset

    let kind: CompilerMappingKind
    if (
      jsxPunctuation.has(seg.srcChar) &&
      insideTagPunctuationSpan(seg.srcOffset)
    ) {
      kind = "punctuation"
    } else if (insideJsxNode(seg.srcOffset)) {
      kind = "h-call"
    } else {
      kind = "user"
    }

    mappings.push({
      source: { offset: seg.srcOffset, length: srcLength },
      generated: { offset: seg.genOffset, length: genLength },
      kind,
    })
  }

  return mappings
}

function computeLineStarts(text: string): number[] {
  const starts: number[] = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      starts.push(i + 1)
    }
  }
  return starts
}

function lineColToOffset(
  lineStarts: number[],
  line: number,
  col: number,
): number {
  const start = lineStarts[line] ?? lineStarts[lineStarts.length - 1] ?? 0
  return start + col
}
