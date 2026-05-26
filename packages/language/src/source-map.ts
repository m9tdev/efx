import type { CodeInformation } from "@volar/language-core"
import type { Mapping } from "@volar/source-map"
import type { JsxRange } from "@efx/compiler"
import { decode } from "@jridgewell/sourcemap-codec"

/**
 * Convert Babel's source map format to Volar's Mapping format.
 * Uses compiler-provided jsxRanges to mark JSX-derived positions as non-semantic
 * (suppress inlay hints on h() internals, disable semantic on `<` `>` `/`).
 */
export function convertSourceMap(
  map: { mappings?: string } | null | undefined,
  source: string,
  generated: string,
  jsxRanges: ReadonlyArray<JsxRange>,
): Mapping<CodeInformation>[] {
  if (!map?.mappings) {
    // No source map - create a simple 1:1 mapping
    const length = Math.min(source.length, generated.length)
    return [
      {
        sourceOffsets: [0],
        generatedOffsets: [0],
        lengths: [length],
        data: {
          verification: true,
          completion: true,
          semantic: true,
          navigation: true,
          structure: true,
          format: true,
        },
      },
    ]
  }

  const decoded = decode(map.mappings)
  const sourceLineStarts = computeLineStarts(source)
  const generatedLineStarts = computeLineStarts(generated)

  const mappings: Mapping<CodeInformation>[] = []
  const fullData: CodeInformation = {
    verification: true,
    completion: true,
    semantic: true,
    navigation: true,
    structure: true,
    format: true,
  }
  // For h() internals: keep semantic but disable highlights (like Vue does)
  const noHighlightData: CodeInformation = {
    verification: true,
    completion: true,
    semantic: { shouldHighlight: () => false },
    navigation: true,
    structure: true,
    format: true,
  }
  // For JSX punctuation (< > /): these map to h() structure, disable all semantic
  const structuralOnlyData: CodeInformation = {
    verification: true,
    completion: false,
    semantic: false,
    navigation: false, // Don't navigate to h() from <
    structure: true,
    format: true,
  }

  // JSX punctuation characters (`<`, `>`, `/`) only get the structural-only profile
  // when they sit inside an opening/closing tag span — otherwise `{a > b}` inside
  // a JSX expression would false-positive on `>`.
  const jsxPunctuation = new Set(["<", ">", "/"])
  const insideJsxNode = (srcOffset: number): boolean =>
    jsxRanges.some((r) => srcOffset >= r.start && srcOffset < r.end)
  const insideTagPunctuationSpan = (srcOffset: number): boolean =>
    jsxRanges.some((r) => {
      if (srcOffset >= r.openingTag.start && srcOffset < r.openingTag.end) return true
      if (r.closingTag && srcOffset >= r.closingTag.start && srcOffset < r.closingTag.end) return true
      return false
    })

  // Collect all segments, deduplicating by source offset (keep first/best match)
  const segmentsBySource = new Map<number, { genOffset: number; srcOffset: number; srcChar: string }>()
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

      // Only keep the first mapping for each source offset
      if (!segmentsBySource.has(srcOffset)) {
        segmentsBySource.set(srcOffset, { genOffset, srcOffset, srcChar })
      }
    }
  }

  // Compute generated-side lengths by sorting independently. We track source AND
  // generated lengths because Babel's transforms can shrink spans — `(n) =>`
  // becomes `n =>` with the parens dropped, so a source mapping covering `((` (2
  // chars) lines up with generated `(` (1 char). With only source lengths, Volar
  // would think the source `((` mapping covers 2 generated chars and swallow the
  // position of `n` that follows. Inlay-hint positions, in particular, land in
  // the wrong source mapping and render at the wrong screen column.
  const sortedByGen = [...segmentsBySource.values()].sort((a, b) => a.genOffset - b.genOffset)
  const nextGenOffset = new Map<number, number>()
  for (let i = 0; i < sortedByGen.length; i++) {
    const cur = sortedByGen[i]!
    const next = sortedByGen[i + 1]
    nextGenOffset.set(cur.genOffset, next ? next.genOffset : cur.genOffset + 1)
  }

  // Sort by source offset for source-side length calculation
  const sortedSegments = [...segmentsBySource.values()].sort((a, b) => a.srcOffset - b.srcOffset)

  // Create mappings with both source and generated lengths
  for (let i = 0; i < sortedSegments.length; i++) {
    const seg = sortedSegments[i]!
    const nextSeg = sortedSegments[i + 1]

    // Length in source space: from this offset to the next (or 1 if last)
    const srcLength = nextSeg ? nextSeg.srcOffset - seg.srcOffset : 1
    // Length in generated space: from this offset to the next generated offset
    // (which may be a different sorted neighbor than the source one)
    const genLength = (nextGenOffset.get(seg.genOffset) ?? seg.genOffset + 1) - seg.genOffset

    // Position is JSX-derived if its source offset falls inside any JSX node range.
    const isInHCall = insideJsxNode(seg.srcOffset)

    // JSX punctuation (< > /) — only when actually inside a tag span, not e.g. {a > b}.
    const isJsxPunctuation =
      jsxPunctuation.has(seg.srcChar) && insideTagPunctuationSpan(seg.srcOffset)

    // Choose appropriate CodeInformation:
    // - JSX punctuation: structural only (no semantic, no navigation)
    // - Inside h() call: no highlights but keep other semantic features
    // - Normal code: full features
    let data: CodeInformation
    if (isJsxPunctuation) {
      data = structuralOnlyData
    } else if (isInHCall) {
      data = noHighlightData
    } else {
      data = fullData
    }

    mappings.push({
      sourceOffsets: [seg.srcOffset],
      generatedOffsets: [seg.genOffset],
      lengths: [srcLength],
      generatedLengths: [genLength],
      data,
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

function lineColToOffset(lineStarts: number[], line: number, col: number): number {
  const start = lineStarts[line] ?? lineStarts[lineStarts.length - 1] ?? 0
  return start + col
}
